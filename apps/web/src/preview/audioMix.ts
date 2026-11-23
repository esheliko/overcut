/** Mixing of evaluated audio segments into a stereo window. Pure; the player feeds it decoded source samples. */
import { TICKS_PER_SECOND } from "./timing";
import type { AudioSegment } from "@app/engine-client";

/** Source sample index (at `rate`) of a tick position. */
export const sampleAtTicks = (ticks: number, rate: number): number => Math.floor((ticks * rate) / TICKS_PER_SECOND);

/** Source samples a segment reads: `len * speed`, rounded up so the last output sample has data. */
export const sourceSamplesFor = (seg: Pick<AudioSegment, "len" | "speed">): number => Math.max(1, Math.ceil((seg.len * seg.speed.num) / seg.speed.den));

/**
 * Add `src` (interleaved, `channels`) into stereo `left`/`right` at `seg.out_start`, scaled by `seg.gain` and resampled by
 * `speed` (linear). Mono goes to both sides; more than two channels use the first two. `skip` drops that many output samples from the start of
 * the segment (the clock moved on while the chunk was being prepared).
 */
export function mixSegment(left: Float32Array, right: Float32Array, seg: Pick<AudioSegment, "out_start" | "len" | "speed" | "gain">, src: Float32Array, channels: number, skip = 0): void {
  const speed = seg.speed.num / seg.speed.den;
  const srcFrames = Math.floor(src.length / channels);
  const r = channels > 1 ? 1 : 0;
  for (let i = Math.max(0, skip); i < seg.len; i++) {
    const o = seg.out_start + i;
    if (o < 0 || o >= left.length) continue;
    let l: number, rr: number;
    if (speed === 1) {
      if (i >= srcFrames) break;
      l = src[i * channels]!;
      rr = src[i * channels + r]!;
    } else {
      const p = i * speed;
      const i0 = Math.floor(p);
      if (i0 >= srcFrames) break;
      const i1 = Math.min(srcFrames - 1, i0 + 1);
      const f = p - i0;
      l = src[i0 * channels]! * (1 - f) + src[i1 * channels]! * f;
      rr = src[i0 * channels + r]! * (1 - f) + src[i1 * channels + r]! * f;
    }
    left[o]! += l * seg.gain;
    right[o]! += rr * seg.gain;
  }
}

/** Hard limiter so summed tracks clip softly instead of wrapping (full scale is 1.0). */
export function limit(buf: Float32Array): void {
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i]!;
    if (v > 1 || v < -1) buf[i] = Math.tanh(v);
  }
}
