import type { MediaRef, Project } from "../model.generated";
import type { FrameDescription, MediaApi } from "../types";
import { openBlobMedia } from "./blob-media";
import { AudioMixer } from "./audio-mix";
import type { Stretcher } from "../audio-stretch";
import { layerOf, renderExportFrame, type GpuLayer, type GpuRenderer } from "../render";
import { openMedia, type DrawableFrame, type MediaAudio, type MediaVideo, type OpenedMedia } from "./media";
import { outputFrameTimes, type ExportEnv } from "./pipeline";
import { planExport, type ExportPlan } from "./plan";
import { describeAudioConfig, describeVideoConfig, resolvePreset, webCodecsProbe, type CodecProbe, type ResolvedPreset } from "./presets";
import type { ExportStorage } from "./storage";
import { createWebOutput } from "./web-output";
import { ExportError, type ExportSettings } from "./types";

/**
 * How the composited frame reaches the encoder: `canvas` (a VideoFrame of the compositor's canvas: no readback, and a hardware encoder can take it from
 * the GPU; the default since M2 W7) or `readback` (GPU -> RGBA bytes -> VideoFrame: byte-deterministic, independent of the canvas; the fallback when
 * a canvas frame cannot be made, and what the determinism tests pin). docs/features/export.md.
 */
const DEFAULT_CAPTURE: "readback" | "canvas" = "canvas";

export interface WebEnvInput {
  jobId: string;
  project: Project;
  settings: ExportSettings;
  signal: AbortSignal;
  storage: ExportStorage;
  /** The engine's `evaluate` for the snapshotted project (a wasm `Editor` in the worker). */
  evaluate(sequence: string, ticks: number, audioSamples: number): FrameDescription;
  /** Pitch-keeping audio stretch for clips whose speed is not 1 (the wasm module in the worker). */
  stretch?: Stretcher;
  /** The production decoder, used for media whose file is in `settings.sources`. */
  media?: MediaApi;
  /** Creates the GPU compositor (the same Rust one the preview uses) on the export's own canvas. */
  openRenderer(canvas: OffscreenCanvas): Promise<GpuRenderer>;
  probe?: CodecProbe;
  /** Called as each step of the start-up begins (`ExportFailureDetail.stage`), so a crash can say where it happened. */
  onStage?(stage: string, info?: { video?: string; audio?: string }): void;
}

export interface WebEnv {
  env: ExportEnv<VideoFrame>;
  plan: ExportPlan;
  preset: ResolvedPreset;
  fileName: string;
  path: string;
  /** Known after `env.finish()`. */
  mime(): string;
  /** The capture mode the frames actually used (a failed `canvas` capture switches to `readback`). */
  capture(): "readback" | "canvas";
  /** Releases decoders; call once the job is over, success or not. */
  dispose(): void;
}

/** Media a plan uses, opened up front. */
export interface UsedMedia {
  videoOf(id: string): MediaVideo | undefined;
  audioOf(id: string): Promise<MediaAudio | undefined>;
  /** Releases every decoder; call once the job is over, success or not. */
  dispose(): void;
}

/**
 * Every clip's source must be readable before the file exists: opening them all up front turns "frame 9000 of 9000 has no decoder" into an
 * immediate `media_unavailable`. Shared by the browser export and the native one (`native.ts`).
 */
export async function openUsedMedia(plan: ExportPlan, project: Project, settings: ExportSettings, media: MediaApi | undefined): Promise<UsedMedia> {
  const refs = new Map<string, MediaRef>(project.media.map((m) => [m.id, m]));
  const opened = new Map<string, OpenedMedia>();
  const dispose = (): void => {
    for (const m of opened.values()) {
      m.video?.close();
      m.audio?.close();
    }
  };
  const used = new Set<string>();
  for (const t of plan.sequence.tracks) for (const c of t.clips) used.add(c.media);
  for (const id of used) {
    const ref = refs.get(id);
    const blob = settings.sources?.[id];
    let m: OpenedMedia | null;
    try {
      m = ref && blob && media ? await openBlobMedia(media, blob, plan.sampleRate, ref.name) : ref ? await openMedia(ref, plan.sampleRate) : null;
    } catch (err) {
      dispose();
      const gone = err instanceof DOMException && ["NotFoundError", "NotReadableError", "SecurityError"].includes(err.name);
      const message = err instanceof Error ? err.message : String(err);
      const kind = err instanceof Error ? `${err.name}${"kind" in err ? `(${String(err.kind)})` : ""}` : "Error";
      throw new ExportError(gone ? "media_unavailable" : "media_failed", `"${ref?.name ?? id}" cannot be opened: ${message}`, { name: kind, message, clip: ref?.name ?? id, at: `opening the file (${blob?.size ?? "?"} bytes)`, stack: err instanceof Error ? err.stack?.slice(0, 1500) : undefined });
    }
    if (!m) {
      dispose();
      throw new ExportError("media_unavailable", `"${ref?.name ?? id}" cannot be read for export yet.`);
    }
    opened.set(id, m);
  }
  return { videoOf: (id) => opened.get(id)?.video, audioOf: async (id) => opened.get(id)?.audio, dispose };
}

/** Everything in the real export that needs a browser: media, canvas compositing, WebCodecs, OPFS. Fails fast (before the file exists) on anything it cannot do. */
export async function createWebEnv(input: WebEnvInput): Promise<WebEnv> {
  const { project, settings, signal } = input;
  const stage = input.onStage ?? (() => undefined);
  const plan = planExport(project, settings);
  stage("preset");
  const preset = await resolvePreset(plan, settings, input.probe ?? webCodecsProbe);
  const configs = { video: describeVideoConfig(preset.video), audio: describeAudioConfig(preset.audio) };

  stage("media", configs);
  const { videoOf, audioOf, dispose } = await openUsedMedia(plan, project, settings, input.media);

  // The compositor is opened before the file exists, so "no GPU" fails at 0% with a plain message.
  stage("renderer");
  const canvas = new OffscreenCanvas(plan.width, plan.height);
  let renderer: GpuRenderer;
  try {
    renderer = await input.openRenderer(canvas);
    renderer.resize(plan.width, plan.height);
  } catch (e) {
    dispose();
    throw new ExportError("unsupported", `This device cannot composite video on the GPU (${e instanceof Error ? e.message : String(e)}).`);
  }
  const closeAll = (): void => {
    renderer.dispose();
    dispose();
  };
  const seq = plan.sequence.resolution;
  let capture = settings.capture ?? DEFAULT_CAPTURE;
  const spent = { decode: 0, composite: 0 };

  const ext = preset.container;
  const fileName = `${input.jobId}.${ext}`;
  stage("file");
  const file = await input.storage.create(fileName);
  stage("encoders");
  let output;
  try {
    output = await createWebOutput(plan, preset, file, signal, settings.creationTime);
  } catch (e) {
    await file.abort();
    closeAll();
    throw e instanceof ExportError ? e : new ExportError("encode_failed", `Could not start encoding: ${e instanceof Error ? e.message : String(e)}`);
  }
  stage("encoding");

  const mixer = new AudioMixer(plan.sampleRate, audioOf, input.stretch);
  let mime = "";
  const env: ExportEnv<VideoFrame> = {
    plan,
    evaluate: (ticks, samples) => input.evaluate(settings.sequence, ticks, samples),
    render: async (desc, index) => {
      const drawn: DrawableFrame[] = [];
      try {
        const layers: GpuLayer[] = [];
        for (const layer of desc.layers) {
          const v = videoOf(layer.media);
          if (!v) continue;
          const t = performance.now();
          const frame = await v.frame(layer.source_time);
          spent.decode += performance.now() - t;
          drawn.push(frame);
          layers.push(layerOf(layer, frame, seq));
        }
        const t = performance.now();
        const times = outputFrameTimes(plan, index);
        try {
          return await renderExportFrame(renderer, canvas, capture, layers, seq, times, desc.background);
        } catch (e) {
          if (capture !== "canvas") throw e;
          capture = "readback"; // this browser cannot snapshot the canvas as a VideoFrame: the readback route always works
          return await renderExportFrame(renderer, canvas, capture, layers, seq, times, desc.background);
        } finally {
          spent.composite += performance.now() - t;
        }
      } finally {
        for (const d of drawn) d.close();
      }
    },
    mix: (desc, frames, out) => mixer.mix(desc, frames, out),
    video: output.video,
    audio: output.audio,
    finish: async () => {
      const r = await output.finish();
      mime = r.mime;
      return { fileBytes: r.fileBytes };
    },
    abort: () => output.abort(),
    now: () => performance.now(),
    peakQueue: () => output.peakQueue(),
    timing: () => ({ decode: spent.decode, composite: spent.composite }),
  };
  return { env, plan, preset, fileName, path: file.path, mime: () => mime, capture: () => capture, dispose: closeAll };
}
