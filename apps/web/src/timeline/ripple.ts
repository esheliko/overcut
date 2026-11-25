/** Pure planning for the ripple / roll / slip / slide tools (TL-04, M2-045): limits and the engine ops. Never mutates; the engine owns the project (ADR 0006).
 *  All values are integer ticks. The engine refuses an edit that does not fit whole, so every range here is conservative (rounded inwards).
 *  Linked partners (picture + sound) get the same edit in the same op list, because the engine does not read links; the range is what ALL of them allow. */
import type { Op } from "@app/engine-client";
import { partnersOf, snapDelta } from "./edit";
import type { Scene } from "./scene";

export type Tool = "select" | "ripple" | "roll" | "slip" | "slide";
export const TOOLS: readonly Tool[] = ["select", "ripple", "roll", "slip", "slide"];

export interface Range { lo: number; hi: number }

/** Clip `i` and its linked partners on unlocked tracks. */
export const group = (scene: Scene, i: number): number[] => [i, ...partnersOf(scene, i).filter((j) => !scene.trackLocked[scene.clipTrack[j]!])];

const speed = (scene: Scene, i: number) => ({ num: scene.speedNum[i]! || 1, den: scene.speedDen[i]! || 1 });
const endOf = (scene: Scene, i: number) => scene.tStart[i]! + scene.tDur[i]!;
/** Timeline ticks of source available before the clip's first frame. */
const reveal = (scene: Scene, i: number) => { const { num, den } = speed(scene, i); return Math.floor((scene.tSrcIn[i]! * den) / num); };
/** Timeline ticks of source available after the clip's last frame (Infinity when the media length is unknown). */
const tailRoom = (scene: Scene, i: number) => {
  const md = scene.mediaDur[i]!;
  if (!(md > 0)) return Infinity;
  const { num, den } = speed(scene, i);
  return Math.max(0, Math.floor(((md - scene.tSrcIn[i]!) * den) / num) - scene.tDur[i]!);
};

/** The range every clip in the group allows, as the intersection of `of(j)`. */
function across(scene: Scene, i: number, of: (j: number) => Range | null): Range | null {
  let lo = -Infinity, hi = Infinity;
  for (const j of group(scene, i)) {
    const r = of(j);
    if (!r) return null;
    lo = Math.max(lo, r.lo); hi = Math.min(hi, r.hi);
  }
  return lo <= hi ? { lo, hi } : { lo: 0, hi: 0 };
}

// ---- ripple delete / close gap ----

/** One `ripple_delete` per clip: the clips after it move earlier on its own track. A linked pair that is selected together ripples each track by the same length. */
export const rippleDeleteOps = (scene: Scene, sel: readonly number[]): Op[] => sel.map((i) => ({ op: "ripple_delete" as const, clip: scene.id[i]! }));

/** `close_gap` for the empty stretch just before each clip of the first selected clip's group (the gap before the first clip counts too). Empty when there is no gap. */
export function closeGapOps(scene: Scene, sel: readonly number[]): Op[] {
  if (sel.length === 0) return [];
  const ops: Op[] = [];
  for (const j of group(scene, sel[0]!)) {
    const t = scene.clipTrack[j]!, lo = scene.trackFirst[t]!;
    const prevEnd = j > lo ? endOf(scene, j - 1) : 0;
    if (scene.tStart[j]! > prevEnd) ops.push({ op: "close_gap", track: scene.trackId[t]!, at: Math.floor((prevEnd + scene.tStart[j]!) / 2) });
  }
  return ops;
}

// ---- ripple trim ----

/** Allowed ripple-trim delta (ticks, positive = later) of one edge: the clip keeps at least a frame and stays inside its media; neighbours simply shift. */
export function rippleRange(scene: Scene, i: number, edge: "start" | "end"): Range | null {
  if (scene.trackLocked[scene.clipTrack[i]!]) return null;
  const ft = scene.frameTicks;
  return across(scene, i, (j) => (edge === "end" ? { lo: -(scene.tDur[j]! - ft), hi: tailRoom(scene, j) } : { lo: -reveal(scene, j), hi: scene.tDur[j]! - ft }));
}
export const rippleTrimOps = (scene: Scene, i: number, edge: "start" | "end", delta: number): Op[] =>
  group(scene, i).map((j) => ({ op: "ripple_trim" as const, clip: scene.id[j]!, edge: edge === "start" ? ("in" as const) : ("out" as const), delta }));

// ---- roll ----

/** The two clips whose shared cut the edge of clip `i` is: [left, right] on the same track, touching; null when the edge has no touching neighbour. */
export function cutAt(scene: Scene, i: number, edge: "start" | "end"): [number, number] | null {
  const t = scene.clipTrack[i]!, lo = scene.trackFirst[t]!, hi = scene.trackFirst[t + 1]!;
  if (edge === "start") return i > lo && endOf(scene, i - 1) === scene.tStart[i]! ? [i - 1, i] : null;
  return i + 1 < hi && endOf(scene, i) === scene.tStart[i + 1]! ? [i, i + 1] : null;
}

/** Cuts to roll together: the dragged one plus the matching cut of each unlocked linked partner (partners without a touching neighbour are left out). */
export function rollCuts(scene: Scene, i: number, edge: "start" | "end"): [number, number][] {
  const out: [number, number][] = [];
  for (const j of group(scene, i)) {
    const c = cutAt(scene, j, edge);
    if (c && !scene.trackLocked[scene.clipTrack[c[0]]!] && !scene.trackLocked[scene.clipTrack[c[1]]!]) out.push(c);
  }
  return out;
}

/** Allowed roll delta (ticks, positive = later) for one cut. */
export function rollRange(scene: Scene, [l, r]: [number, number]): Range {
  const ft = scene.frameTicks;
  return { lo: -Math.min(scene.tDur[l]! - ft, reveal(scene, r)), hi: Math.min(scene.tDur[r]! - ft, tailRoom(scene, l)) };
}
export function rollRangeAll(scene: Scene, cuts: readonly [number, number][]): Range {
  let lo = -Infinity, hi = Infinity;
  for (const c of cuts) { const r = rollRange(scene, c); lo = Math.max(lo, r.lo); hi = Math.min(hi, r.hi); }
  return lo <= hi ? { lo, hi } : { lo: 0, hi: 0 };
}
export const rollOps = (scene: Scene, cuts: readonly [number, number][], delta: number): Op[] =>
  cuts.map(([l, r]) => ({ op: "roll" as const, left: scene.id[l]!, right: scene.id[r]!, to: scene.tStart[r]! + delta }));

// ---- slip ----

/** Allowed slip delta (timeline ticks, positive = later in the source, content moves left): the clip's source window stays inside its media. */
export function slipRange(scene: Scene, i: number): Range | null {
  if (scene.trackLocked[scene.clipTrack[i]!]) return null;
  return across(scene, i, (j) => ({ lo: -reveal(scene, j), hi: tailRoom(scene, j) }));
}
/** `slip` ops for a timeline-tick delta (converted to source ticks by each clip's speed). */
export const slipOps = (scene: Scene, i: number, delta: number): Op[] =>
  group(scene, i).map((j) => { const { num, den } = speed(scene, j); return { op: "slip" as const, clip: scene.id[j]!, delta: Math.round((delta * num) / den) }; });

// ---- slide ----

/** Allowed slide delta (ticks) of one clip: a touching neighbour gives or takes the difference, a non-touching one (or the start of the track) is a wall. */
function slideOwn(scene: Scene, j: number): Range {
  const ft = scene.frameTicks, t = scene.clipTrack[j]!, first = scene.trackFirst[t]!, last = scene.trackFirst[t + 1]!;
  const s = scene.tStart[j]!, e = endOf(scene, j);
  let lo: number, hi: number;
  if (j > first) {
    const l = j - 1, le = endOf(scene, l);
    if (le === s) { lo = -(scene.tDur[l]! - ft); hi = tailRoom(scene, l); } else { lo = -(s - le); hi = Infinity; }
  } else { lo = -s; hi = Infinity; }
  if (j + 1 < last) {
    const r = j + 1, rs = scene.tStart[r]!;
    if (rs === e) { lo = Math.max(lo, -reveal(scene, r)); hi = Math.min(hi, scene.tDur[r]! - ft); } else hi = Math.min(hi, rs - e);
  }
  return { lo, hi };
}
export function slideRange(scene: Scene, i: number): Range | null {
  if (scene.trackLocked[scene.clipTrack[i]!]) return null;
  return across(scene, i, (j) => slideOwn(scene, j));
}
export const slideOps = (scene: Scene, i: number, delta: number): Op[] =>
  group(scene, i).map((j) => ({ op: "slide" as const, clip: scene.id[j]!, delta }));

/** A drag of `d` ticks snapped to whole frames inside `r`. */
export const snapTo = (scene: Scene, d: number, r: Range): number => snapDelta(d, r.lo, r.hi, scene.frameTicks);
