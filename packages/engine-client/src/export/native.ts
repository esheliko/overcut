import type { Project } from "../model.generated";
import type { GpuLayer, GpuRenderer } from "../render";
import { layerOf } from "../render";
import type { FrameDescription, MediaApi } from "../types";
import { AudioMixer } from "./audio-mix";
import type { Stretcher } from "../audio-stretch";
import { runExport, type AudioPort, type ExportEnv, type VideoPort } from "./pipeline";
import { planExport, type ExportPlan } from "./plan";
import { defaultVideoBitrate } from "./presets";
import { ExportError, type ExportApi, type ExportJob, type ExportProgress, type ExportResult, type ExportSettings } from "./types";
import { openUsedMedia } from "./web-env";
import type { DrawableFrame } from "./media";

/** What the desktop shell offers for encoding (the `native_export_*` commands; `packages/engine-client/src/tauri.ts` binds them to `invoke`). */
export interface NativeExportBackend {
  begin(args: NativeBeginArgs): Promise<{ id: number; path: string; encoder: string }>;
  /** One RGBA8 frame (`width * height * 4` bytes). Resolves when the encoder has taken it. */
  video(id: number, rgba: Uint8Array): Promise<void>;
  /** Interleaved f32 PCM, 2 channels. */
  audio(id: number, pcm: Float32Array): Promise<void>;
  finish(id: number): Promise<{ frames: number; videoEncoder: string; audioSamples: number; fileBytes: number; encodeMs: number }>;
  /** Stops the encoders and deletes the partial file. Safe to call twice. */
  cancel(id: number): Promise<void>;
  read(fileName: string, offset: number, len: number): Promise<Uint8Array>;
  remove(fileName: string): Promise<void>;
}

export interface NativeBeginArgs {
  fileName: string;
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  videoBitrate: number;
  keyframeSeconds: number;
  audioRate: number;
  audioChannels: number;
  audioBitrate: number;
  hasAudio: boolean;
  preferSoftware: boolean;
  creationTime: number | null;
}

export interface NativeExportHost {
  backend: NativeExportBackend;
  /** The open project, snapshotted now. */
  project(): Promise<Project>;
  /** The engine's `evaluate` for the open project (the native editor). */
  evaluate(sequence: string, ticks: number, audioSamples: number): Promise<FrameDescription>;
  /** The native decoder (`Engine.media`). */
  media: MediaApi;
  /** The GPU compositor on the export's own canvas (the wasm renderer, as in the browser export). */
  openRenderer(canvas: OffscreenCanvas): Promise<GpuRenderer>;
  /** The pitch-keeping audio stretcher (the wasm module in the webview); only asked for when a clip's speed is not 1. */
  openStretcher?(): Promise<Stretcher>;
}

/** A composited frame as raw pixels: what the native encoder takes. */
export interface RawFrame {
  rgba: Uint8Array;
  close(): void;
}

const FILE_CHUNK = 4 * 1024 * 1024;
let counter = 0;
const newId = (): string => `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * The native encoder writes MP4 (H.264 + AAC) or WebM (VP9 + Opus), nothing else (ADR 0004). The container follows the settings: `webm` / `vp9` / `opus`
 * mean WebM, no settings mean MP4. A mixed request (WebM with H.264, MP4 with VP9) is refused up front, in the user's words.
 */
export function nativeContainer(settings: ExportSettings): "mp4" | "webm" {
  const webm = settings.container === "webm" || settings.videoCodec === "vp9" || settings.audioCodec === "opus";
  const mp4 = settings.container === "mp4" || settings.videoCodec === "h264" || settings.audioCodec === "aac";
  if (webm && mp4) throw new ExportError("unsupported", "The desktop app writes MP4 with H.264 and AAC, or WebM with VP9 and Opus; those cannot be mixed.");
  return webm ? "webm" : "mp4";
}

/** Builds the loop's environment over the native backend. Exposed for tests (fake backend, fake renderer); `createNativeExportApi` is the product entry. */
export async function createNativeEnv(
  host: NativeExportHost,
  project: Project,
  settings: ExportSettings,
  jobId: string,
): Promise<{ env: ExportEnv<RawFrame>; plan: ExportPlan; fileName: string; encoder: () => string; dispose(): void }> {
  const plan = planExport(project, settings);
  const { videoOf, audioOf, dispose: disposeMedia } = await openUsedMedia(plan, project, settings, host.media);

  const canvas = new OffscreenCanvas(plan.width, plan.height);
  let renderer: GpuRenderer;
  try {
    renderer = await host.openRenderer(canvas);
    renderer.resize(plan.width, plan.height);
  } catch (e) {
    disposeMedia();
    throw new ExportError("unsupported", `This device cannot composite video on the GPU (${e instanceof Error ? e.message : String(e)}).`);
  }
  const dispose = (): void => {
    renderer.dispose();
    disposeMedia();
  };

  const container = nativeContainer(settings);
  const fileName = `${jobId}.${container}`;
  const fps = plan.fpsNum / plan.fpsDen;
  let session: { id: number; encoder: string };
  try {
    session = await host.backend.begin({
      fileName,
      width: plan.width,
      height: plan.height,
      fpsNum: plan.fpsNum,
      fpsDen: plan.fpsDen,
      videoBitrate: settings.videoBitrate ?? defaultVideoBitrate(container === "webm" ? "vp9" : "avc", plan.width, plan.height, fps),
      keyframeSeconds: settings.keyframeIntervalSeconds ?? 2,
      audioRate: plan.sampleRate,
      audioChannels: 2,
      audioBitrate: settings.audioBitrate ?? (container === "webm" ? 128_000 : 192_000),
      hasAudio: true,
      preferSoftware: settings.hardware === "prefer-software",
      creationTime: settings.creationTime === undefined ? null : Math.floor(settings.creationTime / 1000),
    });
  } catch (e) {
    dispose();
    const msg = e instanceof Error ? e.message : String(e);
    if (/not found|not allowed|unknown command/i.test(msg)) throw new ExportError("not_yet", "This build of the desktop app cannot export yet (no native encoder). Use the web app.");
    throw new ExportError(/no H\.264 encoder|libvpx|libopus|Opus needs/.test(msg) ? "unsupported" : "encode_failed", `Could not start encoding: ${msg}`);
  }
  const { id } = session;

  // One frame or audio block in flight at a time: the next render waits for `ready`, so memory stays flat and the readback buffer is never overwritten while sending.
  let video: Promise<void> = Promise.resolve();
  let audio: Promise<void> = Promise.resolve();
  let failure: ExportError | null = null;
  const fail = (e: unknown): void => {
    failure ??= new ExportError("encode_failed", `Encoding failed: ${e instanceof Error ? e.message : String(e)}`);
  };
  const check = (): void => {
    if (failure) throw failure;
  };
  let sentFrames = 0;
  const videoPort: VideoPort<RawFrame> = {
    encode(frame) {
      check();
      const rgba = frame.rgba;
      video = video.then(() => host.backend.video(id, rgba)).catch(fail);
      sentFrames++;
    },
    ready: async () => {
      await video;
      check();
    },
    flush: async () => {
      await video;
      check();
    },
  };
  const audioPort: AudioPort = {
    encode(planar, frames) {
      check();
      const pcm = new Float32Array(frames * 2);
      for (let i = 0; i < frames; i++) {
        pcm[i * 2] = planar[i] ?? 0;
        pcm[i * 2 + 1] = planar[frames + i] ?? 0;
      }
      audio = audio.then(() => host.backend.audio(id, pcm)).catch(fail);
    },
    ready: async () => {
      await audio;
      check();
    },
    flush: async () => {
      await audio;
      check();
    },
  };

  const sped = project.sequences.some((s) => s.tracks.some((t) => t.clips.some((c) => !!c.speed && c.speed.num !== c.speed.den)));
  const mixer = new AudioMixer(plan.sampleRate, audioOf, sped ? await host.openStretcher?.() : undefined);
  const seq = plan.sequence.resolution;
  let encoderName = session.encoder;
  const env: ExportEnv<RawFrame> = {
    plan,
    evaluate: (ticks, samples) => host.evaluate(settings.sequence, ticks, samples),
    render: async (desc) => {
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
        const rgba = await renderer.readback(layers, seq, { width: plan.width, height: plan.height }, desc.background);
        return { rgba, close: () => undefined };
      } finally {
        for (const d of drawn) d.close();
      }
    },
    mix: (desc, frames, out) => mixer.mix(desc, frames, out),
    video: videoPort,
    audio: audioPort,
    finish: async () => {
      const st = await host.backend.finish(id);
      encoderName = st.videoEncoder;
      return { fileBytes: st.fileBytes };
    },
    abort: async () => {
      await host.backend.cancel(id).catch(() => undefined);
    },
    now: () => performance.now(),
    peakQueue: () => (sentFrames > 0 ? 1 : 0),
  };
  return { env, plan, fileName, encoder: () => encoderName, dispose };
}

/** `Engine.export` for the desktop shell: the same loop and progress contract as the browser, with libav encoding and the file written by Rust. */
export function createNativeExportApi(host: NativeExportHost): ExportApi {
  return {
    async start(settings) {
      nativeContainer(settings);
      const project = await host.project();
      planExport(project, settings); // fail fast, before anything opens
      const id = newId();
      const ctl = new AbortController();
      const listeners = new Set<(p: ExportProgress) => void>();
      const result = (async (): Promise<ExportResult> => {
        let web: Awaited<ReturnType<typeof createNativeEnv>> | undefined;
        try {
          web = await createNativeEnv(host, project, settings, id);
          if (ctl.signal.aborted) throw new ExportError("cancelled", "The export was cancelled.");
          const r = await runExport(web.env, ctl.signal, (p) => {
            for (const l of listeners) l(p);
          });
          const seconds = (web.plan.totalFrames * web.plan.fpsDen) / web.plan.fpsNum;
          const fileName = web.fileName;
          const webm = fileName.endsWith(".webm");
          return {
            mime: webm ? "video/webm" : "video/mp4",
            fileName,
            fileBytes: r.fileBytes,
            warnings: [],
            stats: {
              frames: r.frames,
              durationSeconds: seconds,
              fileBytes: r.fileBytes,
              encodeMs: r.encodeMs,
              speedVsRealtime: seconds / (r.encodeMs / 1000),
              peakEncodeQueue: r.peakEncodeQueue,
              codecs: `${web.encoder()} + ${webm ? "opus" : "aac"}`,
            },
            file: async () => {
              const parts: Uint8Array[] = [];
              for (let off = 0; off < r.fileBytes; off += FILE_CHUNK) parts.push(await host.backend.read(fileName, off, Math.min(FILE_CHUNK, r.fileBytes - off)));
              return new File(parts as BlobPart[], fileName, { type: webm ? "video/webm" : "video/mp4" });
            },
            remove: () => host.backend.remove(fileName),
          };
        } catch (e) {
          throw e instanceof ExportError ? e : new ExportError("encode_failed", e instanceof Error ? e.message : String(e));
        } finally {
          web?.dispose();
          listeners.clear();
        }
      })();
      void result.catch(() => undefined);
      const job: ExportJob = {
        id,
        result,
        onProgress(l) {
          listeners.add(l);
          return () => void listeners.delete(l);
        },
        cancel: () => ctl.abort(),
      };
      return job;
    },
  };
}
