/** Viewport math for the canvas timeline: pure, no DOM. Units: CSS pixels and seconds. */
export const MIN_PPS = 2;
export const MAX_PPS = 1200;
/** Default gutter (px). The canvas widens it for track headers: `GUTTER_WIDE` with a mouse, `GUTTER_COMPACT` on a phone (view.gutter). */
export const GUTTER = 48;
export const GUTTER_WIDE = 148;
export const GUTTER_COMPACT = 60;
export const RULER = 30;
export const LANE = 52;
export const END_PAD = 96;

export interface View {
  /** Pixels per second. */
  pps: number;
  /** Scroll offsets in CSS px (>= 0). */
  scrollX: number;
  scrollY: number;
  /** Canvas size in CSS px. */
  width: number;
  height: number;
  /** Header column width in CSS px (default GUTTER) and whether headers are the compact, touch-first kind. */
  gutter?: number;
  compact?: boolean;
}

export const gut = (v: View) => v.gutter ?? GUTTER;

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const clampPps = (pps: number) => clamp(pps, MIN_PPS, MAX_PPS);

export const timeToX = (v: View, sec: number) => gut(v) + sec * v.pps - v.scrollX;
export const xToTime = (v: View, x: number) => (x - gut(v) + v.scrollX) / v.pps;

export function maxScrollX(v: View, lengthSec: number) {
  return Math.max(0, lengthSec * v.pps + END_PAD - (v.width - gut(v)));
}
export function maxScrollY(v: View, trackCount: number) {
  return Math.max(0, trackCount * LANE - (v.height - RULER));
}

/** Mutates `v`: keeps scroll inside the content. */
export function clampScroll(v: View, lengthSec: number, trackCount: number) {
  v.scrollX = clamp(v.scrollX, 0, maxScrollX(v, lengthSec));
  v.scrollY = clamp(v.scrollY, 0, maxScrollY(v, trackCount));
}

/** Mutates `v`: sets zoom so the time under screen x stays under screen x. */
export function zoomAt(v: View, pps: number, anchorX: number) {
  const t = xToTime(v, anchorX);
  v.pps = clampPps(pps);
  v.scrollX = Math.max(0, t * v.pps - (anchorX - gut(v)));
}

/** Slider (0..1, logarithmic) <-> pixels per second. */
export const ppsToSlider = (pps: number) => Math.log(clampPps(pps) / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS);
export const sliderToPps = (s: number) => clampPps(MIN_PPS * Math.pow(MAX_PPS / MIN_PPS, clamp(s, 0, 1)));

/** Pixels per second that fit `lengthSec` in the viewport. */
export const fitPps = (v: View, lengthSec: number) => clampPps((v.width - gut(v) - END_PAD) / Math.max(1, lengthSec));

/** Exponential fling decay: velocity (px/ms) after dt ms. */
export const decayVelocity = (vel: number, dtMs: number, tauMs = 325) => vel * Math.exp(-dtMs / tauMs);

const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
/** Smallest nice step (seconds) whose gap is at least `minGapPx` wide. */
export function tickStep(pps: number, minGapPx = 72): number {
  for (let i = 0; i < STEPS.length; i++) if (STEPS[i]! * pps >= minGapPx) return STEPS[i]!;
  return 3600;
}
