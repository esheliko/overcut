/** Pointer interaction state machine for the canvas timeline (M1-034). Pure: events in, new gesture + effects out; no DOM, no engine.
 *  The canvas owns pointers, panning and drawing; the owner of the engine applies `Effects.ops` (via `Engine.editing`) and the selection.
 *  Touch rules: a tap selects; a drag on an unselected clip pans; a drag on an already selected clip moves it; handles of a selected clip are 44 px targets. */
import type { Op } from "@app/engine-client";
import { clampN, describeClip, expandLinks, groupReps, laneChanger, laneOps, lanePlan, type LanePlan, type LaneMove, type Say, inRect, linkedTrimOps, moveOps, moveRoom, snapDelta, trimRange, trimTarget, type Edge } from "./edit";
import { hopOps, planHop, snapMove } from "./arrange";
import { snapPx } from "./snapStore";
import { handleAt, hitTest, seamAt, trackAtY } from "./hit";
import { headerPart, type HeaderPart } from "./header";
import { frameTick, markerAt, moveMarkerPlan } from "./markers";
import { reorderTrack, rowAt, toggleTrack } from "./tracks";
import { TICKS_PER_SECOND as TPS, type Scene } from "./scene";
import { cutAt, rippleRange, rippleTrimOps, rollCuts, rollOps, rollRangeAll, slideOps, slideRange, slipOps, slipRange, snapTo, type Range, type Tool } from "./ripple";
import { gut, LANE, RULER, xToTime, type View } from "./view";

export type PointerKind = "mouse" | "touch" | "pen";
export interface PEvent { x: number; y: number; kind: PointerKind; shift: boolean; /** Ctrl or Cmd. */ additive: boolean; /** Alt (Option): the edit tools without a mode switch. */ alt?: boolean }
export interface Ctx {
  scene: Scene;
  view: View;
  /** Selected clip ids and the same as per-index flags (the canvas keeps both). */
  selected: ReadonlySet<string>;
  selFlags: Uint8Array;
  /** Playhead in ticks: a snap target while moving. */
  playhead?: number | null;
  /** The tool chosen in the toolbar (select when absent). */
  tool?: Tool;
}
export interface Effects {
  select?: { mode: "set" | "toggle" | "add"; ids: string[] };
  /** Seek the playhead to this many seconds. */
  seek?: number;
  /** Edits to apply as ONE undo step. */
  ops?: Op[];
  /** The `say` is also shown as a visible notice (not only announced): a refusal a sighted user must see. */
  visible?: boolean;
  /** Open the menu of this track (row index); the canvas knows where its header is. */
  menu?: number;
  /** Open the menu of the marker with this id (the canvas knows where its flag is). */
  markerMenu?: string;
  /** Spoken/visible description of what happened. */
  say?: Say;
}
const NONE: Effects = {};
export const SLOP = 6;
/** A finger wobbles more than a mouse: a touch must travel this far before a press becomes a drag (a pick-up), so a tap never nudges a clip. */
export const TOUCH_SLOP = 8;
const slopOf = (e: PEvent): number => (e.kind === "touch" ? TOUCH_SLOP : SLOP);

export type Gesture =
  | { k: "idle" }
  | { k: "scrub" }
  | { k: "pan" }
  /** Pointer is down but has not moved far enough to know what it is: a tap, or a drag that becomes `then`. */
  | { k: "press"; sx: number; sy: number; then: "move" | "pan" | "marquee" | "none"; tapClip: number; collapse: boolean; clearOnTap: boolean; /** A touch long press picked the clip up: it is drawn lifted (as its move ghost) until the finger lets go or drags. */ lifted?: boolean }
  | { k: "move"; sx: number; sel: number[]; room: { left: number; right: number }; delta: number; track: number; from: number; mv: LaneMove | null; to: number[] | null; plan?: LanePlan | null;
      /** Clips jumped over (reorder): > 0 to the right, < 0 to the left. */ hop?: number;
      /** Tick the selection snapped to or landed against: the painter draws a guide line there. */ guide?: number | null }
  | { k: "trim"; sx: number; clip: number; edge: Edge; orig: number; value: number }
  /** An edit-tool drag (TL-04): ripple trim of `edge`, roll of the cut `cuts`, slip or slide of `clip`. `delta` is in timeline ticks, snapped to frames inside [lo, hi]. */
  | { k: "tool"; tool: "ripple" | "roll" | "slip" | "slide"; sx: number; clip: number; edge: Edge | null; cuts: [number, number][]; lo: number; hi: number; delta: number;
      /** A roll started by dragging the seam between two touching clips in the Select tool (#105): both clips are ghosted. */ seam?: boolean }
  | { k: "marquee"; x0: number; y0: number; x1: number; y1: number }
  /** Pointer is down on a track header: a tap on a switch flips it, a tap elsewhere opens the menu, a drag of the name (mouse) or a long press (touch) reorders. */
  | { k: "hdr"; track: number; part: HeaderPart; sx: number; sy: number; touch: boolean }
  /** Reordering tracks: row `from` is being carried to row `to` (same kind only), pointer at y. */
  | { k: "tdrag"; from: number; to: number; y: number }
  /** Pointer is down on a marker's flag: a tap jumps to it (a second tap, or a long press, opens its menu), a drag moves it. `value` is the dragged tick. */
  | { k: "marker"; id: string; sx: number; orig: number; value: number; moved: boolean; touch: boolean };

export const IDLE: Gesture = { k: "idle" };

/** Edge auto-scroll: how fast (px per second) a drag near an edge scrolls, 0 outside the zone; fastest at the very edge. */
export const EDGE_ZONE = 48;
export const EDGE_MAX = 700;
export const edgeSpeed = (pos: number, lo: number, hi: number): number => {
  if (pos < lo + EDGE_ZONE) return -EDGE_MAX * Math.min(1, (lo + EDGE_ZONE - pos) / EDGE_ZONE);
  if (pos > hi - EDGE_ZONE) return EDGE_MAX * Math.min(1, (pos - (hi - EDGE_ZONE)) / EDGE_ZONE);
  return 0;
};
/** The gestures that auto-scroll when dragged near an edge: a clip move, a trim, an edit-tool drag, a marquee, a track-reorder drag. */
export const scrollsAtEdge = (g: Gesture): boolean => g.k === "move" || g.k === "trim" || g.k === "tool" || g.k === "marquee" || g.k === "tdrag";
/** The gesture after the view scrolled by (dx, dy) px under a still pointer: its press origin moves the other way, so the drag keeps growing by what was scrolled. */
export function scrolled(g: Gesture, dx: number, dy: number): Gesture {
  if (g.k === "move" || g.k === "trim" || g.k === "tool") return { ...g, sx: g.sx - dx };
  if (g.k === "marquee") return { ...g, x0: g.x0 - dx, y0: g.y0 - dy };
  return g;
}
type R = { g: Gesture; fx: Effects };

/** Paints a gesture onto the selection flags the painter reads (1 = selected, 2 = being moved or trimmed: its body is hidden and a ghost drawn).
 *  Every 2 is first settled back to 1, so a gesture that ends WITHOUT an edit (a move clamped back to 0:00, a trim that did not change)
 *  leaves its clips visible. Mutates `f` in place (no allocation per pointer move). */
export function markPreview(f: Uint8Array, g: Gesture): void {
  for (let i = 0; i < f.length; i++) if (f[i] === 2) f[i] = 1;
  if (g.k === "move") for (const i of g.sel) f[i] = 2;
  else if (g.k === "press" && g.lifted && g.tapClip >= 0 && f[g.tapClip] !== undefined) f[g.tapClip] = 2; // picked up by a long press: the lifted copy (a ghost) is drawn over it
  else if (g.k === "trim") f[g.clip] = 2;
  else if (g.k === "tool" && (g.tool === "slip" || g.tool === "slide")) f[g.clip] = 2;
}

/** Which tool a press uses: the toolbar's, or with Alt held (no mode switch) roll / ripple on an edge, slip on a body, slide on a body with Shift. */
function toolDown(c: Ctx, e: PEvent): R | null {
  const { scene, view } = c;
  const touch = e.kind === "touch";
  let tool: Tool = c.tool ?? "select";
  const edge = handleAt(scene, view, c.selFlags, e.x, e.y, touch, true);
  const body = hitTest(scene, view, e.x, e.y, 0);
  if (tool === "select") {
    if (!e.alt) return null;
    tool = edge ? (cutAt(scene, edge.clip, edge.edge) ? "roll" : "ripple") : e.shift ? "slide" : "slip";
  }
  const locked = (): R => ({ g: IDLE, fx: { say: { key: "timeline.locked" } } });
  const pick = (i: number): Effects => ({ select: { mode: "set", ids: [scene.id[i]!] } });
  if (tool === "ripple" || tool === "roll") {
    if (!edge) return null;
    const i = edge.clip;
    if (scene.trackLocked[scene.clipTrack[i]!]) return locked();
    if (tool === "ripple") {
      const r = rippleRange(scene, i, edge.edge);
      if (!r) return locked();
      return { g: { k: "tool", tool, sx: e.x, clip: i, edge: edge.edge, cuts: [], lo: r.lo, hi: r.hi, delta: 0 }, fx: pick(i) };
    }
    const cuts = rollCuts(scene, i, edge.edge);
    if (cuts.length === 0) return { g: IDLE, fx: { say: { key: "timeline.say.noCut" }, visible: true } };
    const r = rollRangeAll(scene, cuts);
    if (r.lo === 0 && r.hi === 0) return { g: IDLE, fx: { ...pick(i), say: { key: "timeline.say.noRoom.roll" }, visible: true } }; // fresh imports have no spare footage: say so instead of doing nothing
    return { g: { k: "tool", tool, sx: e.x, clip: i, edge: edge.edge, cuts, lo: r.lo, hi: r.hi, delta: 0 }, fx: pick(i) };
  }
  if (body.kind !== "clip") return null;
  const i = body.clip;
  const r = tool === "slip" ? slipRange(scene, i) : slideRange(scene, i);
  if (!r) return locked();
  if (r.lo === 0 && r.hi === 0) return { g: IDLE, fx: { ...pick(i), say: { key: tool === "slip" ? "timeline.say.noRoom.slip" : "timeline.say.noRoom.slide" }, visible: true } };
  return { g: { k: "tool", tool, sx: e.x, clip: i, edge: null, cuts: [], lo: r.lo, hi: r.hi, delta: 0 }, fx: { ...pick(i), say: describeClip(scene, i) } };
}

/** Dragging the seam between two touching clips in the Select tool is a roll of that cut (#105): the boundary moves, both clips follow,
 *  with the roll tool's frame snapping, guide line, linked-clip rules and "no extra footage" notice. `pickBoth`: select both clips. */
function seamDown(c: Ctx, e: PEvent, sm: { left: number; right: number }, pickBoth: boolean): R | null {
  const { scene } = c;
  if (scene.trackLocked[scene.clipTrack[sm.left]!] || scene.trackLocked[scene.clipTrack[sm.right]!]) return null;
  const cuts = rollCuts(scene, sm.left, "end");
  if (cuts.length === 0) return null;
  const pick: Effects = pickBoth ? { select: { mode: "set", ids: [scene.id[sm.left]!, scene.id[sm.right]!] } } : NONE;
  const r = rollRangeAll(scene, cuts);
  if (r.lo === 0 && r.hi === 0) return { g: IDLE, fx: { ...pick, say: { key: "timeline.say.noRoom.roll" }, visible: true } };
  return { g: { k: "tool", tool: "roll", sx: e.x, clip: sm.left, edge: "end", cuts, lo: r.lo, hi: r.hi, delta: 0, seam: true }, fx: pick };
}

export function pointerDown(c: Ctx, e: PEvent): R {
  const { scene, view } = c;
  const touch = e.kind === "touch";
  if (e.y < RULER) {
    const mi = markerAt(scene, view, e.x, e.y, touch);
    if (mi >= 0) { const m = scene.markers[mi]!; return { g: { k: "marker", id: m.id, sx: e.x, orig: m.ticks, value: m.ticks, moved: false, touch }, fx: NONE }; }
    return e.x >= gut(view) ? { g: { k: "scrub" }, fx: { seek: xToTime(view, e.x) } } : { g: IDLE, fx: NONE };
  }
  const tl = toolDown(c, e);
  if (tl) return tl;
  const hd = handleAt(scene, view, c.selFlags, e.x, e.y, touch);
  if (hd && !scene.trackLocked[scene.clipTrack[hd.clip]!]) {
    const r = trimRange(scene, hd.clip, hd.edge);
    return { g: { k: "trim", sx: e.x, clip: hd.clip, edge: hd.edge, orig: r.at, value: r.at }, fx: NONE };
  }
  const eh = touch ? null : handleAt(scene, view, c.selFlags, e.x, e.y, false, true); // mouse: an edge of an unselected clip trims it (and selects it)
  const seam = touch ? null : seamAt(scene, view, c.selFlags, e.x, e.y, false, true); // mouse: any seam moves, selecting both clips
  if (seam && (!eh || seam.left === eh.clip || seam.right === eh.clip)) { const r = seamDown(c, e, seam, true); if (r) return r; }
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
  if (h.kind === "gutter") {
    const part = headerPart(view, e.x, e.y - RULER + view.scrollY - h.track * LANE, scene.trackKind[h.track]!);
    return { g: part ? { k: "hdr", track: h.track, part, sx: e.x, sy: e.y, touch } : touch ? { k: "pan" } : IDLE, fx: NONE };
  }
  return { g: { k: "press", sx: e.x, sy: e.y, then: touch ? "pan" : "marquee", tapClip: -1, collapse: false, clearOnTap: !(e.shift || e.additive) }, fx: NONE };
}

export function pointerMove(c: Ctx, g: Gesture, e: PEvent): R {
  const { scene, view } = c;
  switch (g.k) {
    case "marker": {
      if (!g.moved && Math.abs(e.x - g.sx) <= slopOf(e)) return { g, fx: NONE };
      return { g: { ...g, moved: true, value: frameTick(scene, Math.max(0, xToTime(view, e.x)) * TPS) }, fx: NONE };
    }
    case "press": {
      if (Math.hypot(e.x - g.sx, e.y - g.sy) <= slopOf(e)) return { g, fx: NONE };
      if (g.then === "pan") return { g: { k: "pan" }, fx: NONE };
      if (g.then === "marquee") return { g: { k: "marquee", x0: g.sx, y0: g.sy, x1: e.x, y1: e.y }, fx: NONE };
      if (g.then === "none") return { g, fx: NONE };
      const sel = [...Array(scene.clipCount).keys()].filter((i) => c.selFlags[i] && !scene.trackLocked[scene.clipTrack[i]!]);
      if (sel.length === 0) return { g: IDLE, fx: { say: { key: "timeline.locked" } } };
      const flags = new Uint8Array(scene.clipCount);
      for (const i of sel) flags[i] = 1;
      const from = scene.clipTrack[sel[0]!]!;
      return pointerMove(c, { k: "move", sx: g.sx, sel, room: moveRoom(scene, sel, flags), delta: 0, track: from, from, mv: null, to: null }, e);
    }
    case "move": {
      const dx = ((e.x - g.sx) / view.pps) * TPS;
      const delta = snapDelta(dx, -g.room.left, g.room.right, scene.frameTicks);
      const track = g.from;
      const t = trackAtY(scene, view, e.y);
      if (t >= 0) {
        const mv = laneChanger(scene, g.sel, t);
        if (mv) {
          const plan = lanePlan(scene, g.sel, c.selFlags, mv, dx);
          if (plan !== null) return { g: { ...g, delta: plan.delta, track: t, mv, plan, to: plan.to, hop: 0, guide: null }, fx: NONE };
        }
      }
      // Past a neighbour's middle the selection jumps over it (reorder); otherwise it slides, pulled onto edges and the playhead.
      const hop = planHop(scene, g.sel, dx, g.sel[0]!);
      if (hop) return { g: { ...g, delta: hop.shift, track, mv: null, to: null, hop: hop.n, guide: hop.edge }, fx: NONE };
      const snap = snapMove(scene, g.sel, delta, -g.room.left, g.room.right, c.playhead ?? null, (snapPx() / view.pps) * TPS);
      return { g: { ...g, delta: snap.delta, track, mv: null, to: null, hop: 0, guide: snap.guide }, fx: NONE };
    }
    case "trim": {
      const desired = g.orig + ((e.x - g.sx) / view.pps) * TPS;
      const value = trimTarget(scene, g.clip, g.edge, desired);
      return { g: { ...g, value }, fx: NONE };
    }
    case "tool": {
      const dx = ((e.x - g.sx) / view.pps) * TPS;
      const d = snapTo(scene, g.tool === "slip" ? -dx : dx, { lo: g.lo, hi: g.hi } as Range);
      return { g: { ...g, delta: d }, fx: NONE };
    }
    case "marquee":
      return { g: { ...g, x1: e.x, y1: e.y }, fx: NONE };
    case "hdr": {
      if (Math.hypot(e.x - g.sx, e.y - g.sy) <= slopOf(e)) return { g, fx: NONE };
      if (g.touch) return { g: { k: "pan" }, fx: NONE }; // a touch drag on a header scrolls the tracks; a long press picks the header up (longPress)
      if (g.part !== "name") return { g: IDLE, fx: NONE }; // dragged off a switch: cancelled, nothing flips
      return pointerMove(c, { k: "tdrag", from: g.track, to: g.track, y: e.y }, e);
    }
    case "tdrag":
      return { g: { ...g, y: e.y, to: rowAt(scene, g.from, e.y, view.scrollY, RULER, LANE) }, fx: NONE };
    default:
      return { g, fx: NONE };
  }
}

/** A touch that rests on an unselected clip (it did not move for a moment) picks the clip up: it selects and the next drag moves it instead of panning. */
export function longPress(c: Ctx, g: Gesture): R | null {
  if (g.k === "marker" && !g.moved) return { g: IDLE, fx: { markerMenu: g.id } };
  if (g.k === "hdr" && g.touch) return { g: { k: "tdrag", from: g.track, to: g.track, y: g.sy }, fx: { say: { key: "timeline.say.track.lifted", values: { name: c.scene.trackName[g.track]! } } } };
  if (g.k !== "press" || g.tapClip < 0 || g.then !== "pan") return null;
  const i = g.tapClip;
  if (c.scene.trackLocked[c.scene.clipTrack[i]!]) return null;
  return { g: { ...g, then: "move", lifted: true }, fx: { select: { mode: "set", ids: [c.scene.id[i]!] }, say: describeClip(c.scene, i) } };
}

export function pointerUp(c: Ctx, g: Gesture, e: PEvent): R {
  const { scene, view } = c;
  switch (g.k) {
    case "marker": {
      const m = scene.markers.find((x) => x.id === g.id);
      if (!m) return { g: IDLE, fx: NONE };
      if (g.moved) return g.value === g.orig ? { g: IDLE, fx: NONE } : { g: IDLE, fx: moveMarkerPlan(scene, g.id, g.value) };
      // A tap jumps to the marker; tapping the one the playhead already sits on opens its menu.
      return { g: IDLE, fx: c.playhead === m.ticks ? { markerMenu: g.id } : { seek: m.sec } };
    }
    case "press": {
      if (g.tapClip >= 0) {
        const id = scene.id[g.tapClip]!;
        return { g: IDLE, fx: g.collapse || !c.selected.has(id) ? { select: { mode: "set", ids: [id] }, say: describeClip(scene, g.tapClip) } : NONE };
      }
      return { g: IDLE, fx: { seek: xToTime(view, g.sx), ...(g.clearOnTap ? { select: { mode: "set" as const, ids: [] } } : {}) } };
    }
    case "move": {
      if (g.delta === 0 && !g.mv) return { g: IDLE, fx: NONE };
      if (g.hop) return { g: IDLE, fx: { ops: hopOps(scene, g.sel, g.hop), say: { key: "timeline.say.moved", values: { count: groupReps(scene, g.sel).length, name: scene.name[g.sel[0]!]! } } } };
      const ops = g.mv ? laneOps(scene, g.sel, g.mv, g.delta, g.plan ?? undefined) : moveOps(scene, g.sel, g.delta);
      const n = groupReps(scene, g.sel).length;
      return { g: IDLE, fx: { ops, say: { key: "timeline.say.moved", values: { count: n, name: scene.name[g.sel[0]!]! } } } };
    }
    case "trim": {
      if (g.value === g.orig) return { g: IDLE, fx: NONE };
      const ops = linkedTrimOps(scene, g.clip, g.edge, g.value);
      return { g: IDLE, fx: { ops, say: { key: "timeline.say.trimmed", values: { edge: g.edge, name: scene.name[g.clip]! } } } };
    }
    case "tool": {
      // A slip dragged the way the footage has run out (e.g. the right half of a split, dragged later) clamps to 0: say so instead of doing nothing.
      if (g.delta === 0) return { g: IDLE, fx: g.tool === "slip" && Math.abs(e.x - g.sx) > SLOP ? { say: { key: "timeline.say.slipOtherWay" }, visible: true } : NONE };
      const name = scene.name[g.clip]!;
      const ops = g.tool === "ripple" ? rippleTrimOps(scene, g.clip, g.edge!, g.delta) : g.tool === "roll" ? rollOps(scene, g.cuts, g.delta) : g.tool === "slip" ? slipOps(scene, g.clip, g.delta) : slideOps(scene, g.clip, g.delta);
      const key = g.tool === "ripple" ? "timeline.say.rippled" : g.tool === "roll" ? "timeline.say.rolled" : g.tool === "slip" ? "timeline.say.slipped" : "timeline.say.slid";
      return { g: IDLE, fx: { ops, say: { key, values: { name, frames: Math.round(Math.abs(g.delta) / scene.frameTicks) } } } };
    }
    case "hdr": {
      if (g.part === "name") return { g: IDLE, fx: { menu: g.track } };
      const r = toggleTrack(scene, g.track, g.part);
      return { g: IDLE, fx: r };
    }
    case "tdrag": {
      const r = reorderTrack(scene, g.from, g.to);
      return { g: IDLE, fx: r ?? NONE };
    }
    case "marquee": {
      const [xa, xb] = [Math.min(g.x0, g.x1), Math.max(g.x0, g.x1)];
      const [ya, yb] = [Math.min(g.y0, g.y1), Math.max(g.y0, g.y1)];
      const row = (y: number) => Math.floor((clampN(y, RULER, 1e9) - RULER + view.scrollY) / LANE);
      const hit = inRect(scene, xToTime(view, Math.max(xa, gut(view))), xToTime(view, xb), row(ya), row(yb));
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

/** True when `next` lays out every clip exactly as `prev` did (same ids, tracks, times). A project update that changes nothing the gesture depends on
 *  (a thumbnail or a save arriving mid-drag rebuilds the scene) must not cancel the drag in progress. */
export function sameLayout(prev: Scene, next: Scene): boolean {
  if (prev === next) return true;
  if (prev.clipCount !== next.clipCount || prev.trackCount !== next.trackCount) return false;
  for (let i = 0; i < prev.clipCount; i++) {
    if (prev.id[i] !== next.id[i] || prev.tStart[i] !== next.tStart[i] || prev.tDur[i] !== next.tDur[i] || prev.clipTrack[i] !== next.clipTrack[i]) return false;
  }
  for (let t = 0; t < prev.trackCount; t++) if (prev.trackLocked[t] !== next.trackLocked[t] || prev.trackId[t] !== next.trackId[t] || prev.trackKind[t] !== next.trackKind[t]) return false;
  return true;
}
