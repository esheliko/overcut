/** The preview / timeline split (pure parts; the draggable edge is `Splitter.tsx`). */
const KEY = "overcut.layout.timelineRow";
/** The smallest timeline that still shows a toolbar and two lanes, and the smallest preview that is still worth looking at. */
export const MIN_TIMELINE = 140;
export const MIN_PREVIEW = 160;

/** `px` kept inside what the workspace (`room` px tall, panels and gaps included) allows. Infinity gives the largest, 0 the smallest. */
export function clampTimelineRow(px: number, room: number): number {
  const max = Math.max(MIN_TIMELINE, room - MIN_PREVIEW - 12);
  return Math.round(Math.min(max, Math.max(MIN_TIMELINE, px)));
}

export function readTimelineRow(): number | null {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch { return null; }
}

export function writeTimelineRow(px: number | null): void {
  try {
    if (px === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(Math.round(px)));
  } catch { /* storage unavailable: the size just is not remembered */ }
}
