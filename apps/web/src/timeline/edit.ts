/** Pure editing logic for the canvas timeline (M1-034): limits, snapping to whole frames, and the `Op`s to send to `Engine.editing`.
 *  Never mutates anything: the UI computes what to ask for, the engine decides and owns the project (ADR 0006).
 *  Times are integer ticks here (Float64 holds them exactly); the canvas converts to seconds for drawing only. */
import { addTrackOp, newTrack, type Op } from "@app/engine-client";
import { newId } from "../media/plan";
import { firstEndingAfter, TICKS_PER_SECOND as TPS, type Scene } from "./scene";

export const clampN = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Snap a desired shift of `d` ticks to a whole number of frames inside [lo, hi] (lo <= 0 <= hi expected). */
export function snapDelta(d: number, lo: number, hi: number, ft: number): number {
  const kmin = Math.ceil(lo / ft), kmax = Math.floor(hi / ft);
  if (kmin > kmax) return 0;
  return clampN(Math.round(d / ft), kmin, kmax) * ft;
}

/** The other clips linked to clip `i` (empty when it is alone or its partners are gone). */
export function partnersOf(scene: Scene, i: number): number[] {
  const l = scene.link[i];
  return l ? scene.linkGroups.get(l)!.filter((j) => j !== i) : [];
}

/** `ids` plus the ids of every clip linked to one of them: selecting half of a link selects both. */
export function expandLinks(scene: Scene, ids: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const at = new Map<string, number>();
  for (let i = 0; i < scene.clipCount; i++) at.set(scene.id[i]!, i);
  for (const id of ids) {
    out.add(id);
    const i = at.get(id);
    if (i !== undefined) for (const j of partnersOf(scene, i)) out.add(scene.id[j]!);
  }
  return out;
}

/** One index per link group (the first) plus every unlinked clip: what "how many clips is this selection" means to the user. */
export function groupReps(scene: Scene, sel: readonly number[]): number[] {
  const seen = new Set<string>();
  return sel.filter((i) => { const l = scene.link[i]!; if (!l) return true; if (seen.has(l)) return false; seen.add(l); return true; });
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

/** Can clip `i` (shifted by `delta`) sit on `track` without overlapping anything there? Kind must match and the track be unlocked.
 *  `leaving` are clips that move away in the same edit: they do not count as obstacles. */
export function fitsOnTrack(scene: Scene, i: number, track: number, delta: number, leaving: readonly number[] = []): boolean {
  if (track < 0 || track >= scene.trackCount || scene.trackLocked[track] || scene.trackKind[track] !== scene.trackKind[scene.clipTrack[i]!]) return false;
  const s = scene.tStart[i]! + delta, e = s + scene.tDur[i]!;
  if (s < 0) return false;
  const lo = scene.trackFirst[track]!, hi = scene.trackFirst[track + 1]!;
  for (let k = firstEndingAfter(scene, lo, hi, (s + 1) / TPS); k < hi && scene.tStart[k]! < e; k++) {
    if (k !== i && scene.tStart[k]! < e && scene.tStart[k]! + scene.tDur[k]! > s && !leaving.includes(k)) return false;
  }
  return true;
}

/** Position of row `track` among the rows of its own kind (display order), and the row at position `ord` of `kind` (-1 when there is none). */
function kindOrdinal(scene: Scene, track: number): number {
  let n = 0;
  for (let t = 0; t < track; t++) if (scene.trackKind[t] === scene.trackKind[track]) n++;
  return n;
}
function kindRow(scene: Scene, kind: number, ord: number): number {
  let n = 0;
  for (let t = 0; t < scene.trackCount; t++) if (scene.trackKind[t] === kind && n++ === ord) return t;
  return -1;
}

/** A lane change: the selected clips of one kind (`movers`) and the row each lands on (`dest`, parallel). */
export interface LaneMove { movers: number[]; dest: number[] }

/** Dragging the selection onto row `track`: every selected clip of that row's kind moves by the same number of lanes of its kind
 *  (the first of them lands on `track`); all or nothing, so null when any would leave the stack or `track` is where they already are.
 *  Clips of the other kind (a linked sound) keep their own track. Fit and locks are checked by `laneShift`. */
export function laneChanger(scene: Scene, sel: readonly number[], track: number): LaneMove | null {
  const kind = scene.trackKind[track]!;
  const movers = sel.filter((i) => scene.trackKind[scene.clipTrack[i]!] === kind);
  if (movers.length === 0) return null;
  const d = kindOrdinal(scene, track) - kindOrdinal(scene, scene.clipTrack[movers[0]!]!);
  if (d === 0) return null;
  const dest: number[] = [];
  for (const i of movers) {
    const to = kindRow(scene, kind, kindOrdinal(scene, scene.clipTrack[i]!) + d);
    if (to < 0) return null;
    dest.push(to);
  }
  return { movers, dest };
}

/** The row each of `sel` shows on while a lane change is previewed (parallel to `sel`). */
export function laneTracks(scene: Scene, sel: readonly number[], mv: LaneMove): number[] {
  return sel.map((i) => { const k = mv.movers.indexOf(i); return k >= 0 ? mv.dest[k]! : scene.clipTrack[i]!; });
}

/** Moving the selection by about `dx` ticks with the movers changing lane: the shift (whole frames; the other selected clips keep their room), or null when any mover does not fit its new lane. */
export function laneShift(scene: Scene, sel: readonly number[], flags: Uint8Array, mv: LaneMove, dx: number): number | null {
  const rest = sel.filter((i) => !mv.movers.includes(i));
  const room = rest.length ? moveRoom(scene, rest, flags) : { left: Infinity, right: Infinity };
  let first = Infinity;
  for (const m of mv.movers) first = Math.min(first, scene.tStart[m]!);
  const d = snapDelta(dx, -Math.min(room.left, first), room.right, scene.frameTicks);
  return mv.movers.every((m, k) => fitsOnTrack(scene, m, mv.dest[k]!, d, mv.movers)) ? d : null;
}

/** Where a lane change lands, all of it: the shift, the row of every selected clip (parallel to `sel`; a row >= `scene.trackCount` is a NEW audio track) and how many new audio tracks it needs. */
export interface LanePlan { delta: number; to: number[]; fresh: number }

/** Like `laneShift`, but a linked SOUND does not hold the picture back: the picture lands at the dropped time and each sound goes to its own track when it is free
 *  there, else the first unlocked audio track that is, else a new one (A2 ...): the same rule as a drop from the bin (`soundLane.ts`). Null when a picture does not fit. */
export function lanePlan(scene: Scene, sel: readonly number[], flags: Uint8Array, mv: LaneMove, dx: number, vacate = false): LanePlan | null {
  const rest = sel.filter((i) => !mv.movers.includes(i));
  const sounds = scene.trackKind[mv.dest[0]!] === 0 && rest.every((i) => scene.trackKind[scene.clipTrack[i]!] === 1);
  if (!sounds) {
    const d = laneShift(scene, sel, flags, mv, dx);
    return d === null ? null : { delta: d, to: laneTracks(scene, sel, mv), fresh: 0 };
  }
  let first = Infinity;
  for (const i of sel) first = Math.min(first, scene.tStart[i]!);
  const delta = snapDelta(dx, -first, Infinity, scene.frameTicks);
  if (!mv.movers.every((m, k) => fitsOnTrack(scene, m, mv.dest[k]!, delta, mv.movers))) return null;
  const held = new Map<number, { s: number; e: number }[]>();
  const free = (row: number, s: number, e: number): boolean => {
    if (row < scene.trackCount) {
      if (scene.trackLocked[row]) return false;
      for (let k = scene.trackFirst[row]!; k < scene.trackFirst[row + 1]!; k++) {
        if (flags[k]) continue; // selected clips are all on the move
        if (scene.tStart[k]! < e && scene.tStart[k]! + scene.tDur[k]! > s) return false;
      }
    }
    return !(held.get(row) ?? []).some((h) => h.s < e && h.e > s);
  };
  const audioRows: number[] = [];
  for (let t = 0; t < scene.trackCount; t++) if (scene.trackKind[t] === 1) audioRows.push(t);
  let fresh = 0;
  const to = sel.map((i) => { const k = mv.movers.indexOf(i); return k >= 0 ? mv.dest[k]! : scene.clipTrack[i]!; });
  const order = rest.map((i) => sel.indexOf(i)).sort((a, b) => scene.tStart[sel[a]!]! - scene.tStart[sel[b]!]!);
  for (const n of order) {
    const i = sel[n]!, s = scene.tStart[i]! + delta, e = s + scene.tDur[i]!;
    const own = scene.clipTrack[i]!;
    // `vacate` (a clip lifted off the magnetic main track): its sound leaves its old lane too, so the hole can close on both without the sounds drifting from their pictures.
    const rows = [...(vacate ? [] : [own]), ...audioRows.filter((r) => !vacate || r !== own), ...Array.from({ length: fresh }, (_, f) => scene.trackCount + f)];
    let row = rows.find((r) => free(r, s, e));
    if (row === undefined) row = scene.trackCount + fresh++;
    to[n] = row;
    held.set(row, [...(held.get(row) ?? []), { s, e }]);
  }
  return { delta, to, fresh };
}

/** Ops for a lane change: the movers to their new tracks and time, the rest of the selection shifted in place (one undo step).
 *  Movers go furthest-first in the direction of travel, so a clip never lands on a lane its neighbour has not left yet. */
export function laneOps(scene: Scene, sel: readonly number[], mv: LaneMove, delta: number, plan?: LanePlan, ids: () => string = newId): Op[] {
  const rest = sel.filter((i) => !mv.movers.includes(i));
  const up = mv.dest[0]! < scene.clipTrack[mv.movers[0]!]!;
  const order = mv.movers.map((_, k) => k).sort((x, y) => (up ? 1 : -1) * (mv.dest[x]! - mv.dest[y]!));
  const lane = [...order.map((k) => moveToTrackOp(scene, mv.movers[k]!, mv.dest[k]!, delta))];
  if (!plan || (plan.fresh === 0 && rest.every((i) => plan.to[sel.indexOf(i)] === scene.clipTrack[i]))) return [...(rest.length ? moveOps(scene, rest, delta) : []), ...lane];
  const made: string[] = [], ops: Op[] = [];
  let audio = 0;
  for (let t = 0; t < scene.trackCount; t++) if (scene.trackKind[t] === 1) audio++;
  for (let f = 0; f < plan.fresh; f++) {
    made.push(ids());
    ops.push(addTrackOp(scene.sequenceId, newTrack(made[f]!, "audio", `A${audio + f + 1}`), scene.trackCount + f));
  }
  const sounds = (delta > 0 ? [...rest].reverse() : rest).map((i) => {
    const row = plan.to[sel.indexOf(i)]!;
    return { op: "move" as const, clip: scene.id[i]!, track: row >= scene.trackCount ? made[row - scene.trackCount]! : scene.trackId[row]!, start: scene.tStart[i]! + delta };
  });
  return [...ops, ...sounds, ...lane];
}

/** One lane up (`up`: toward the top of the stack) or down for the selection: the picture clips when any are selected (a linked sound keeps its track), else the sound clips.
 *  They must all sit on one track and fit unchanged at their times on the nearest unlocked lane of the same kind; null when there is no such lane or no room. */
export function laneStepOps(scene: Scene, sel: readonly number[], dir: "up" | "down"): { ops: Op[]; track: number } | null {
  const video = sel.filter((i) => scene.trackKind[scene.clipTrack[i]!] === 0);
  const movers = video.length ? video : sel;
  if (movers.length === 0 || new Set(movers.map((i) => scene.clipTrack[i]!)).size !== 1) return null;
  const from = scene.clipTrack[movers[0]!]!, kind = scene.trackKind[from];
  let to = from + (dir === "up" ? -1 : 1);
  while (to >= 0 && to < scene.trackCount && (scene.trackKind[to] !== kind || scene.trackLocked[to])) to += dir === "up" ? -1 : 1;
  if (to < 0 || to >= scene.trackCount) return null;
  if (!movers.every((i) => fitsOnTrack(scene, i, to, 0))) return null;
  // Several clips moving together must not collide with each other either (they were on one track, so they did not overlap and still do not).
  return { ops: movers.map((i) => moveToTrackOp(scene, i, to, 0)), track: to };
}

export type Edge = "start" | "end";

/** Allowed range (ticks) of the boundary being trimmed: neighbours, source media, and at least one frame left. */
export function trimRange(scene: Scene, i: number, edge: Edge): { min: number; max: number; at: number } {
  const own = ownTrimRange(scene, i, edge);
  // A linked clip trims with its partners by the same amount, so the range is what ALL of them allow (a locked partner stays put and does not count).
  let lo = own.min - own.at, hi = own.max - own.at;
  for (const j of partnersOf(scene, i)) {
    if (scene.trackLocked[scene.clipTrack[j]!]) continue;
    const r = ownTrimRange(scene, j, edge);
    lo = Math.max(lo, r.min - r.at);
    hi = Math.min(hi, r.max - r.at);
  }
  return { min: own.at + lo, max: own.at + Math.max(lo, hi), at: own.at };
}

function ownTrimRange(scene: Scene, i: number, edge: Edge): { min: number; max: number; at: number } {
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

/** The same trim for clip `i` AND every unlocked clip linked to it, each moved by the same amount (one undo step): cutting the front of a clip cuts its sound too. */
export function linkedTrimOps(scene: Scene, i: number, edge: Edge, value: number): Op[] {
  const at = (j: number) => (edge === "start" ? scene.tStart[j]! : scene.tStart[j]! + scene.tDur[j]!);
  const d = value - at(i);
  return [trimOp(scene, i, edge, value), ...partnersOf(scene, i).filter((j) => !scene.trackLocked[scene.clipTrack[j]!]).map((j) => trimOp(scene, j, edge, at(j) + d))];
}

/** Rewrites single-clip trim ops (numeric timing) so the clip's linked partners are trimmed by the same amount; other ops pass through. */
export function mirrorTrims(scene: Scene, ops: Op[]): Op[] {
  const at = new Map<string, number>();
  for (let i = 0; i < scene.clipCount; i++) at.set(scene.id[i]!, i);
  return ops.flatMap((o) => {
    const i = o.op === "trim_in" || o.op === "trim_out" ? at.get(o.clip) : undefined;
    if (i === undefined) return [o];
    return o.op === "trim_in" ? linkedTrimOps(scene, i, "start", o.start) : o.op === "trim_out" ? linkedTrimOps(scene, i, "end", o.end) : [o];
  });
}

/** Ops that let the selected clips edit alone (`set_link` null), one per linked clip; empty when none is linked. */
export const unlinkOps = (scene: Scene, sel: readonly number[]): Op[] => sel.filter((i) => scene.link[i]).map((i) => ({ op: "set_link" as const, clip: scene.id[i]!, link: null }));

/** Why `linkOps` has nothing to do: "kinds" when the selection lacks a picture or a sound, "linked" when it is already one linked group. */
export type LinkWhy = "kinds" | "linked";
/** Ops that link the selected picture and sound clips into ONE group (UX r15: unlink had no way back): every selected clip gets the same new link id, so they select,
 *  move, trim and delete together from now on. Times stay as they are (the user lines them up first). Empty with the reason when it cannot apply. */
export function linkOps(scene: Scene, sel: readonly number[], id: string): { ops: Op[]; why: LinkWhy | null } {
  const kinds = new Set(sel.map((i) => scene.trackKind[scene.clipTrack[i]!]));
  if (kinds.size < 2) return { ops: [], why: "kinds" };
  const links = new Set(sel.map((i) => scene.link[i]!));
  if (links.size === 1 && !links.has("")) return { ops: [], why: "linked" };
  return { ops: sel.map((i) => ({ op: "set_link" as const, clip: scene.id[i]!, link: id })), why: null };
}

/** Deleting the first thing in the project would leave an empty stretch before everything else, and the export would start with
 *  black and silence. For an edit made only of delete / trim-end ops that moved the project's first start later, append moves that
 *  slide every remaining clip left by that amount (same undo step). A start trim (`trim_in`) is never closed: the user moved that
 *  edge on purpose, and sliding the clips back would undo it (issue #106). Anything else, or a locked track in the way: `ops` unchanged. */
export function closeStartGap(scene: Scene, ops: Op[]): Op[] {
  const n = scene.clipCount;
  if (n === 0 || !ops.some((o) => o.op === "delete")) return ops;
  const index = new Map<string, number>();
  for (let i = 0; i < n; i++) index.set(scene.id[i]!, i);
  const start = Array.from(scene.tStart.subarray(0, n)), gone = new Set<number>();
  let first = Infinity, touched = false;
  for (let i = 0; i < n; i++) first = Math.min(first, start[i]!);
  for (const o of ops) {
    if (o.op !== "delete" && o.op !== "trim_out") return ops;
    const i = index.get(o.clip);
    if (i === undefined) return ops;
    if (o.op === "delete") gone.add(i);
    if (o.op === "delete" && scene.tStart[i]! === first) touched = true;
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

/** Splits; the right pieces of clips that were linked to each other (and are all split here) share one new link, so the pairs stay linked pairwise. */
export function splitOps(scene: Scene, clips: readonly number[], tick: number, newId: () => string): Op[] {
  const count = new Map<string, number>();
  for (const i of clips) { const l = scene.link[i]!; if (l) count.set(l, (count.get(l) ?? 0) + 1); }
  const fresh = new Map<string, string>();
  return clips.map((i) => {
    const l = scene.link[i]!;
    const op: Op = { op: "split", clip: scene.id[i]!, at: tick, new_id: newId() };
    if (l && count.get(l)! > 1) { if (!fresh.has(l)) fresh.set(l, newId()); op.new_link = fresh.get(l)!; }
    return op;
  });
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
