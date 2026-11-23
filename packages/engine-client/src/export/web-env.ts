import type { MediaRef, Project } from "../model.generated";
import type { FrameDescription, MediaApi } from "../types";
import { openBlobMedia } from "./blob-media";
import { AudioMixer } from "./audio-mix";
import { CanvasCompositor } from "./compositor";
import { openMedia, type DrawableFrame, type MediaAudio, type MediaVideo, type OpenedMedia } from "./media";
import { outputFrameTimes, type ExportEnv } from "./pipeline";
import { planExport, type ExportPlan } from "./plan";
import { resolvePreset, webCodecsProbe, type CodecProbe, type ResolvedPreset } from "./presets";
import type { ExportStorage } from "./storage";
import { createWebOutput } from "./web-output";
import { ExportError, type ExportSettings } from "./types";

export interface WebEnvInput {
  jobId: string;
  project: Project;
  settings: ExportSettings;
  signal: AbortSignal;
  storage: ExportStorage;
  /** The engine's `evaluate` for the snapshotted project (a wasm `Editor` in the worker). */
  evaluate(sequence: string, ticks: number, audioSamples: number): FrameDescription;
  /** The production decoder, used for media whose file is in `settings.sources`. */
  media?: MediaApi;
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

/** Everything in the real export that needs a browser: media, canvas compositing, WebCodecs, OPFS. Fails fast (before the file exists) on anything it cannot do. */
export async function createWebEnv(input: WebEnvInput): Promise<WebEnv> {
  const { project, settings, signal } = input;
  const plan = planExport(project, settings);
  const preset = await resolvePreset(plan, settings, input.probe ?? webCodecsProbe);

  // Media: every clip's source must be readable before we start; opening them all up front turns "frame 9000 of 9000 has no decoder" into an immediate error.
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
      m = ref && blob && input.media ? await openBlobMedia(input.media, blob, plan.sampleRate, ref.name) : ref ? await openMedia(ref, plan.sampleRate) : null;
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
  const videoOf = (id: string): MediaVideo | undefined => opened.get(id)?.video;
  const audioOf = async (id: string): Promise<MediaAudio | undefined> => opened.get(id)?.audio;

  const ext = preset.container;
  const fileName = `${input.jobId}.${ext}`;
  const file = await input.storage.create(fileName);
  let output;
  try {
    output = await createWebOutput(plan, preset, file, signal, settings.creationTime);
  } catch (e) {
    await file.abort();
    dispose();
    throw e instanceof ExportError ? e : new ExportError("encode_failed", `Could not start encoding: ${e instanceof Error ? e.message : String(e)}`);
  }

  const compositor = new CanvasCompositor(plan.width, plan.height, plan.sequence.resolution.width, plan.sequence.resolution.height);
  const mixer = new AudioMixer(plan.sampleRate, audioOf);
  let mime = "";
  const env: ExportEnv<VideoFrame> = {
    plan,
    evaluate: (ticks, samples) => input.evaluate(settings.sequence, ticks, samples),
    render: async (desc, index) => {
      const drawn: Array<{ layer: (typeof desc.layers)[number]; frame: DrawableFrame }> = [];
      try {
        for (const layer of desc.layers) {
          const v = videoOf(layer.media);
          if (v) drawn.push({ layer, frame: await v.frame(layer.source_time) });
        }
        const canvas = compositor.draw(drawn);
        return new VideoFrame(canvas, outputFrameTimes(plan, index));
      } finally {
        for (const d of drawn) d.frame.close();
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
  return { env, plan, preset, fileName, path: file.path, mime: () => mime, dispose };
}
