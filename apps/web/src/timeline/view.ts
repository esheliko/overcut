/** Viewport math for the canvas timeline: pure, no DOM. Units: CSS pixels and seconds. */
/** 10 hours across a 1500 px timeline is 0.04 px/s; 0.005 leaves room for ultrawide and phone widths alike. */
export const MIN_PPS = 0.005;
export const MAX_PPS = 1200;
/** Longest project the zoom range is built for (seconds): 10 h. */
export const MAX_SPAN_SEC = 36000;
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

const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600, 7200, 14400, 21600, 43200];
/** Smallest nice step (seconds) whose gap is at least `minGapPx` wide. */
export function tickStep(pps: number, minGapPx = 72): number {
  for (let i = 0; i < STEPS.length; i++) if (STEPS[i]! * pps >= minGapPx) return STEPS[i]!;
  return STEPS[STEPS.length - 1]!;
}
/** Minor ticks per labelled step: a divisor that lands on whole units (4 for 2 s / 2 min / 2 h, 3 for 15 s, 5 otherwise). */
export function minorDivisions(step: number): number {
  return step === 0.2 || step === 2 || step === 120 || step === 7200 || step === 14400 ? 4 : step === 15 || step === 21600 ? 3 : step === 30 || step === 60 || step === 1800 || step === 3600 || step === 43200 ? 6 : 5;
}
/** Ruler label for `sec` on a ruler stepping by `step`: m:ss(.f) at short scales, h:mm:ss once past an hour, h:mm when the step is a minute or more. */
export function formatTick(sec: number, step: number): string {
  const whole = Math.floor(sec + 1e-9);
  const frac = sec - whole;
  const h = Math.floor(whole / 3600), m = Math.floor((whole % 3600) / 60), s = whole % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  if (step >= 60 && h > 0) return `${h}:${two(m)}`;
  if (h > 0) return `${h}:${two(m)}:${two(s)}`;
  return `${m}:${two(s)}${frac > 0.001 ? "." + String(Math.round(frac * 10)) : ""}`;
}

/** Marker names and chapter diamonds are drawn only when a marker's flag has room: below this zoom they collapse to a thin line. */
export const MARKER_NAME_PPS = 20;
/** Whether clips at this zoom are wide enough to carry a filmstrip or waveform (px per second; a clip needs `TILE_MIN` px). */
export const TILE_MIN = 28, NAME_MIN = 56;
/** Clip width (px) -> what to draw: "block" (plain coloured body only), "tiles" (filmstrip / waveform), "name" (tiles and the name). */
export function clipDetail(widthPx: number): "block" | "tiles" | "name" {
  return widthPx >= NAME_MIN ? "name" : widthPx >= TILE_MIN ? "tiles" : "block";
}

/** Zoom and scroll that show [t0, t1] seconds across the timeline width (with a small margin). Null if the range is empty. */
export function viewForRange(v: View, t0: number, t1: number, margin = 24): { pps: number; scrollX: number } | null {
  const span = t1 - t0;
  if (!(span > 0)) return null;
  const pps = clampPps((v.width - gut(v) - 2 * margin) / span);
  return { pps, scrollX: Math.max(0, t0 * pps - margin) };
}
