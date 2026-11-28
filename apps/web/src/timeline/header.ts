/** Track header geometry (the gutter of the canvas timeline): where the kind chip, name and the four switches sit in a lane. Pure; shared by the painter and the pointer code.
 *  Wide (mouse): kind chip, name and four 22 x 22 switches on ONE row (the switches right aligned). Compact (touch / narrow): chip and a short name, the switches that are ON shown as
 *  small indicators, and the whole header is ONE target (>= 44 px) that opens the track menu. */
import { LANE, type View } from "./view";

export type Toggle = "mute" | "solo" | "lock" | "hide";
export type HeaderPart = Toggle | "name";
export const TOGGLES: readonly Toggle[] = ["mute", "solo", "lock", "hide"];
/** The switches a track of `kind` (0 video, 1 audio) shows: a video clip's sound lives on its linked audio track, so video headers carry only lock and hide.
 *  They keep the slots of the audio headers (slots 2 and 3) so lock and hide sit in the same place on every track. */
export const togglesFor = (kind: number): readonly Toggle[] => (kind === 1 ? TOGGLES : TOGGLES.slice(2));

/** Switch rectangles of the wide header, relative to the lane's top-left: one row, right aligned, centred in the lane (V-15). Slot `i` of `TOGGLES` in a header `g` px wide. */
export const SW = { w: 22, h: 22, gap: 2, y: 19, padR: 6 } as const;
export const switchX = (i: number, g: number) => g - SW.padR - (TOGGLES.length - i) * (SW.w + SW.gap) + SW.gap;
/** Indicator slots of the compact header (state glyphs under the name). */
export const IND = { x0: 6, size: 16, gap: 2, y: 38 } as const;

/** Which part of a header is at (x, yInLane), or null outside the header column. */
export function headerPart(v: View, x: number, yInLane: number, kind: number): HeaderPart | null {
  const g = v.gutter ?? 48;
  if (x < 0 || x >= g || yInLane < 0 || yInLane >= LANE) return null;
  if (v.compact) return "name";
  if (yInLane >= SW.y - 3 && yInLane < SW.y + SW.h + 3) {
    for (const part of togglesFor(kind)) {
      const sx = switchX(TOGGLES.indexOf(part), g);
      if (x >= sx - 1 && x < sx + SW.w + 1) return part;
    }
  }
  return "name";
}
