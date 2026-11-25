import type { MediaRef, Project } from "../model.generated";
import type { FrameDescription, MediaApi } from "../types";
import { openBlobMedia } from "./blob-media";
import { AudioMixer } from "./audio-mix";
import type { Stretcher } from "../audio-stretch";
import { layerOf, renderExportFrame, type GpuLayer, type GpuRenderer } from "../render";
import { openMedia, type DrawableFrame, type MediaAudio, type MediaVideo, type OpenedMedia } from "./media";
import { outputFrameTimes, type ExportEnv } from "./pipeline";
import { planExport, type ExportPlan } from "./plan";
import { resolvePreset, webCodecsProbe, type CodecProbe, type ResolvedPreset } from "./presets";
import type { ExportStorage } from "./storage";
import { createWebOutput } from "./web-output";
import { ExportError, type ExportSettings } from "./types";

/** How the composited frame reaches the encoder: `readback` (GPU -> RGBA bytes -> VideoFrame, deterministic, measured faster in headless Chromium: docs/features/export.md) or `canvas` (VideoFrame of the canvas). */
const DEFAULT_CAPTURE: "readback" | "canvas" = "readback";

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
}

export interface WebEnv {
  env: ExportEnv<VideoFrame>;
  plan: ExportPlan;
  preset: ResolvedPreset;
  fileName: string;
  path: string;
  /** Known after `env.finish()`. */
  mime(): string;
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
      throw new ExportError("media_unavailable", `"${ref?.name ?? id}" cannot be read: ${err instanceof Error ? err.message : String(err)}`);
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
  const plan = planExport(project, settings);
  const preset = await resolvePreset(plan, settings, input.probe ?? webCodecsProbe);

  const { videoOf, audioOf, dispose } = await openUsedMedia(plan, project, settings, input.media);

  // The compositor is opened before the file exists, so "no GPU" fails at 0% with a plain message.
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
  const capture = settings.capture ?? DEFAULT_CAPTURE;

  const ext = preset.container;
  const fileName = `${input.jobId}.${ext}`;
  const file = await input.storage.create(fileName);
  let output;
  try {
    output = await createWebOutput(plan, preset, file, signal, settings.creationTime);
  } catch (e) {
    await file.abort();
    closeAll();
    throw e instanceof ExportError ? e : new ExportError("encode_failed", `Could not start encoding: ${e instanceof Error ? e.message : String(e)}`);
  }

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
          const frame = await v.frame(layer.source_time);
          drawn.push(frame);
          layers.push(layerOf(layer, frame, seq));
        }
        return await renderExportFrame(renderer, canvas, capture, layers, seq, outputFrameTimes(plan, index));
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
  };
  return { env, plan, preset, fileName, path: file.path, mime: () => mime, dispose: closeAll };
}
