/** Bottom-sheet detents of the phone tool panel (pure maths; the pointer handling is `SheetHandle.tsx`). */
export type Detent = "peek" | "half" | "full";
export const DETENTS: readonly Detent[] = ["peek", "half", "full"];

/** Sheet heights in px for a viewport of `vh` px: peek (about 30 %), half (about 52 %, as before) and full (everything between the top bar and the tool bar). */
export function detentHeights(vh: number, chrome = 56 + 68 + 12): Record<Detent, number> {
  const full = Math.max(240, vh - chrome);
  const half = Math.min(full, Math.min(0.52 * vh, 440));
  const peek = Math.min(half - 60, Math.max(220, Math.min(0.34 * vh, 300)));
  return { peek: Math.max(160, peek), half: Math.max(half, peek + 60), full: Math.max(full, half + 60) };
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
