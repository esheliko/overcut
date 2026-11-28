/** Bottom-sheet detents of the phone tool panel (pure maths; the pointer handling is `SheetHandle.tsx`). */
export type Detent = "peek" | "half" | "full";
export const DETENTS: readonly Detent[] = ["peek", "half", "full"];

/**
 * Sheet heights in px for a viewport of `vh` px. The sheet never takes the whole screen: the picture and the timeline stay visible above it (the shell reflows to what is left; UX r16 PHONE-3).
 * peek (about 34 %: Edit and Speed open here, the first controls show under the handle and the picture, the ruler and the selected lane stay in view), half (about 55 %)
 * and full (everything except the top bar, the tool bar and a 130 px strip for the picture).
 */
export function detentHeights(vh: number, chrome = 56 + 68 + 12): Record<Detent, number> {
  const full = Math.max(260, vh - chrome - 130);
  const peek = Math.min(full - 120, Math.max(200, Math.min(0.34 * vh, 300)));
  const half = Math.min(full, Math.max(peek + 50, 0.55 * vh));
  const r = Math.round; // whole pixels: a fractional sheet height made the controls inside it 43.99 px tall
  return { peek: r(peek), half: r(Math.max(half, peek + 40)), full: r(Math.max(full, half + 40)) };
}

/**
 * Where a drag that ended at height `h` with vertical velocity `v` (px per ms, positive = moving down) settles: the detent nearest to where the
 * sheet was heading (the position it would reach 180 ms later), or "close" when that is well below the peek height.
 */
export function settle(h: number, v: number, heights: Record<Detent, number>): Detent | "close" {
  const target = h - v * 180;
  if (target < heights.peek * 0.7) return "close";
  let best: Detent = "peek";
  for (const d of DETENTS) if (Math.abs(heights[d] - target) < Math.abs(heights[best] - target)) best = d;
  return best;
}

/** One step up (+1) or down (-1) the detents, or null when already at the end (down from peek closes). */
export const stepDetent = (cur: Detent, dir: 1 | -1): Detent | null => DETENTS[DETENTS.indexOf(cur) + dir] ?? null;
