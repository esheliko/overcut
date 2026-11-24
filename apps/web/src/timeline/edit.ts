/** Pure editing logic for the canvas timeline (M1-034): limits, snapping to whole frames, and the `Op`s to send to `Engine.editing`.
 *  Never mutates anything: the UI computes what to ask for, the engine decides and owns the project (ADR 0006).
 *  Times are integer ticks here (Float64 holds them exactly); the canvas converts to seconds for drawing only. */
import type { Op } from "@app/engine-client";
import { firstEndingAfter, TICKS_PER_SECOND as TPS, type Scene } from "./scene";

export const clampN = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Snap a desired shift of `d` ticks to a whole number of frames inside [lo, hi] (lo <= 0 <= hi expected). */
export function snapDelta(d: number, lo: number, hi: number, ft: number): number {
  const kmin = Math.ceil(lo / ft), kmax = Math.floor(hi / ft);
  if (kmin > kmax) return 0;
  return clampN(Math.round(d / ft), kmin, kmax) * ft;
}

/** 1 for every index in `sel`, else 0. */
export function flagsOf(scene: Scene, sel: readonly number[]): Uint8Array {
  const f = new Uint8Array(scene.clipCount);
  for (const i of sel) f[i] = 1;
  return f;
}

/** Scene indices of clips whose ids are in `ids`, ascending. */
export function indicesOf(scene: Scene, ids: ReadonlySet<string>): number[] {
  const out: number[] = [];
  if (ids.size === 0) return out;
  for (let i = 0; i < scene.clipCount; i++) if (ids.has(scene.id[i]!)) out.push(i);
  return out;
}

export const idsOf = (scene: Scene, sel: readonly number[]): string[] => sel.map((i) => scene.id[i]!);

/** How far (ticks) the selection can move earlier (`left`) and later (`right`) on its tracks without touching a clip that is not selected or going below 0. */
export function moveRoom(scene: Scene, sel: readonly number[], flags: Uint8Array = flagsOf(scene, sel)): { left: number; right: number } {
  let left = Infinity, right = Infinity;
  for (const i of sel) {
    const t = scene.clipTrack[i]!;
    const lo = scene.trackFirst[t]!, hi = scene.trackFirst[t + 1]!;
    let j = i - 1;
    while (j >= lo && flags[j]) j--;
    left = Math.min(left, scene.tStart[i]! - (j >= lo ? scene.tStart[j]! + scene.tDur[j]! : 0));
    let k = i + 1;
    while (k < hi && flags[k]) k++;
    if (k < hi) right = Math.min(right, scene.tStart[k]! - (scene.tStart[i]! + scene.tDur[i]!));
  }
  return { left: Math.max(0, left), right: Math.max(0, right) };
}

/** Selected clips that may be edited (not on a locked track). */
export const editable = (scene: Scene, sel: readonly number[]) => sel.filter((i) => !scene.trackLocked[scene.clipTrack[i]!]);

/** Ops that shift the selection by `delta` ticks (already snapped and clamped). Ordered so no step overlaps a not-yet-moved selected neighbour. */
export function moveOps(scene: Scene, sel: readonly number[], delta: number): Op[] {
  const ops: Op[] = [];
  const order = delta > 0 ? [...sel].reverse() : sel;
  for (const i of order) ops.push({ op: "move", clip: scene.id[i]!, track: scene.trackId[scene.clipTrack[i]!]!, start: scene.tStart[i]! + delta });
  return ops;
}

/** Op that moves one clip to another track at the same time offset. */
export function moveToTrackOp(scene: Scene, i: number, track: number, delta: number): Op {
  return { op: "move", clip: scene.id[i]!, track: scene.trackId[track]!, start: scene.tStart[i]! + delta };
}

/** Can clip `i` (shifted by `delta`) sit on `track` without overlapping anything there? Kind must match and the track be unlocked. */
export function fitsOnTrack(scene: Scene, i: number, track: number, delta: number): boolean {
  if (track < 0 || track >= scene.trackCount || scene.trackLocked[track] || scene.trackKind[track] !== scene.trackKind[scene.clipTrack[i]!]) return false;
  const s = scene.tStart[i]! + delta, e = s + scene.tDur[i]!;
  if (s < 0) return false;
  const lo = scene.trackFirst[track]!, hi = scene.trackFirst[track + 1]!;
  for (let k = firstEndingAfter(scene, lo, hi, (s + 1) / TPS); k < hi && scene.tStart[k]! < e; k++) {
    if (k !== i && scene.tStart[k]! < e && scene.tStart[k]! + scene.tDur[k]! > s) return false;
  }
  return true;
}

export type Edge = "start" | "end";

/** Allowed range (ticks) of the boundary being trimmed: neighbours, source media, and at least one frame left. */
export function trimRange(scene: Scene, i: number, edge: Edge): { min: number; max: number; at: number } {
  const t = scene.clipTrack[i]!, lo = scene.trackFirst[t]!, hi = scene.trackFirst[t + 1]!;
  const s = scene.tStart[i]!, e = s + scene.tDur[i]!, ft = scene.frameTicks;
  const num = scene.speedNum[i]! || 1, den = scene.speedDen[i]! || 1;
  if (edge === "start") {
    const prevEnd = i > lo ? scene.tStart[i - 1]! + scene.tDur[i - 1]! : 0;
    const reveal = Math.floor((scene.tSrcIn[i]! * den) / num); // timeline ticks of source available before the clip
    return { min: Math.max(prevEnd, s - reveal), max: e - ft, at: s };
  }
  const nextStart = i + 1 < hi ? scene.tStart[i + 1]! : Infinity;
  const md = scene.mediaDur[i]!;
  const tail = md > 0 ? s + Math.floor(((md - scene.tSrcIn[i]!) * den) / num) : Infinity;
  return { min: s + ft, max: Math.min(nextStart, tail), at: e };
}

/** The boundary value (ticks) closest to `desired` that is a whole number of frames from the original and inside the range. */
export function trimTarget(scene: Scene, i: number, edge: Edge, desired: number): number {
  const r = trimRange(scene, i, edge);
  return r.at + snapDelta(desired - r.at, r.min - r.at, r.max - r.at, scene.frameTicks);
}

export function trimOp(scene: Scene, i: number, edge: Edge, value: number): Op {
  return edge === "start" ? { op: "trim_in", clip: scene.id[i]!, start: value } : { op: "trim_out", clip: scene.id[i]!, end: value };
}

/** Deleting or start-trimming the first thing in the project would leave an empty stretch before everything else, and the export would
 *  start with black and silence. For an edit made only of delete / trim ops that moved the project's first start later, append moves
 *  that slide every remaining clip left by that amount (same undo step). Anything else, or a locked track in the way: `ops` unchanged. */
export function closeStartGap(scene: Scene, ops: Op[]): Op[] {
  const n = scene.clipCount;
  if (n === 0 || !ops.some((o) => o.op === "delete" || o.op === "trim_in")) return ops;
  const index = new Map<string, number>();
  for (let i = 0; i < n; i++) index.set(scene.id[i]!, i);
  const start = Array.from(scene.tStart.subarray(0, n)), gone = new Set<number>();
  let first = Infinity, touched = false;
  for (let i = 0; i < n; i++) first = Math.min(first, start[i]!);
  for (const o of ops) {
    if (o.op !== "delete" && o.op !== "trim_in" && o.op !== "trim_out") return ops;
    const i = index.get(o.clip);
    if (i === undefined) return ops;
    if (o.op === "delete") gone.add(i);
    else if (o.op === "trim_in") start[i] = o.start;
    if (o.op !== "trim_out" && scene.tStart[i]! === first) touched = true;
  }
  const rest = [...Array(n).keys()].filter((i) => !gone.has(i));
  if (!touched || rest.length === 0) return ops;
  const gap = Math.min(...rest.map((i) => start[i]!)) - first;
  if (gap <= 0 || rest.some((i) => scene.trackLocked[scene.clipTrack[i]!])) return ops;
  rest.sort((a, b) => start[a]! - start[b]!);
  return [...ops, ...rest.map((i): Op => ({ op: "move", clip: scene.id[i]!, track: scene.trackId[scene.clipTrack[i]!]!, start: start[i]! - gap }))];
}

/** Clips under `tick` (strictly inside, so both halves are non-empty), among `candidates` (all clips when null). */
export function splittable(scene: Scene, tick: number, candidates: readonly number[] | null): number[] {
  const out: number[] = [];
  const check = (i: number) => {
    if (scene.trackLocked[scene.clipTrack[i]!]) return;
    const s = scene.tStart[i]!, e = s + scene.tDur[i]!, ft = scene.frameTicks;
    if (tick >= s + ft && tick <= e - ft) out.push(i);
  };
  if (candidates) candidates.forEach(check);
  else for (let t = 0; t < scene.trackCount; t++) {
    const lo = scene.trackFirst[t]!, hi = scene.trackFirst[t + 1]!;
    const i = firstEndingAfter(scene, lo, hi, tick / TPS);
    if (i < hi) check(i);
  }
  return out;
}

export function splitOps(scene: Scene, clips: readonly number[], tick: number, newId: () => string): Op[] {
  return clips.map((i) => ({ op: "split" as const, clip: scene.id[i]!, at: tick, new_id: newId() }));
}

export const deleteOps = (scene: Scene, sel: readonly number[]): Op[] => sel.map((i) => ({ op: "delete" as const, clip: scene.id[i]! }));

/** A random id the model accepts: 32 lowercase hex chars. */
export function newClipId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Index of the clip on `track` nearest to second `sec` (the one containing it, else the closest edge), or -1 for an empty track. */
export function nearestClip(scene: Scene, track: number, sec: number): number {
  const lo = scene.trackFirst[track]!, hi = scene.trackFirst[track + 1]!;
  if (lo === hi) return -1;
  const i = firstEndingAfter(scene, lo, hi, sec);
  if (i < hi && scene.start[i]! <= sec) return i;
  if (i >= hi) return hi - 1;
  if (i === lo) return lo;
  return sec - scene.end[i - 1]! <= scene.start[i]! - sec ? i - 1 : i;
}

/** Keyboard navigation between clips: left/right along the track, up/down to the nearest clip on the neighbouring track. */
export function neighbour(scene: Scene, i: number, dir: "left" | "right" | "up" | "down"): number {
  const t = scene.clipTrack[i]!;
  if (dir === "left") return i > scene.trackFirst[t]! ? i - 1 : i;
  if (dir === "right") return i + 1 < scene.trackFirst[t + 1]! ? i + 1 : i;
  const to = dir === "up" ? t - 1 : t + 1;
  if (to < 0 || to >= scene.trackCount) return i;
  const j = nearestClip(scene, to, (scene.start[i]! + scene.end[i]!) / 2);
  return j < 0 ? i : j;
}

/** Clips intersecting the screen rectangle (canvas px), visible region only. `toTime`/`yToTrack` come from the view so this stays pure. */
export function inRect(scene: Scene, t0: number, t1: number, track0: number, track1: number): number[] {
  const out: number[] = [];
  for (let t = Math.max(0, track0); t <= Math.min(scene.trackCount - 1, track1); t++) {
    const lo = scene.trackFirst[t]!, hi = scene.trackFirst[t + 1]!;
    for (let i = firstEndingAfter(scene, lo, hi, t0); i < hi && scene.start[i]! < t1; i++) out.push(i);
  }
  return out;
}

/** A message for the live region as catalog key + values, so pure code stays language-free (the UI translates it). */
export interface Say { key: string; values?: Record<string, string | number> }

const tc = (sec: number) => `${Math.floor(sec / 60)}:${(sec % 60).toFixed(2).padStart(5, "0")}`;
/** Spoken description of a clip. */
export function describeClip(scene: Scene, i: number): Say {
  return { key: "timeline.say.clip", values: { name: scene.name[i]!, track: scene.trackName[scene.clipTrack[i]!]!, from: tc(scene.start[i]!), to: tc(scene.end[i]!) } };
}
