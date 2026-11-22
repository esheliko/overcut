/** Pure hit-testing for the canvas timeline; reused by M1-034 editing. No DOM. */
import { firstEndingAfter, type Scene } from "./scene";
import { GUTTER, LANE, RULER, xToTime, type View } from "./view";

export type Hit =
  | { kind: "ruler"; time: number }
  | { kind: "gutter"; track: number }
  | { kind: "clip"; track: number; clip: number; time: number; edge: "start" | "end" | null }
  | { kind: "track"; track: number; time: number }
  | { kind: "empty"; time: number };

/** Track row under a canvas y, or -1. */
export function trackAtY(scene: Scene, v: View, y: number): number {
  if (y < RULER) return -1;
  const t = Math.floor((y - RULER + v.scrollY) / LANE);
  return t >= 0 && t < scene.trackCount ? t : -1;
}

/** Clip containing `sec` in a track (binary search), or -1. */
export function clipAtTime(scene: Scene, track: number, sec: number): number {
  const lo = scene.trackFirst[track]!;
  const hi = scene.trackFirst[track + 1]!;
  const i = firstEndingAfter(scene, lo, hi, sec);
  return i < hi && scene.start[i]! <= sec ? i : -1;
}

/** `edgePx`: grab zone at each clip edge (use ~16 for touch). */
export function hitTest(scene: Scene, v: View, x: number, y: number, edgePx = 8): Hit {
  const time = xToTime(v, x);
  if (y < RULER) return x < GUTTER ? { kind: "empty", time } : { kind: "ruler", time };
  const track = trackAtY(scene, v, y);
  if (track < 0) return { kind: "empty", time };
  if (x < GUTTER) return { kind: "gutter", track };
  const clip = clipAtTime(scene, track, time);
  if (clip < 0) return { kind: "track", track, time };
  const edge = (x - (GUTTER + scene.start[clip]! * v.pps - v.scrollX) <= edgePx) ? "start"
    : ((GUTTER + scene.end[clip]! * v.pps - v.scrollX) - x <= edgePx ? "end" : null);
  return { kind: "clip", track, clip, time, edge };
}

/** Total width of a trim handle's grab zone in CSS px: 44 for touch (the minimum touch target), 16 for a mouse or pen. */
export const HANDLE_TOUCH = 44;
export const HANDLE_MOUSE = 16;

/** Trim handle under (x, y) among the clips flagged in `selected`, or null. The zone straddles the edge: up to half of it
 *  inside the clip (never more than a third of the clip, so a narrow clip keeps a body to grab) and the rest outside, so it is
 *  always `zone` px wide and stays usable however narrow the clip is. The nearest edge wins where two zones overlap. */
export function handleAt(scene: Scene, v: View, selected: Uint8Array, x: number, y: number, touch: boolean): { clip: number; edge: "start" | "end" } | null {
  const track = trackAtY(scene, v, y);
  if (track < 0 || x < GUTTER) return null;
  const zone = touch ? HANDLE_TOUCH : HANDLE_MOUSE;
  const lo = scene.trackFirst[track]!, hi = scene.trackFirst[track + 1]!;
  const t = xToTime(v, x), reach = zone / v.pps;
  let best: { clip: number; edge: "start" | "end" } | null = null, bestD = Infinity;
  for (let i = firstEndingAfter(scene, lo, hi, t - reach); i < hi && scene.start[i]! - reach <= t; i++) {
    if (!selected[i]) continue;
    const w = (scene.end[i]! - scene.start[i]!) * v.pps;
    const inside = Math.min(zone / 2, w / 3), outside = zone - inside;
    const x0 = GUTTER + scene.start[i]! * v.pps - v.scrollX, x1 = x0 + w;
    const ds = Math.abs(x - x0), de = Math.abs(x - x1);
    if (x >= x0 - outside && x <= x0 + inside && ds < bestD) { best = { clip: i, edge: "start" }; bestD = ds; }
    if (x >= x1 - inside && x <= x1 + outside && de < bestD) { best = { clip: i, edge: "end" }; bestD = de; }
  }
  return best;
}
