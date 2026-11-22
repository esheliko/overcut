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
