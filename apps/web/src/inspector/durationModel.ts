/** Pure logic of a photo's Duration field (UX r16): seconds typed -> whole frames in ticks -> the trim that carries it. */
import type { Clip, Op, Rational } from "@app/engine-client";
import { TICKS_PER_SECOND } from "../preview/timing";

export const MIN_STILL_SECONDS = 0.1;
export const MAX_STILL_SECONDS = 3600;

/** A typed length in seconds as whole frames' worth of ticks; null when it is not a number in range. */
export function stillTicks(seconds: number, rate: Rational): number | null {
  if (!Number.isFinite(seconds) || seconds < MIN_STILL_SECONDS || seconds > MAX_STILL_SECONDS) return null;
  const perFrame = (TICKS_PER_SECOND * rate.den) / rate.num;
  return Math.max(1, Math.round((seconds * TICKS_PER_SECOND) / perFrame)) * perFrame;
}

/** The edit that gives a photo clip a new length: its end moves, its start stays. */
export const stillOps = (clip: Pick<Clip, "id" | "start">, ticks: number): Op[] => [{ op: "trim_out", clip: clip.id, end: clip.start + ticks }];

/** "4", "2.5": the seconds as the field shows them (at most two decimals, no trailing zeros). */
export const secondsText = (ticks: number): string => String(Number((ticks / TICKS_PER_SECOND).toFixed(2)));
