/** Editor clock helpers. Positions are whole frames (integers), never floats: docs/adr/0010-time.md. */
export const FPS = 30;

const pad = (n: number) => String(n).padStart(2, "0");

/** `MM:SS:FF` for a frame count. */
export function timecode(frame: number, fps = FPS): string {
  const f = Math.max(0, Math.floor(frame));
  const s = Math.floor(f / fps);
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}:${pad(f % fps)}`;
}

/** `M:SS` ruler label for a whole second. */
export function rulerLabel(second: number): string {
  return `${Math.floor(second / 60)}:${pad(second % 60)}`;
}

/** Smallest "nice" ruler step (seconds) whose gap is at least `minGapPx` wide at `pxPerSec`. */
export function rulerStep(pxPerSec: number, minGapPx = 72): number {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120];
  return steps.find((s) => s * pxPerSec >= minGapPx) ?? 120;
}

/** Frame under a pixel offset from the start of the timeline, clamped to [0, max]. */
export function frameAt(x: number, pxPerSec: number, max: number, fps = FPS): number {
  return Math.min(max, Math.max(0, Math.round((x / pxPerSec) * fps)));
}

/**
 * Frames for a typed time. Accepts `MM:SS:FF` (what `timecode` shows), `SS:FF`, `H:MM:SS:FF`, or a bare frame count; `.` and `;` work like `:`.
 * Returns null for anything else (letters, a seconds or frames field out of range, negative, fractions). Whole frames only (ADR 0010).
 */
export function parseTimecode(text: string, fps = FPS): number | null {
  const parts = text.trim().replace(/[.;]/g, ":").split(":");
  if (parts.length < 1 || parts.length > 4 || parts.some((p) => !/^\d{1,9}$/.test(p))) return null;
  const n = parts.map(Number);
  const ff = n[n.length - 1]!;
  if (n.length === 1) return ff;
  if (ff >= fps) return null;
  const ss = n[n.length - 2]!;
  if (n.length > 2 && ss >= 60) return null;
  const mm = n.length >= 3 ? n[n.length - 3]! : 0;
  if (n.length === 4 && mm >= 60) return null;
  const hh = n.length === 4 ? n[0]! : 0;
  return ((hh * 60 + mm) * 60 + ss) * fps + ff;
}
