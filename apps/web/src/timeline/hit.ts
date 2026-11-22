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
