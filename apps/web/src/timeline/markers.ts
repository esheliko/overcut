/** Markers and the in/out range on the timeline (M2-046, `docs/features/markers.md`): pure planning on top of the engine's marker and range ops. No DOM. */
import { addMarkerOp, moveMarkerOp, newMarker, setRangeOp, type Op } from "@app/engine-client";
import { timecode } from "../timecode";
import type { Say } from "./edit";
import { TICKS_PER_SECOND as TPS, type Scene } from "./scene";
import { gut, RULER, timeToX, type View } from "./view";

/** Colours a marker can take (the menu's swatches); `null` is the default (the accent). */
export const MARKER_COLOURS = ["#ef4444", "#f59e0b", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#a855f7", "#ec4899"] as const;
/** Grab zone half-width in px: 22 on touch (a 44 px target), 11 with a mouse or pen. */
export const markerReach = (touch: boolean): number => (touch ? 22 : 11);

/** Index of the marker whose flag is under (x, y) on the ruler, or -1. The nearest wins. */
export function markerAt(scene: Scene, v: View, x: number, y: number, touch: boolean): number {
  if (y >= RULER || x < gut(v)) return -1;
  let best = -1, bestD = Infinity;
  scene.markers.forEach((m, i) => { const d = Math.abs(timeToX(v, m.sec) - x); if (d <= markerReach(touch) && d < bestD) { best = i; bestD = d; } });
  return best;
}

/** The marker sitting exactly on `tick`, or -1. */
export const markerAtTick = (scene: Scene, tick: number): number => scene.markers.findIndex((m) => m.ticks === tick);

/** Round ticks to a whole frame, never before 0. */
export const frameTick = (scene: Scene, ticks: number): number => Math.max(0, Math.round(ticks / scene.frameTicks) * scene.frameTicks);

export interface Plan { ops: Op[]; say: Say }
const stamp = (scene: Scene, ticks: number): string => timecode(Math.round(ticks / scene.frameTicks));
const none = (key: string): Plan => ({ ops: [], say: { key } });

/** A marker at the playhead; none when one is already there. `id` is a fresh 32-hex id. */
export function addMarkerPlan(scene: Scene, tick: number, id: string): Plan {
  const at = frameTick(scene, tick);
  if (markerAtTick(scene, at) >= 0) return none("timeline.say.marker.exists");
  return { ops: [addMarkerOp(scene.sequenceId, newMarker(id, at))], say: { key: "timeline.say.marker.added", values: { time: stamp(scene, at) } } };
}

export const moveMarkerPlan = (scene: Scene, id: string, tick: number): Plan => ({ ops: [moveMarkerOp(id, frameTick(scene, tick))], say: { key: "timeline.say.marker.moved" } });

/** The sequence's end in ticks (the last clip end, at least one frame). */
const endTicks = (scene: Scene): number => Math.max(scene.frameTicks, Math.round(scene.endSec * TPS));

/** In (`edge: "start"`) or out point at `tick`. The other end stays; with no range yet it is the start (0) or the end of the clips. A point that would cross the other end pushes it out. */
export function rangePlan(scene: Scene, edge: "start" | "end", tick: number): Plan {
  const at = frameTick(scene, tick);
  const r = scene.range;
  let start = r?.start ?? 0, end = r?.end ?? endTicks(scene);
  if (edge === "start") { start = at; if (end <= start) end = Math.max(endTicks(scene), start + scene.frameTicks); }
  else { end = at; if (start >= end) start = 0; }
  if (end <= start) return none("timeline.say.range.empty");
  if (r && r.start === start && r.end === end) return none("timeline.say.range.same");
  return { ops: [setRangeOp(scene.sequenceId, { start, end }, scene.loop)], say: { key: edge === "start" ? "timeline.say.range.in" : "timeline.say.range.out", values: { time: stamp(scene, at) } } };
}

export const clearRangePlan = (scene: Scene): Plan => (scene.range ? { ops: [setRangeOp(scene.sequenceId, null)], say: { key: "timeline.say.range.cleared" } } : none("timeline.say.range.none"));

/** Turn looping over the range on or off (needs a range). */
export const loopPlan = (scene: Scene): Plan => (scene.range
  ? { ops: [setRangeOp(scene.sequenceId, scene.range, !scene.loop)], say: { key: scene.loop ? "timeline.say.range.loopOff" : "timeline.say.range.loopOn" } }
  : none("timeline.say.range.none"));

/**
 * Where Up / Down (edit points) and Shift+Up / Down (markers) take the playhead from `tick`: the nearest clip start or end on ANY track (markers: marker
 * positions) strictly before or after it, or null when there is none that way. Pure; scans each clip once (a key press, not a frame).
 */
export function jumpTarget(scene: Scene, tick: number, to: "prevCut" | "nextCut" | "prevMarker" | "nextMarker"): number | null {
  const next = to === "nextCut" || to === "nextMarker";
  const gap = Math.max(1, Math.floor(scene.frameTicks / 2)); // the playhead is on a whole frame: an edge within half a frame of it is "here"
  let best: number | null = null;
  const see = (at: number) => {
    if (next ? at < tick + gap : at > tick - gap) return;
    if (best === null || (next ? at < best : at > best)) best = at;
  };
  if (to === "prevMarker" || to === "nextMarker") for (const m of scene.markers) see(m.ticks);
  else for (let i = 0; i < scene.clipCount; i++) { see(scene.tStart[i]!); see(scene.tStart[i]! + scene.tDur[i]!); }
  return best;
}
