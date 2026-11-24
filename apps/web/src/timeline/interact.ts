/** Pointer interaction state machine for the canvas timeline (M1-034). Pure: events in, new gesture + effects out; no DOM, no engine.
 *  The canvas owns pointers, panning and drawing; the owner of the engine applies `Effects.ops` (via `Engine.editing`) and the selection.
 *  Touch rules: a tap selects; a drag on an unselected clip pans; a drag on an already selected clip moves it; handles of a selected clip are 44 px targets. */
import type { Op } from "@app/engine-client";
import { clampN, describeClip, expandLinks, groupReps, type Say, fitsOnTrack, inRect, linkedTrimOps, moveOps, moveRoom, moveToTrackOp, snapDelta, trimRange, trimTarget, type Edge } from "./edit";
import { handleAt, hitTest, trackAtY } from "./hit";
import { TICKS_PER_SECOND as TPS, type Scene } from "./scene";
import { GUTTER, LANE, RULER, xToTime, type View } from "./view";

export type PointerKind = "mouse" | "touch" | "pen";
export interface PEvent { x: number; y: number; kind: PointerKind; shift: boolean; /** Ctrl or Cmd. */ additive: boolean }
export interface Ctx {
  scene: Scene;
  view: View;
  /** Selected clip ids and the same as per-index flags (the canvas keeps both). */
  selected: ReadonlySet<string>;
  selFlags: Uint8Array;
}
export interface Effects {
  select?: { mode: "set" | "toggle" | "add"; ids: string[] };
  /** Seek the playhead to this many seconds. */
  seek?: number;
  /** Edits to apply as ONE undo step. */
  ops?: Op[];
  /** Spoken/visible description of what happened. */
  say?: Say;
}
const NONE: Effects = {};
export const SLOP = 6;

export type Gesture =
  | { k: "idle" }
  | { k: "scrub" }
  | { k: "pan" }
  /** Pointer is down but has not moved far enough to know what it is: a tap, or a drag that becomes `then`. */
  | { k: "press"; sx: number; sy: number; then: "move" | "pan" | "marquee" | "none"; tapClip: number; collapse: boolean; clearOnTap: boolean }
  | { k: "move"; sx: number; sel: number[]; room: { left: number; right: number }; delta: number; track: number; from: number }
  | { k: "trim"; sx: number; clip: number; edge: Edge; orig: number; value: number }
  | { k: "marquee"; x0: number; y0: number; x1: number; y1: number };

export const IDLE: Gesture = { k: "idle" };
type R = { g: Gesture; fx: Effects };

export function pointerDown(c: Ctx, e: PEvent): R {
  const { scene, view } = c;
  const touch = e.kind === "touch";
  if (e.y < RULER) return e.x >= GUTTER ? { g: { k: "scrub" }, fx: { seek: xToTime(view, e.x) } } : { g: IDLE, fx: NONE };
  const hd = handleAt(scene, view, c.selFlags, e.x, e.y, touch);
  if (hd && !scene.trackLocked[scene.clipTrack[hd.clip]!]) {
    const r = trimRange(scene, hd.clip, hd.edge);
    return { g: { k: "trim", sx: e.x, clip: hd.clip, edge: hd.edge, orig: r.at, value: r.at }, fx: NONE };
  }
  const eh = touch ? null : handleAt(scene, view, c.selFlags, e.x, e.y, false, true); // mouse: an edge of an unselected clip trims it (and selects it)
  if (eh && !scene.trackLocked[scene.clipTrack[eh.clip]!]) {
    const r = trimRange(scene, eh.clip, eh.edge);
    return { g: { k: "trim", sx: e.x, clip: eh.clip, edge: eh.edge, orig: r.at, value: r.at }, fx: { select: { mode: "set", ids: [scene.id[eh.clip]!] } } };
  }
  const h = hitTest(scene, view, e.x, e.y, 0);
  if (h.kind === "clip") {
    const id = scene.id[h.clip]!;
    const was = c.selected.has(id);
    const mod = e.shift || e.additive;
    const press = (then: "move" | "pan" | "none", collapse: boolean): Gesture => ({ k: "press", sx: e.x, sy: e.y, then, tapClip: h.clip, collapse, clearOnTap: false });
    if (mod) return { g: press(was ? "none" : "move", false), fx: { select: { mode: "toggle", ids: [id] } } };
    if (was) return { g: press("move", c.selected.size > 1), fx: NONE };
    if (touch) return { g: press("pan", false), fx: NONE }; // a tap selects on release; a drag pans
    return { g: press("move", false), fx: { select: { mode: "set", ids: [id] }, say: describeClip(scene, h.clip) } };
  }
  if (h.kind === "gutter") return { g: touch ? { k: "pan" } : IDLE, fx: NONE };
  return { g: { k: "press", sx: e.x, sy: e.y, then: touch ? "pan" : "marquee", tapClip: -1, collapse: false, clearOnTap: !(e.shift || e.additive) }, fx: NONE };
}

export function pointerMove(c: Ctx, g: Gesture, e: PEvent): R {
  const { scene, view } = c;
  switch (g.k) {
    case "press": {
      if (Math.hypot(e.x - g.sx, e.y - g.sy) <= SLOP) return { g, fx: NONE };
      if (g.then === "pan") return { g: { k: "pan" }, fx: NONE };
      if (g.then === "marquee") return { g: { k: "marquee", x0: g.sx, y0: g.sy, x1: e.x, y1: e.y }, fx: NONE };
      if (g.then === "none") return { g, fx: NONE };
      const sel = [...Array(scene.clipCount).keys()].filter((i) => c.selFlags[i] && !scene.trackLocked[scene.clipTrack[i]!]);
      if (sel.length === 0) return { g: IDLE, fx: { say: { key: "timeline.locked" } } };
      const flags = new Uint8Array(scene.clipCount);
      for (const i of sel) flags[i] = 1;
      const from = scene.clipTrack[sel[0]!]!;
      return pointerMove(c, { k: "move", sx: g.sx, sel, room: moveRoom(scene, sel, flags), delta: 0, track: from, from }, e);
    }
    case "move": {
      const dx = ((e.x - g.sx) / view.pps) * TPS;
      let delta = snapDelta(dx, -g.room.left, g.room.right, scene.frameTicks);
      let track = g.from;
      if (g.sel.length === 1) {
        const t = trackAtY(scene, view, e.y);
        if (t >= 0 && t !== g.from) {
          const free = snapDelta(dx, -scene.tStart[g.sel[0]!]!, Infinity, scene.frameTicks);
          if (fitsOnTrack(scene, g.sel[0]!, t, free)) { track = t; delta = free; }
        }
      }
      return { g: { ...g, delta, track }, fx: NONE };
    }
    case "trim": {
      const value = trimTarget(scene, g.clip, g.edge, g.orig + ((e.x - g.sx) / view.pps) * TPS);
      return { g: { ...g, value }, fx: NONE };
    }
    case "marquee":
      return { g: { ...g, x1: e.x, y1: e.y }, fx: NONE };
    default:
      return { g, fx: NONE };
  }
}

export function pointerUp(c: Ctx, g: Gesture, e: PEvent): R {
  const { scene, view } = c;
  switch (g.k) {
    case "press": {
      if (g.tapClip >= 0) {
        const id = scene.id[g.tapClip]!;
        return { g: IDLE, fx: g.collapse || !c.selected.has(id) ? { select: { mode: "set", ids: [id] }, say: describeClip(scene, g.tapClip) } : NONE };
      }
      return { g: IDLE, fx: { seek: xToTime(view, g.sx), ...(g.clearOnTap ? { select: { mode: "set" as const, ids: [] } } : {}) } };
    }
    case "move": {
      if (g.delta === 0 && g.track === g.from) return { g: IDLE, fx: NONE };
      const ops = g.track !== g.from ? [moveToTrackOp(scene, g.sel[0]!, g.track, g.delta)] : moveOps(scene, g.sel, g.delta);
      const n = g.sel.length;
      return { g: IDLE, fx: { ops, say: { key: "timeline.say.moved", values: { count: n, name: scene.name[g.sel[0]!]! } } } };
    }
    case "trim": {
      if (g.value === g.orig) return { g: IDLE, fx: NONE };
      return { g: IDLE, fx: { ops: linkedTrimOps(scene, g.clip, g.edge, g.value), say: { key: "timeline.say.trimmed", values: { edge: g.edge, name: scene.name[g.clip]! } } } };
    }
    case "marquee": {
      const [xa, xb] = [Math.min(g.x0, g.x1), Math.max(g.x0, g.x1)];
      const [ya, yb] = [Math.min(g.y0, g.y1), Math.max(g.y0, g.y1)];
      const row = (y: number) => Math.floor((clampN(y, RULER, 1e9) - RULER + view.scrollY) / LANE);
      const hit = inRect(scene, xToTime(view, Math.max(xa, GUTTER)), xToTime(view, xb), row(ya), row(yb));
      const ids = hit.map((i) => scene.id[i]!);
      const clips = groupReps(scene, hit).length; // a linked sound counts with its picture
      return { g: IDLE, fx: { select: { mode: e.shift || e.additive ? "add" : "set", ids }, say: { key: "timeline.say.selectedCount", values: { count: clips } } } };
    }
    default:
      return { g: IDLE, fx: NONE };
  }
}

/** Selection after applying an effect's select to the current one. */
export function applySelect(cur: ReadonlySet<string>, s: NonNullable<Effects["select"]>, scene?: Scene): Set<string> {
  // Linked clips are picked (and un-picked) together; without a scene (tests of the plain rules) ids are taken as given.
  const ids = scene ? [...expandLinks(scene, s.ids)] : s.ids;
  if (s.mode === "set") return new Set(ids);
  const next = new Set(cur);
  const off = s.mode === "toggle" && s.ids.length > 0 && s.ids.every((id) => cur.has(id));
  for (const id of ids) {
    if (off) next.delete(id);
    else next.add(id);
  }
  return next;
}
