import type { AudioPort, VideoPort } from "./pipeline";
import { outputSampleMicros } from "./pipeline";
import type { ExportPlan } from "./plan";
import { maxAudioPackets, createMuxer, type Muxer } from "./mux";
import { describeAudioConfig, describeVideoConfig, type ResolvedPreset } from "./presets";
import type { ExportFile } from "./storage";
import { ExportError } from "./types";

/** Encoder queue depth that stops the loop: small enough to keep memory flat, large enough to keep a hardware encoder busy. */
const MAX_ENCODE_QUEUE = 4;
/** Muxer writes in flight. */
const MAX_MUX_BACKLOG = 16;

export interface WebOutput {
  video: VideoPort<VideoFrame>;
  audio: AudioPort;
  /** Most frames that were waiting in the video encoder when `video.ready` was called. */
  peakQueue(): number;
  /** Flushes happened already: writes the index and closes the file. */
  finish(): Promise<{ fileBytes: number; mime: string }>;
  /** Closes the encoders and the muxer without flushing and deletes the partial file. Idempotent. */
  abort(): Promise<void>;
}

/** VideoEncoder + AudioEncoder feeding the muxer into `file`, with back-pressure from both. */
export async function createWebOutput(plan: ExportPlan, preset: ResolvedPreset, file: ExportFile, signal: AbortSignal, creationTime: number | undefined, makeMuxer: typeof createMuxer = createMuxer): Promise<WebOutput> {
  let failure: ExportError | null = null;
  const fail = (code: ExportError["code"], e: unknown): void => {
    failure ??= new ExportError(code, `${code === "storage_failed" ? "Writing the file failed" : "Encoding failed"}: ${e instanceof Error ? `${e.name === "Error" ? "" : `${e.name}: `}${e.message}` : String(e)}`, {
      name: e instanceof Error ? e.name : undefined,
      message: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
      video: describeVideoConfig(preset.video),
      audio: describeAudioConfig(preset.audio),
    });
  };
  const check = (): void => {
    if (failure) throw failure;
    if (signal.aborted) throw new ExportError("cancelled", "The export was cancelled.");
  };

  const muxer: Muxer = await makeMuxer({
    container: preset.container,
    videoCodec: preset.videoCodec,
    audioCodec: preset.audioCodec,
    frameRate: plan.fpsNum / plan.fpsDen,
    maxVideoPackets: plan.totalFrames + 8,
    maxAudioPackets: maxAudioPackets(plan.totalSamples),
    endSeconds: plan.totalSamples / plan.sampleRate,
    creationTime: creationTime === undefined ? undefined : new Date(creationTime),
    target: file.writable,
  });

  // One chain keeps muxer calls in the order the encoders produced them; `backlog` counts what has not been written yet.
  let chain: Promise<void> = Promise.resolve();
  let backlog = 0;
  const toMux = (f: () => Promise<void>): void => {
    backlog++;
    chain = chain
      .then(f)
      .catch((e) => fail("storage_failed", e))
      .finally(() => void backlog--);
  };

  const venc = new VideoEncoder({
    output: (chunk, meta) => toMux(() => muxer.addVideo(chunk, meta)),
    error: (e) => fail("encode_failed", e),
  });
  const aenc = new AudioEncoder({
    output: (chunk, meta) => toMux(() => muxer.addAudio(chunk, meta)),
    error: (e) => fail("encode_failed", e),
  });
  try {
    venc.configure(preset.video);
    aenc.configure(preset.audio);
  } catch (e) {
    // A config the encoder rejects synchronously (it passed isConfigSupported but fails here): close what exists and report which config.
    for (const enc of [venc, aenc]) if (enc.state !== "closed") enc.close();
    await muxer.cancel().catch(() => undefined);
    throw new ExportError("encode_failed", `Could not start encoding: ${e instanceof Error ? e.message : String(e)}`, {
      name: e instanceof Error ? e.name : undefined,
      message: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
      video: describeVideoConfig(preset.video),
      audio: describeAudioConfig(preset.audio),
    });
  }

  const aborted = new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
  const nextDequeue = (enc: VideoEncoder | AudioEncoder): Promise<void> =>
    new Promise((r) => {
      const done = (): void => {
        enc.removeEventListener("dequeue", done);
        r();
      };
      enc.addEventListener("dequeue", done);
    });
  let peak = 0;
  const ready = async (enc: VideoEncoder | AudioEncoder): Promise<void> => {
    for (;;) {
      check();
      if (enc === venc) peak = Math.max(peak, venc.encodeQueueSize);
      if (enc.encodeQueueSize > MAX_ENCODE_QUEUE) await Promise.race([nextDequeue(enc), aborted]);
      else if (backlog > MAX_MUX_BACKLOG) await Promise.race([chain, aborted]);
      else return;
    }
  };

  let aborting: Promise<void> | null = null;
  return {
    video: {
      encode: (frame, keyFrame) => {
        check();
        venc.encode(frame, { keyFrame });
      },
      ready: () => ready(venc),
      flush: async () => {
        check();
        try {
          await venc.flush();
        } catch (e) {
          check(); // the encoder's own error callback has the better description
          throw e;
        }
      },
    },
    audio: {
      encode: (planar, frames, startSample) => {
        check();
        const data = new AudioData({ format: "f32-planar", sampleRate: plan.sampleRate, numberOfFrames: frames, numberOfChannels: 2, timestamp: outputSampleMicros(plan, startSample), data: planar as Float32Array<ArrayBuffer> });
        aenc.encode(data);
        data.close();
      },
      ready: () => ready(aenc),
      flush: async () => {
        check();
        try {
          await aenc.flush();
        } catch (e) {
          check(); // the encoder's own error callback has the better description
          throw e;
        }
      },
    },
    peakQueue: () => peak,
    finish: async () => {
      await chain;
      check();
      await muxer.finalize();
      const mime = await muxer.mime();
      const fileBytes = await file.close();
      check();
      return { fileBytes, mime };
    },
    abort: () =>
      (aborting ??= (async () => {
        for (const enc of [venc, aenc]) if (enc.state !== "closed") enc.close();
        await muxer.cancel().catch(() => undefined);
        await file.abort();
      })()),
  };
}
