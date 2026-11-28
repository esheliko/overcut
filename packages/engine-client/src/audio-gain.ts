import type { AudioSegment } from "./types";

/** The part of a segment the envelope needs. */
export type GainSegment = Pick<AudioSegment, "gain" | "fade_in" | "fade_out" | "clip_len" | "clip_offset">;

/**
 * The gain of output sample `i` of a segment: the clip's volume times a **linear** fade envelope (0 to 1 over `fade_in` samples from the
 * clip's first sample, 1 to 0 over `fade_out` samples ending at its last). The twin of `AudioSegment::gain_at` in `crates/timeline`
 * (`docs/features/clip-audio.md`); preview and export both call this, and `tests/unit/audio-gain.test.ts` checks it against the engine's values.
 */
export function segmentGain(seg: GainSegment, i: number): number {
  const fi = seg.fade_in;
  const fo = seg.fade_out;
  if (fi === 0 && fo === 0) return seg.gain;
  const k = seg.clip_offset + i;
  let e = 1;
  if (k < fi) e = k / fi;
  const left = Math.max(0, seg.clip_len - 1 - k);
  if (left < fo) e = Math.min(e, left / fo);
  return seg.gain * Math.fround(e);
}
