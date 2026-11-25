/** Where a dragged selection lands (M2 drag-to-move). Pure, no DOM: the pointer handler (`interact.ts`) calls these on every move.
 *  `snapMove` pulls the selection's edges onto clip edges, the playhead and 0:00; `planHop` lets a clip jump over its neighbours (reorder)
 *  instead of stopping against them. Both are kept here so the engine's own snapping can replace `snapMove` later without touching the gesture code. */
import type { Op } from "@app/engine-client";
import { TICKS_PER_SECOND as TPS, type Scene } from "./scene";

/** Snap reach on screen, in CSS px (a fingertip-friendly pull that still lets you place a clip a frame away from an edge). */
export const SNAP_PX = 8;

export interface SnapResult {
  /** The shift to apply, in ticks. */
  delta: number;
  /** The timeline tick the selection snapped to (draw a guide there), or null when nothing was close. */
  guide: number | null;
}

/** Candidate targets: every unselected clip's start and end, the playhead and 0:00. */
function targets(scene: Scene, sel: readonly number[], playhead: number | null): number[] {
  const skip = new Set(sel);
  const out: number[] = [0];
  if (playhead !== null) out.push(playhead);
  for (let i = 0; i < scene.clipCount; i++) {
    if (skip.has(i)) continue;
    out.push(scene.tStart[i]!, scene.tStart[i]! + scene.tDur[i]!);
  }
  return out;
}

/** The selection's first start and last end, in ticks. */
export function span(scene: Scene, sel: readonly number[]): { start: number; end: number } {
  let start = Infinity, end = -Infinity;
  for (const i of sel) {
    start = Math.min(start, scene.tStart[i]!);
    end = Math.max(end, scene.tStart[i]! + scene.tDur[i]!);
  }
  return { start, end };
}

/** `delta` (already frame-snapped and clamped to `[lo, hi]`) pulled onto the nearest edge or playhead within `reach` ticks. */
export function snapMove(scene: Scene, sel: readonly number[], delta: number, lo: number, hi: number, playhead: number | null, reach: number): SnapResult {
  if (sel.length === 0) return { delta, guide: null };
  const s = span(scene, sel);
  let best: SnapResult = { delta, guide: null };
  let bestD = reach + 1;
  for (const c of targets(scene, sel, playhead)) {
    for (const edge of [s.start + delta, s.end + delta]) {
      const d = c - edge;
      if (Math.abs(d) < bestD && delta + d >= lo && delta + d <= hi) { bestD = Math.abs(d); best = { delta: delta + d, guide: c }; }
    }
  }
  return best;
}

/** What a hop looks like: `n` > 0 jumps over the next `n` clips to the right, `n` < 0 over the previous ones. */
export interface Hop {
  n: number;
  /** Ticks every selected clip shifts by (the neighbours' total length, signed). */
  shift: number;
  /** The tick where the moved block now meets the neighbours (for the guide line). */
  edge: number;
}

interface TrackPlan { sel: number[]; next: number[]; prev: number[] }

/** Per track: the selected clips and the unselected neighbours on each side. Null when an unselected clip sits between selected ones on a track (a hop would be ambiguous). */
function plans(scene: Scene, sel: readonly number[]): Map<number, TrackPlan> | null {
  const skip = new Set(sel);
  const by = new Map<number, TrackPlan>();
  for (const i of sel) {
    const t = scene.clipTrack[i]!;
    if (!by.has(t)) by.set(t, { sel: [], next: [], prev: [] });
    by.get(t)!.sel.push(i);
  }
  for (const [t, p] of by) {
    p.sel.sort((a, b) => scene.tStart[a]! - scene.tStart[b]!);
    const lo = scene.trackFirst[t]!, hi = scene.trackFirst[t + 1]!;
    const first = scene.tStart[p.sel[0]!]!;
    const last = scene.tStart[p.sel[p.sel.length - 1]!]! + scene.tDur[p.sel[p.sel.length - 1]!]!;
    for (let j = lo; j < hi; j++) {
      if (skip.has(j)) continue;
      const s = scene.tStart[j]!, e = s + scene.tDur[j]!;
      if (s >= last) p.next.push(j);
      else if (e <= first) p.prev.unshift(j); // nearest first
      else return null;
    }
  }
  return by;
}

/**
 * Clips jumped over when the selection is dragged `dx` ticks: one more neighbour for each whose middle the leading edge has passed.
 * Several tracks (a picture and its linked sound) hop together only while their neighbours are the same length, so they stay in sync.
 * Returns null when the selection should stay a plain move.
 */
export function planHop(scene: Scene, sel: readonly number[], dx: number, lead: number): Hop | null {
  if (sel.length === 0 || dx === 0) return null;
  const by = plans(scene, sel);
  if (!by) return null;
  const dir = dx > 0 ? "next" : "prev";
  const mine = by.get(scene.clipTrack[lead]!);
  if (!mine) return null;
  const s = span(scene, mine.sel);
  let n = 0, shift = 0;
  for (;;) {
    const j = mine[dir][n];
    if (j === undefined) break;
    const mid = scene.tStart[j]! + scene.tDur[j]! / 2;
    const passed = dir === "next" ? s.end + dx >= mid : s.start + dx <= mid;
    if (!passed) break;
    let same = true;
    for (const p of by.values()) if (p[dir][n] === undefined || scene.tDur[p[dir][n]!] !== scene.tDur[j]) same = false;
    if (!same) break;
    shift += scene.tDur[j]!;
    n++;
  }
  if (n === 0) return null;
  return dir === "next" ? { n, shift, edge: s.end + shift } : { n: -n, shift: -shift, edge: s.start - shift };
}

/** Ops for a hop: the jumped clips go out of the way, the selection shifts, the jumped clips settle where it was. One undo step. */
export function hopOps(scene: Scene, sel: readonly number[], n: number): Op[] {
  const by = plans(scene, sel);
  if (!by || n === 0) return [];
  const right = n > 0, k = Math.abs(n);
  let farEnd = 0;
  for (let i = 0; i < scene.clipCount; i++) farEnd = Math.max(farEnd, scene.tStart[i]! + scene.tDur[i]!);
  const park = farEnd + TPS; // empty room past everything, so no step overlaps
  const move = (i: number, start: number): Op => ({ op: "move", clip: scene.id[i]!, track: scene.trackId[scene.clipTrack[i]!]!, start });
  const back: Op[] = [];
  const away: Op[] = [];
  const mid: Op[] = [];
  let shift = 0;
  for (const p of by.values()) {
    const jumped = (right ? p.next : p.prev).slice(0, k);
    shift = jumped.reduce((a, j) => a + scene.tDur[j]!, 0);
    let at = park;
    for (const j of jumped) { away.push(move(j, at)); at += scene.tDur[j]!; }
    const first = scene.tStart[p.sel[0]!]!;
    const lastI = p.sel[p.sel.length - 1]!;
    const last = scene.tStart[lastI]! + scene.tDur[lastI]!;
    const ordered = right ? [...p.sel].reverse() : p.sel; // lead with the clip that moves into free room
    for (const i of ordered) mid.push(move(i, scene.tStart[i]! + (right ? shift : -shift)));
    // The jumped clips settle in their original order, packed on the side the selection left.
    let to = right ? first : last - shift;
    const settle = right ? jumped : [...jumped].reverse();
    for (const j of settle) { back.push(move(j, to)); to += scene.tDur[j]!; }
  }
  return [...away, ...mid, ...back];
}

/** Keyboard reorder: the selection hops over ONE neighbour (`dir` 1 = later). Empty when there is none (or linked tracks' neighbours differ in length, as in a drag). */
export function hopStep(scene: Scene, sel: readonly number[], dir: 1 | -1): Op[] {
  const by = plans(scene, sel);
  if (!by || by.size === 0) return [];
  let len = -1;
  for (const p of by.values()) {
    const j = (dir > 0 ? p.next : p.prev)[0];
    if (j === undefined || (len >= 0 && scene.tDur[j] !== len)) return [];
    len = scene.tDur[j]!;
  }
  return hopOps(scene, sel, dir);
}

/** Where a media item dropped at `tick` lands: pulled onto the nearest clip edge, the playhead or 0:00 within `reach`, else on a whole frame. */
export function snapDrop(scene: Scene, tick: number, playhead: number | null, reach: number, frameTicks: number): SnapResult {
  let best: SnapResult = { delta: Math.max(0, Math.round(tick / frameTicks) * frameTicks), guide: null };
  let bestD = reach + 1;
  for (const c of targets(scene, [], playhead)) {
    const d = Math.abs(c - tick);
    if (d < bestD) { bestD = d; best = { delta: c, guide: c }; }
  }
  return best;
}
