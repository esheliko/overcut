/** Pure playback arithmetic: frames, ticks, the audio-master clock and JKL shuttle. All times are integer ticks (ADR 0010). */
import { TICKS_PER_SECOND } from "../timeline/scene";

export { TICKS_PER_SECOND };

export interface Rate { num: number; den: number }

/** Start of sequence frame `n` in ticks (floor of `n * TPS * den / num`; exact for every standard frame rate). */
export const frameStartTicks = (n: number, r: Rate): number => Math.floor((n * TICKS_PER_SECOND * r.den) / r.num);

/** The sequence frame containing `ticks` (video is sampled at the start of this frame, docs/features/evaluate.md). */
export const frameAtTicks = (ticks: number, r: Rate): number => Math.max(0, Math.floor((ticks * r.num) / (TICKS_PER_SECOND * r.den) + 1e-9));

/** Whole frames per second used for timecode labels (29.97 counts 30: non-drop-frame labelling, documented in preview.md). */
export const nominalFps = (r: Rate): number => Math.max(1, Math.round(r.num / r.den));

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** `HH:MM:SS:FF`, always left-to-right. */
export function timecodeHMS(frame: number, r: Rate): string {
  const fps = nominalFps(r);
  const f = Math.max(0, Math.floor(frame));
  const s = Math.floor(f / fps);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(f % fps)}`;
}

/** Where playback is: `ticks` at clock time `at` (seconds) running at `rate` (1 = normal, negative = reverse). */
export interface Anchor { ticks: number; at: number; rate: number }

/** Timeline position at clock time `now`, clamped to `[0, end]`. Position never depends on how many frames were presented, so it cannot drift. */
export function positionAt(a: Anchor, now: number, end: number): number {
  const t = a.ticks + Math.round((now - a.at) * a.rate * TICKS_PER_SECOND);
  return Math.min(end, Math.max(0, t));
}

export const MAX_SHUTTLE = 4;

/** JKL: L runs forward (repeat = 2x, 4x), J backward likewise, K stops. A key against the current direction restarts at 1x. */
export function shuttle(rate: number, key: "J" | "K" | "L"): number {
  if (key === "K") return 0;
  if (key === "L") return rate >= 1 ? Math.min(MAX_SHUTTLE, rate * 2) : 1;
  return rate <= -1 ? Math.max(-MAX_SHUTTLE, rate * 2) : -1;
}

/** Text for the speed badge: `2×`, `-4×` (empty at normal speed). */
export const rateLabel = (rate: number): string => (rate === 1 || rate === 0 ? "" : `${rate}×`);

/** Frames the player may hold ahead of the playhead for a source frame size, within a byte budget (docs/features/preview.md). */
export function prefetchFrames(budgetBytes: number, width: number, height: number, minFrames = 2, maxFrames = 12): number {
  const per = Math.max(1, width * height * 4);
  return Math.max(minFrames, Math.min(maxFrames, Math.floor(budgetBytes / per)));
}
