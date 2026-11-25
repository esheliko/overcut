/** Track header geometry (the gutter of the canvas timeline): where the kind chip, name and the four switches sit in a lane. Pure; shared by the painter and the pointer code.
 *  Wide (mouse): name on the first row, four 28 x 22 switches on the second. Compact (touch / narrow): chip and a short name, the switches that are ON shown as
 *  small indicators, and the whole header is ONE target (>= 44 px) that opens the track menu. */
import { LANE, type View } from "./view";

export type Toggle = "mute" | "solo" | "lock" | "hide";
export type HeaderPart = Toggle | "name";
export const TOGGLES: readonly Toggle[] = ["mute", "solo", "lock", "hide"];
/** The switches a track of `kind` (0 video, 1 audio) shows: a video clip's sound lives on its linked audio track, so video headers carry only lock and hide.
 *  They keep the slots of the audio headers (slots 2 and 3) so lock and hide sit in the same place on every track. */
export const togglesFor = (kind: number): readonly Toggle[] => (kind === 1 ? TOGGLES : TOGGLES.slice(2));

/** Switch rectangles of the wide header, relative to the lane's top-left. */
export const SW = { x0: 8, w: 28, h: 22, gap: 4, y: 26 } as const;
export const switchX = (i: number) => SW.x0 + i * (SW.w + SW.gap);
/** Indicator slots of the compact header (state glyphs under the name). */
export const IND = { x0: 8, size: 12, gap: 3, y: 33 } as const;

/** Which part of a header is at (x, yInLane), or null outside the header column. */
export function headerPart(v: View, x: number, yInLane: number, kind: number): HeaderPart | null {
  const g = v.gutter ?? 48;
  if (x < 0 || x >= g || yInLane < 0 || yInLane >= LANE) return null;
  if (v.compact) return "name";
  if (yInLane >= SW.y - 2) {
    for (const part of togglesFor(kind)) {
      const sx = switchX(TOGGLES.indexOf(part));
      if (x >= sx - 1 && x < sx + SW.w + 1) return part;
    }
  }
  return "name";
}
