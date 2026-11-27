import type { FrameDescription } from "../types";
import { frameMicros, frameTicks, sampleMicros, sampleTicks, type ExportPlan } from "./plan";
import { ExportError, type ExportProgress } from "./types";

/** Samples handed to the audio encoder at a time (about 43 ms at 48 kHz: shorter than one video frame at 24 fps). */
export const AUDIO_BLOCK = 2048;

/** Where encoded video goes. The real one wraps `VideoEncoder` + the muxer; tests use a recording fake. */
export interface VideoPort<F extends { close(): void }> {
  /** Takes ownership of nothing: the pipeline closes `frame` right after. */
  encode(frame: F, keyFrame: boolean): void;
  /** Resolves when the encoder and muxer can take more (encode queue small, muxer writes caught up). Rejects on an encoder error. */
  ready(): Promise<void>;
  flush(): Promise<void>;
}

export interface AudioPort {
  /** `planar` holds `channels` runs of `frames` samples; `startSample` is relative to the first exported sample. */
  encode(planar: Float32Array, frames: number, startSample: number): void;
  ready(): Promise<void>;
  flush(): Promise<void>;
}

/** Everything the loop needs from the platform. `web-env.ts` builds the real one, unit tests build fakes. */
export interface ExportEnv<F extends { close(): void }> {
  plan: ExportPlan;
  /** `FrameDescription` at `ticks` with an audio window of `audioSamples` (the engine's `evaluate`). */
  evaluate(ticks: number, audioSamples: number): Promise<FrameDescription> | FrameDescription;
  /** Decodes and composites one output frame. `index` is relative to the first exported frame. */
  render(desc: FrameDescription, index: number): Promise<F>;
  /** Mixes the audio of `desc` (an evaluate with a window of `frames` samples) into `out` (planar, 2 x `frames`). */
  mix(desc: FrameDescription, frames: number, out: Float32Array): Promise<void>;
  video: VideoPort<F>;
  audio: AudioPort;
  /** Finalizes the file (index, flush to storage) and returns its size. Only after both ports flushed. */
  finish(): Promise<{ fileBytes: number }>;
  /** Closes everything without flushing and deletes the partial file. Safe to call at any point, more than once. */
  abort(): Promise<void>;
  now(): number;
  /** Most frames that were waiting in the video encoder at any moment. */
  peakQueue(): number;
  /** Optional finer split of `render` (decode vs composite) in ms since the start, for the stats. */
  timing?(): Record<string, number>;
}

export interface PipelineResult {
  frames: number;
  fileBytes: number;
  encodeMs: number;
  peakEncodeQueue: number;
  /** Where the time went, ms summed over the run (the loop is serial, so they add up to about `encodeMs`): `evaluate`, `render` (decode + composite + capture), `encode` (handing the frame over), `audio`, `wait` (back-pressure from the encoder and muxer), plus whatever `env.timing` adds. */
  timingMs: Record<string, number>;
}

const PROGRESS_EVERY_MS = 200;
const RATE_WINDOW_MS = 3000;

/**
 * The export loop: per frame `evaluate -> render -> encode`, audio mixed from `evaluate`'s segments just far enough to cover the frame,
 * then wait for the encoder (back-pressure keeps memory flat). Frame times are integer ticks and microseconds from the plan (no float drift).
 * Not tied to real time: it runs as fast as the encoder allows. Cancelling (`signal`) aborts the env and throws `ExportError("cancelled")`.
 */
export async function runExport<F extends { close(): void }>(env: ExportEnv<F>, signal: AbortSignal, onProgress: (p: ExportProgress) => void): Promise<PipelineResult> {
  const { plan } = env;
  const t0 = env.now();
  const history: Array<[number, number]> = [[t0, 0]];
  let lastEmit = -Infinity;
  const emit = (framesDone: number, phase: ExportProgress["phase"], force: boolean): void => {
    const now = env.now();
    if (!force && now - lastEmit < PROGRESS_EVERY_MS) return;
    lastEmit = now;
    history.push([now, framesDone]);
    while (history.length > 2 && now - (history[1]?.[0] ?? now) > RATE_WINDOW_MS) history.shift();
    const [oldT, oldF] = history[0] ?? [t0, 0];
    const dt = now - oldT;
    const fps = dt > 0 ? ((framesDone - oldF) * 1000) / dt : 0;
    const elapsedMs = now - t0;
    const etaMs = elapsedMs >= 1000 && fps > 0 && phase === "encoding" ? Math.round(((plan.totalFrames - framesDone) * 1000) / fps) : phase === "finalizing" ? 0 : null;
    onProgress({ framesDone, totalFrames: plan.totalFrames, fraction: framesDone / plan.totalFrames, elapsedMs, etaMs, fps, phase });
  };
  const checkCancelled = (): void => {
    if (signal.aborted) throw new ExportError("cancelled", "The export was cancelled.");
  };

  const timing: Record<string, number> = { evaluate: 0, render: 0, encode: 0, audio: 0, wait: 0 };
  const lap = (key: string, since: number): number => {
    const t = env.now();
    timing[key] = (timing[key] ?? 0) + (t - since);
    return t;
  };

  const hasAudio = plan.totalSamples > 0;
  const audioStart = Number((BigInt(plan.startFrame) * BigInt(plan.sampleRate) * BigInt(plan.fpsDen) * 2n + BigInt(plan.fpsNum)) / (BigInt(plan.fpsNum) * 2n));
  const scratch = new Float32Array(AUDIO_BLOCK * 2);
  let audioDone = 0;
  const feedAudio = async (target: number): Promise<void> => {
    while (hasAudio && audioDone < Math.min(target, plan.totalSamples)) {
      const n = Math.min(AUDIO_BLOCK, Math.min(target, plan.totalSamples) - audioDone);
      const desc = await env.evaluate(sampleTicks(audioStart + audioDone, plan.sampleRate), n);
      const out = scratch.subarray(0, n * 2);
      out.fill(0);
      await env.mix(desc, n, out);
      env.audio.encode(out, n, audioDone);
      audioDone += n;
    }
  };

  try {
    for (let i = 0; i < plan.totalFrames; i++) {
      checkCancelled();
      let t = env.now();
      const desc = await env.evaluate(frameTicks(plan.startFrame + i, plan.fpsNum, plan.fpsDen), 0);
      t = lap("evaluate", t);
      const frame = await env.render(desc, i);
      t = lap("render", t);
      try {
        env.video.encode(frame, i % plan.keyframeEvery === 0);
      } finally {
        frame.close();
      }
      t = lap("encode", t);
      const target = i === plan.totalFrames - 1 ? plan.totalSamples : Number((BigInt(i + 1) * BigInt(plan.sampleRate) * BigInt(plan.fpsDen) * 2n + BigInt(plan.fpsNum)) / (BigInt(plan.fpsNum) * 2n));
      await feedAudio(target);
      t = lap("audio", t);
      await Promise.all([env.video.ready(), env.audio.ready()]);
      lap("wait", t);
      emit(i + 1, "encoding", i === plan.totalFrames - 1);
    }
    checkCancelled();
    emit(plan.totalFrames, "finalizing", true);
    await Promise.all([env.video.flush(), env.audio.flush()]);
    checkCancelled();
    const { fileBytes } = await env.finish();
    const split = Object.fromEntries(Object.entries({ ...timing, ...env.timing?.() }).map(([k, v]) => [k, Math.round(v)]));
    return { frames: plan.totalFrames, fileBytes, encodeMs: env.now() - t0, peakEncodeQueue: env.peakQueue(), timingMs: split };
  } catch (e) {
    await env.abort();
    throw e;
  }
}

/** Timestamps the encoders and muxer see for output frame `i` and audio sample `s` (exposed for tests). */
export const outputFrameTimes = (plan: ExportPlan, i: number): { timestamp: number; duration: number } => {
  const timestamp = frameMicros(i, plan.fpsNum, plan.fpsDen);
  return { timestamp, duration: frameMicros(i + 1, plan.fpsNum, plan.fpsDen) - timestamp };
};
export const outputSampleMicros = (plan: ExportPlan, s: number): number => sampleMicros(s, plan.sampleRate);
