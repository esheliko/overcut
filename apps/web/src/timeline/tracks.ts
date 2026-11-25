/** Track editing as pure functions over a Scene (M2-042): the ops for add, remove, reorder, rename and the four switches, plus the messages that announce them.
 *  Rows are display order (see `displayOrder` in scene.ts); the engine's stack index comes from `scene.trackModel`. */
import { addTrackOp, moveTrackOp, newTrack, removeTrackOp, setTrackPropsOp, type Op, type TrackKind } from "@app/engine-client";
import type { Say } from "./edit";
import type { Toggle } from "./header";
import type { Scene } from "./scene";

const STATE: Record<Toggle, (s: Scene, t: number) => boolean> = {
  mute: (s, t) => s.trackMuted[t] === 1,
  solo: (s, t) => s.trackSolo[t] === 1,
  lock: (s, t) => s.trackLocked[t] === 1,
  hide: (s, t) => s.trackHidden[t] === 1,
};
/** Catalog keys, written out so the dead-string check can see them. */
const SAY: Record<Toggle, [string, string]> = {
  mute: ["timeline.say.track.mute.on", "timeline.say.track.mute.off"], solo: ["timeline.say.track.solo.on", "timeline.say.track.solo.off"],
  lock: ["timeline.say.track.lock.on", "timeline.say.track.lock.off"], hide: ["timeline.say.track.hide.on", "timeline.say.track.hide.off"],
};
export const TRACK_SAY_KEYS: readonly string[] = Object.values(SAY).flat();
const FIELD = { mute: "muted", solo: "solo", lock: "locked", hide: "hidden" } as const;

export const isOn = (scene: Scene, t: number, p: Toggle): boolean => STATE[p](scene, t);

/** Flip one of the four switches of row `t`. */
export function toggleTrack(scene: Scene, t: number, p: Toggle): { ops: Op[]; say: Say } {
  const on = !STATE[p](scene, t);
  return { ops: [setTrackPropsOp(scene.trackId[t]!, { [FIELD[p]]: on })], say: { key: SAY[p][on ? 0 : 1], values: { name: scene.trackName[t]! } } };
}

/** The name a new track of `kind` gets: V3, A2 ... one more than the tracks of that kind. */
export function nextTrackName(scene: Scene, kind: TrackKind): string {
  const k = kind === "audio" ? 1 : 0;
  let n = 0;
  for (let t = 0; t < scene.trackCount; t++) if (scene.trackKind[t] === k) n++;
  return `${kind === "audio" ? "A" : "V"}${n + 1}`;
}

/** Add an empty track: a video track on top of the video stack (it overlays the ones below), an audio track below the audio ones. */
export function addTrack(scene: Scene, kind: TrackKind, id: string): { ops: Op[]; say: Say; name: string } {
  const name = nextTrackName(scene, kind);
  let index = scene.trackCount;
  if (kind === "video") { index = 0; for (let t = 0; t < scene.trackCount; t++) if (scene.trackKind[t] === 0) index = Math.max(index, scene.trackModel[t]! + 1); }
  return { ops: [addTrackOp(scene.sequenceId, newTrack(id, kind, name), index)], say: { key: "timeline.say.track.added", values: { name } }, name };
}

export const removeTrack = (scene: Scene, t: number): { ops: Op[]; say: Say } =>
  ({ ops: [removeTrackOp(scene.trackId[t]!)], say: { key: "timeline.say.track.removed", values: { name: scene.trackName[t]! } } });

/** Valid name: 1-64 characters without surrounding spaces (the engine's rule); null when it would be refused. */
export const cleanName = (raw: string): string | null => { const n = raw.trim(); return n.length >= 1 && n.length <= 64 ? n : null; };

export function renameTrack(scene: Scene, t: number, raw: string): { ops: Op[]; say: Say } | null {
  const name = cleanName(raw);
  if (name === null || name === scene.trackName[t]) return null;
  return { ops: [setTrackPropsOp(scene.trackId[t]!, { name })], say: { key: "timeline.say.track.renamed", values: { name } } };
}

/** Rows a track may be dragged to: its own kind only (video among video, audio among audio). */
export function rowRange(scene: Scene, t: number): { lo: number; hi: number } {
  const k = scene.trackKind[t]!;
  let lo = t, hi = t;
  while (lo > 0 && scene.trackKind[lo - 1] === k) lo--;
  while (hi < scene.trackCount - 1 && scene.trackKind[hi + 1] === k) hi++;
  return { lo, hi };
}

/** Move row `from` to row `to` (it takes the place of the track there). Null when nothing moves or `to` is outside its kind. */
export function reorderTrack(scene: Scene, from: number, to: number): { ops: Op[]; say: Say } | null {
  const { lo, hi } = rowRange(scene, from);
  if (to === from || to < lo || to > hi) return null;
  return { ops: [moveTrackOp(scene.trackId[from]!, scene.trackModel[to]!)], say: { key: "timeline.say.track.moved", values: { name: scene.trackName[from]!, pos: to - lo + 1, count: hi - lo + 1 } } };
}

/** Row (clamped into `from`'s kind) under a canvas-space y while dragging a header. */
export function rowAt(scene: Scene, from: number, y: number, scrollY: number, ruler: number, lane: number): number {
  const { lo, hi } = rowRange(scene, from);
  const r = Math.floor((y - ruler + scrollY) / lane);
  return r < lo ? lo : r > hi ? hi : r;
}
