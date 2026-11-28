/** Background waveform extraction (M1-013): decode audio progressively, push PCM into the engine's peaks builder, publish partial
 *  results as they grow (the timeline draws what has arrived), and cache the file by media fingerprint so it is computed once.
 *  An interrupted or cancelled job leaves its partial file in the cache and the next run resumes from the last whole bin. */
import type { Engine, MediaRef } from "@app/engine-client";
import { fingerprint, type MediaCache } from "./cache";
import type { MediaHost } from "./host";

export const peaksKey = (media: MediaRef) => `peaks/${fingerprint(media)}.bin`;

/** True when a peaks file's header says extraction finished (cheap check without the engine). */
export function peaksComplete(bytes: Uint8Array): boolean {
  return bytes.length >= 24 && bytes[0] === 0x4f && bytes[1] === 0x43 && bytes[2] === 0x50 && bytes[3] === 0x4b && (bytes[5]! & 1) === 1;
}

export interface ExtractOptions {
  engine: Pick<Engine, "peaks">;
  host: MediaHost;
  cache: MediaCache;
  media: MediaRef;
  signal?: AbortSignal;
  /** Called between decode steps; resolves when the next step may run (default: a zero-delay timeout). The app passes `pace`, which also waits while the user plays or drags. */
  pace?: () => Promise<void>;
  /** PCM frames decoded per step (default 2 s at the stream's rate). */
  chunkSeconds?: number;
  /** Minimum time between published partial files. */
  publishEveryMs?: number;
  /** Called with each partial file (and the final one) and the fraction decoded. */
  onFile?: (file: Uint8Array, progress: number) => void;
}

export interface ExtractResult {
  /** The complete peaks file, or null when the media has no audio or the job was cancelled. */
  file: Uint8Array | null;
  /** Served from the cache without decoding. */
  cached: boolean;
  /** Frames decoded by this run. */
  decodedFrames: number;
  sampleRate: number;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export async function extractPeaks(o: ExtractOptions): Promise<ExtractResult> {
  const { engine, host, cache, media, signal } = o;
  const fmt = await host.audioFormat(media);
  if (!fmt) return { file: null, cached: false, decodedFrames: 0, sampleRate: 0 };
  const key = peaksKey(media);
  const stored = await cache.get(key);
  if (stored && peaksComplete(stored)) {
    o.onFile?.(stored, 1);
    return { file: stored, cached: true, decodedFrames: 0, sampleRate: fmt.sampleRate };
  }
  let job;
  try { job = await engine.peaks.begin(fmt.sampleRate, fmt.channels, stored ?? undefined); }
  catch { job = await engine.peaks.begin(fmt.sampleRate, fmt.channels); } // unreadable cache entry: start over
  const chunk = Math.max(1024, Math.round((o.chunkSeconds ?? 2) * fmt.sampleRate));
  const every = o.publishEveryMs ?? 400;
  let pos = job.nextFrame, decoded = 0, lastPublish = performance.now();
  const publish = async () => {
    const snap = await job.snapshot();
    await cache.put(key, snap);
    o.onFile?.(snap, Math.min(1, pos / Math.max(1, fmt.frames)));
    lastPublish = performance.now();
  };
  try {
    while (pos < fmt.frames) {
      if (signal?.aborted) { await publish(); await job.dispose(); return { file: null, cached: false, decodedFrames: decoded, sampleRate: fmt.sampleRate }; }
      const pcm = await host.readAudio(media, pos, Math.min(chunk, fmt.frames - pos));
      const n = Math.floor(pcm.length / fmt.channels);
      if (n === 0) break;
      await job.push(pcm);
      pos += n; decoded += n;
      if (performance.now() - lastPublish >= every) await publish();
      await (o.pace ?? tick)(); // keep the thread responsive between chunks
    }
    const file = await job.finish();
    await cache.put(key, file);
    o.onFile?.(file, 1);
    return { file, cached: false, decodedFrames: decoded, sampleRate: fmt.sampleRate };
  } catch (e) {
    await job.dispose();
    throw e;
  }
}
