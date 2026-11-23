/**
 * Builds a scrub strip in the preview Worker: one sequential decode of the clip (`MediaHandle.stream`), each stored frame scaled onto a reused
 * OffscreenCanvas and JPEG-encoded, packed per segment into the cache. Cancellable at every frame, and it waits whenever the user is playing or
 * scrubbing (`idle`), so it only takes what the foreground leaves. Playback and export never read the result.
 */
import type { MediaHandle } from "@app/engine-client";
import type { MediaCache } from "../../media/cache";
import { segmentCount, packSegment, saveManifest, segmentKey, type Manifest } from "./store";
import type { StripSpec } from "./policy";

export type BuildResult = "done" | "cancelled" | "no-fit" | "failed";

export interface BuildJob {
  handle: MediaHandle;
  cache: MediaCache;
  base: string;
  spec: StripSpec;
  manifest: Manifest;
  /** Cache cap in bytes: a clip whose whole strip would not fit is not built (it would only evict itself). */
  capBytes: number;
  cancelled(): boolean;
  /** True when nothing in the foreground needs the Worker (not playing, not scrubbing, quiet for a moment). */
  idle(): boolean;
  /** Frames stored so far (all segments, including earlier sessions') out of the total, after every segment. */
  progress(doneFrames: number, totalFrames: number): void;
  /** Called with the cache after a put that did not stick (storage blocked or full): the manager may swap to memory. Returns the cache to use next. */
  onStoreFailure?(): MediaCache | undefined;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function buildStrip(job: BuildJob): Promise<BuildResult> {
  const { handle, spec, manifest, base } = job;
  let { cache } = job;
  const frames = manifest.frames;
  const segs = segmentCount(frames, spec);
  const todo: number[] = [];
  for (let s = 0; s < segs; s++) if (!manifest.done.includes(s)) todo.push(s);
  const doneFrames = () => manifest.done.reduce((n, s) => n + Math.min(spec.segFrames, frames - s * spec.segFrames), 0);
  job.progress(doneFrames(), frames);
  if (todo.length === 0) return "done";

  let canvas: OffscreenCanvas | undefined;
  let g: OffscreenCanvasRenderingContext2D | null = null;
  let stream: ReturnType<MediaHandle["stream"]> | undefined;
  let next = -1; // the source index the open stream hands out next
  let sampleBytes = 0;
  let sampleSegs = 0;
  try {
    for (const s of todo) {
      const first = s * spec.segFrames;
      const end = Math.min(frames, first + spec.segFrames);
      // One decoder run covers consecutive segments (a new run starts from a keyframe and throws its pre-roll away), so reopen only after a gap.
      if (!stream || next !== first) {
        stream?.close();
        stream = undefined;
        while (!job.idle()) { if (job.cancelled()) return "cancelled"; await sleep(120); } // a decoder is a resource too: open it only when the foreground is quiet
        if (!canvas) {
          canvas = new OffscreenCanvas(spec.w, spec.h);
          g = canvas.getContext("2d", { alpha: false });
          if (!g) return "failed";
        }
        stream = handle.stream(first, 3);
        next = first;
      }
      const jpegs: Uint8Array[] = [];
      while (next < end) {
        while (!job.idle()) { if (job.cancelled()) return "cancelled"; await sleep(120); }
        if (job.cancelled()) return "cancelled";
        const f = await stream.next();
        if (!f) return "failed"; // the stream ended early
        try {
          if ((f.index - first) % spec.stride === 0 && f.kind === "gpu") {
            g!.drawImage(f.frame, 0, 0, spec.w, spec.h);
            const blob = await canvas!.convertToBlob({ type: "image/jpeg", quality: spec.quality });
            jpegs.push(new Uint8Array(await blob.arrayBuffer()));
          } else if ((f.index - first) % spec.stride === 0) return "failed"; // CPU frames (native bridge) never come from this path
        } finally {
          f.release();
        }
        next = f.index + 1;
      }
      const packed = packSegment(first, spec.stride, jpegs);
      sampleBytes += packed.length;
      sampleSegs++;
      // Whole-strip size, extrapolated from the segments built so far; stop early when it cannot fit.
      if (sampleSegs >= 1 && (sampleBytes / sampleSegs) * segs > job.capBytes * 0.8) return "no-fit";
      await cache.put(segmentKey(base, s), packed);
      if (!(await cache.has(segmentKey(base, s)))) {
        // Storage refused the write (blocked, quota): the manager can fall back to a memory-backed cache; otherwise give up on this clip.
        const swap = job.onStoreFailure?.();
        if (!swap) return "failed";
        cache = swap;
        await cache.put(segmentKey(base, s), packed);
      }
      manifest.done.push(s);
      await saveManifest(cache, base, manifest);
      job.progress(doneFrames(), frames);
    }
    return "done";
  } catch {
    return "failed";
  } finally {
    stream?.close();
  }
}
