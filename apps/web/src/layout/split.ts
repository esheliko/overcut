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

/** Rows the timeline needs, in px: toolbar, ruler, `tracks` lanes and the add-track buttons. */
const TL_CHROME = 56 + 30 + 64, TL_LANE = 60;
/** The default timeline height for a workspace `room` px tall: 40% of it, growing with the track count up to 50% (r16 DESK-4). Kept inside the allowed range. */
export function autoTimelineRow(room: number, tracks: number): number {
  const need = TL_CHROME + Math.max(2, tracks) * TL_LANE;
  return clampTimelineRow(Math.min(0.5 * room, Math.max(0.4 * room, need)), room);
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

/* Phone portrait (UX r15 D7): the grab bar moves the PICTURE's height (the timeline takes what is left). The size is kept as a share of the workspace height. */
const PV_KEY = "overcut.layout.phonePreview";
/** The picture keeps at least this share of the workspace height, and the timeline at least `MIN_PHONE_TIMELINE` px (toolbar, ruler and a lane or two). */
export const MIN_PREVIEW_SHARE = 0.3;
export const MIN_PHONE_TIMELINE = 260;
/**
 * A picture (canvas) height in px kept inside what the workspace allows. `room` = workspace height; `other` = everything that is neither the preview panel nor
 * the timeline (top rows, tool strip); `chrome` = the preview panel's height minus the picture (player bar, padding). The whole preview panel keeps
 * at least `MIN_PREVIEW_SHARE` of the room, the timeline at least `MIN_PHONE_TIMELINE` px.
 */
export function clampPicture(px: number, room: number, other: number, chrome: number): number {
  const max = Math.max(72, room - other - chrome - MIN_PHONE_TIMELINE);
  const min = Math.min(max, Math.max(72, Math.round(room * MIN_PREVIEW_SHARE) - chrome));
  return Math.round(Math.min(max, Math.max(min, px)));
}
/** Three or more tracks get a smaller default picture, so the timeline shows them all. */
export const MANY_TRACKS = 3;
export function readPictureShare(): number | null {
  try {
    const v = Number(localStorage.getItem(PV_KEY));
    return Number.isFinite(v) && v > 0 && v < 1 ? v : null;
  } catch { return null; }
}
export function writePictureShare(share: number | null): void {
  try {
    if (share === null) localStorage.removeItem(PV_KEY);
    else localStorage.setItem(PV_KEY, share.toFixed(4));
  } catch { /* storage unavailable: the size just is not remembered */ }
}
