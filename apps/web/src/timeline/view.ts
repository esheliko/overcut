/** Viewport math for the canvas timeline: pure, no DOM. Units: CSS pixels and seconds. */
/** 10 hours across a 1500 px timeline is 0.04 px/s; 0.005 leaves room for ultrawide and phone widths alike. */
export const MIN_PPS = 0.005;
export const MAX_PPS = 1200;
/** Longest project the zoom range is built for (seconds): 10 h. */
export const MAX_SPAN_SEC = 36000;
/** Default gutter (px). The canvas widens it for track headers: `GUTTER_WIDE` with a mouse, `GUTTER_COMPACT` on a phone (view.gutter). */
export const GUTTER = 48;
export const GUTTER_WIDE = 172;
export const GUTTER_COMPACT = 60;
export const RULER = 30;
/** Lane height (r14: was 52). One height for every track: per-kind heights would put hit-testing, drag rows and scrolling on a cumulative table (see docs/m2/ux-r14-a-look.md). */
export const LANE = 60;
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

/** One wheel notch (a ctrl + wheel tick of ~100 px) must zoom by about this factor, however hard the wheel or trackpad flings (T-04). */
export const WHEEL_NOTCH = 1.28;
/** Zoom factor for a ctrl/cmd + wheel event of `dy` pixels: exponential in dy, clamped to one notch either way. Pinch gestures on a trackpad send small dy (ctrl set by the browser) and keep their fine control. */
export function wheelZoomFactor(dy: number, pinch: boolean): number {
  const f = Math.exp(-dy * (pinch ? 0.01 : 0.0025));
  return clamp(f, 1 / WHEEL_NOTCH, WHEEL_NOTCH);
}

/** Whether a timeline that just grew should fit itself to the width (L-06): a first clip always does, later additions only when the end moved past what is visible
 *  and the person has not set the zoom by hand. Pure; `endSec` values are the end of the last clip before and after, `visibleSec` the time at the right edge. */
export function shouldAutoFit(p: { prevClips: number; clips: number; prevEndSec: number; endSec: number; visibleEndSec: number; userZoomed: boolean }): boolean {
  if (p.clips <= p.prevClips) return false;
  if (p.prevClips === 0) return true;
  return !p.userZoomed && p.endSec > p.prevEndSec && p.endSec > p.visibleEndSec;
}

/** A length for the drag ghost: "4s", "12.5s", "1:05" (seconds, one decimal under 10 s). */
export function formatDur(sec: number): string {
  const s = Math.max(0, sec);
  if (s < 10) return `${Number(s.toFixed(1))}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return r === 60 ? `${m + 1}:00` : `${m}:${String(r).padStart(2, "0")}`;
}

/** Slider (0..1, logarithmic) <-> pixels per second. */
export const ppsToSlider = (pps: number) => Math.log(clampPps(pps) / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS);
export const sliderToPps = (s: number) => clampPps(MIN_PPS * Math.pow(MAX_PPS / MIN_PPS, clamp(s, 0, 1)));

/** Pixels per second that fit `lengthSec` in the viewport. */
export const fitPps = (v: View, lengthSec: number) => clampPps((v.width - gut(v) - END_PAD) / Math.max(1, lengthSec));

/** Mutates `v`: scrolls the least needed to keep time `sec` (the playhead) on screen, with a margin from the edges. */
export function revealTime(v: View, sec: number, margin = 24) {
  const x = timeToX(v, sec);
  if (x < gut(v)) v.scrollX = Math.max(0, sec * v.pps - margin);
  else if (x > v.width - margin) v.scrollX = gut(v) + sec * v.pps - (v.width - margin);
}

/** Mutates `v`: a zoom change keeps the playhead (or the viewport centre when it is off screen) steady, then keeps it visible. */
export function zoomKeeping(v: View, pps: number, sec: number) {
  const px = timeToX(v, sec);
  zoomAt(v, pps, px > gut(v) && px < v.width ? px : gut(v) + (v.width - gut(v)) / 2);
  revealTime(v, sec);
}

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
