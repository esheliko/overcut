/**
 * Places decoded audio blocks on a contiguous timeline and resamples to `outRate` (linear interpolation; identity when the rates
 * match, so the common 48 kHz to 48 kHz case is bit-exact). Output is `count * channels` interleaved f32 starting at output sample
 * `start`; anything the decoder did not produce is silence.
 */
export interface AudioBlock {
  /** Timestamp of the block's first sample, microseconds. */
  ts: number;
  /** Planar: one array per channel. */
  planes: Float32Array[];
}

export function assemble(blocks: readonly AudioBlock[], srcRate: number, channels: number, start: number, count: number, outRate: number, shift = 0): Float32Array {
  const out = new Float32Array(count * channels);
  if (blocks.length === 0 || count === 0) return out;
  // Source timeline: sample index = round(ts * srcRate / 1e6), relative to the first block.
  const base = Math.round((blocks[0]!.ts * srcRate) / 1e6); // `shift` moves blocks later, in source samples.
  const at = (b: AudioBlock) => Math.round((b.ts * srcRate) / 1e6) - base + shift;
  let len = 0;
  for (const b of blocks) len = Math.max(len, at(b) + (b.planes[0]?.length ?? 0));
  const src: Float32Array[] = Array.from({ length: channels }, () => new Float32Array(len));
  for (const b of blocks) {
    const o = at(b);
    for (let c = 0; c < channels; c++) {
      const p = b.planes[Math.min(c, b.planes.length - 1)];
      if (p && o >= 0) src[c]!.set(p, o);
    }
  }
  // Output sample n is at time (start + n) / outRate seconds = source index there * srcRate, minus the timeline base.
  const identity = srcRate === outRate;
  for (let n = 0; n < count; n++) {
    const pos = identity ? start + n - base : ((start + n) * srcRate) / outRate - base;
    const i0 = Math.floor(pos);
    const f = pos - i0;
    for (let c = 0; c < channels; c++) {
      const s = src[c]!;
      const a = i0 >= 0 && i0 < len ? s[i0]! : 0;
      const b = i0 + 1 >= 0 && i0 + 1 < len ? s[i0 + 1]! : 0;
      out[n * channels + c] = f === 0 ? a : a + (b - a) * f;
    }
  }
  return out;
}
