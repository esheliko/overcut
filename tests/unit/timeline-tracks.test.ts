import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureProject } from "../../apps/web/src/timeline/fixture";
import { headerPart } from "../../apps/web/src/timeline/header";
import { flagsOf } from "../../apps/web/src/timeline/edit";
import { IDLE, longPress, pointerDown, pointerMove, pointerUp, type Ctx, type PEvent } from "../../apps/web/src/timeline/interact";
import { buildScene, displayOrder } from "../../apps/web/src/timeline/scene";
import { addTrack, cleanName, nextTrackName, reorderTrack, removeTrack, renameTrack, rowAt, rowRange, toggleTrack } from "../../apps/web/src/timeline/tracks";
import { GUTTER_WIDE, GUTTER_COMPACT, LANE, RULER, type View } from "../../apps/web/src/timeline/view";

// Model stack (bottom first): V1, A1, V2, A2. Rows shown top to bottom: V2, V1, A1, A2.
const project = fixtureProject({ tracks: 4, clipsPerTrack: 3 });
const scene = buildScene(project);
const view = (o: Partial<View> = {}): View => ({ pps: 40, scrollX: 0, scrollY: 0, width: 900, height: 400, gutter: GUTTER_WIDE, ...o });
const ctx = (v = view()): Ctx => ({ scene, view: v, selected: new Set(), selFlags: flagsOf(scene, []) });
const mouse = (x: number, y: number): PEvent => ({ x, y, kind: "mouse", shift: false, additive: false });
const touch = (x: number, y: number): PEvent => ({ x, y, kind: "touch", shift: false, additive: false });
const laneY = (row: number, dy = LANE / 2) => RULER + row * LANE + dy;

test("rows: video tracks from the top of the stack down, then audio; models map back", () => {
  assert.deepEqual(displayOrder(project.sequences[0]!.tracks), [2, 0, 1, 3]);
  assert.deepEqual([...scene.trackKind], [0, 0, 1, 1]);
  assert.deepEqual(scene.trackName, ["V2", "V1", "A1", "A2"]);
  assert.equal(scene.sequenceId, project.sequences[0]!.id);
});

test("live: muted, hidden, and other tracks of a kind while one is soloed are not live; solo never silences the other kind", () => {
  const p = structuredClone(project);
  const tk = p.sequences[0]!.tracks;
  tk[0]!.muted = true; // V1
  tk[3]!.solo = true; // A2
  const s = buildScene(p);
  assert.deepEqual([...s.trackLive], [1, 0, 0, 1], "V2 live, V1 muted, A1 silenced by A2's solo, A2 live");
  tk[0]!.muted = false; tk[2]!.hidden = true; // V2 hidden
  assert.deepEqual([...buildScene(p).trackLive], [0, 1, 0, 1]);
});

test("switches flip the property through set_track_props and say what happened", () => {
  const r = toggleTrack(scene, 1, "mute");
  assert.deepEqual(r.ops, [{ op: "set_track_props", track: scene.trackId[1], muted: true }]);
  assert.deepEqual(r.say, { key: "timeline.say.track.mute.on", values: { name: "V1" } });
  const p = structuredClone(project); p.sequences[0]!.tracks[0]!.locked = true;
  const locked = toggleTrack(buildScene(p), 1, "lock");
  assert.deepEqual(locked.ops, [{ op: "set_track_props", track: scene.trackId[1], locked: false }]);
});

test("adding: a video track goes on top of the video stack, an audio track at the end; names count the kind", () => {
  assert.equal(nextTrackName(scene, "video"), "V3");
  assert.equal(nextTrackName(scene, "audio"), "A3");
  const v = addTrack(scene, "video", "n".repeat(32));
  const op = v.ops[0] as { op: string; index: number; track: { kind: string; name: string; clips: unknown[] }; sequence: string };
  assert.equal(op.op, "add_track");
  assert.equal(op.index, 3, "one above V2, which sits at stack index 2");
  assert.equal(op.track.name, "V3");
  assert.deepEqual(op.track.clips, []);
  assert.equal(op.sequence, scene.sequenceId);
  assert.equal((addTrack(scene, "audio", "a".repeat(32)).ops[0] as { index: number }).index, 4);
  assert.equal((addTrack(buildScene(null), "video", "b".repeat(32)).ops[0] as { index: number }).index, 0);
});

test("removing and renaming build the engine ops; names are trimmed and bounded", () => {
  assert.deepEqual(removeTrack(scene, 2).ops, [{ op: "remove_track", track: scene.trackId[2] }]);
  assert.equal(cleanName("  "), null);
  assert.equal(cleanName("x".repeat(65)), null);
  assert.equal(cleanName(" Music "), "Music");
  assert.equal(renameTrack(scene, 0, "V2"), null, "unchanged");
  assert.deepEqual(renameTrack(scene, 0, " Titles ")?.ops, [{ op: "set_track_props", track: scene.trackId[0], name: "Titles" }]);
});

test("reordering stays within a kind and uses the model index of the row it takes the place of", () => {
  assert.deepEqual(rowRange(scene, 0), { lo: 0, hi: 1 });
  assert.deepEqual(rowRange(scene, 3), { lo: 2, hi: 3 });
  assert.equal(reorderTrack(scene, 0, 2), null, "a video track does not become an audio one");
  assert.equal(reorderTrack(scene, 1, 1), null);
  const r = reorderTrack(scene, 1, 0)!; // V1 up over V2
  assert.deepEqual(r.ops, [{ op: "move_track", track: scene.trackId[1], index: 2 }]);
  assert.deepEqual(r.say, { key: "timeline.say.track.moved", values: { name: "V1", pos: 1, count: 2 } });
  assert.deepEqual(reorderTrack(scene, 3, 2)!.ops, [{ op: "move_track", track: scene.trackId[3], index: 1 }]);
  assert.equal(rowAt(scene, 1, RULER + 3 * LANE, 0, RULER, LANE), 1, "dragged far down: clamped into the video rows");
  assert.equal(rowAt(scene, 2, 0, 0, RULER, LANE), 2);
});

test("header parts: four switches on a wide header, the whole compact header is one target", () => {
  const w = view();
  assert.equal(headerPart(w, 20, 10), "name");
  assert.equal(headerPart(w, 20, 36), "mute");
  assert.equal(headerPart(w, 54, 36), "solo");
  assert.equal(headerPart(w, 90, 36), "lock");
  assert.equal(headerPart(w, 120, 36), "hide");
  assert.equal(headerPart(w, GUTTER_WIDE + 1, 36), null);
  const c = view({ gutter: GUTTER_COMPACT, compact: true });
  assert.equal(headerPart(c, 20, 36), "name");
  assert.equal(headerPart(c, 59, 4), "name");
});

test("pointer: a tap on a switch flips it, a tap on the name opens the menu, a drag off a switch cancels", () => {
  let r = pointerDown(ctx(), mouse(20, laneY(1, 36)));
  assert.equal(r.g.k, "hdr");
  const up = pointerUp(ctx(), r.g, mouse(20, laneY(1, 36)));
  assert.deepEqual(up.fx.ops, [{ op: "set_track_props", track: scene.trackId[1], muted: true }]);
  r = pointerDown(ctx(), mouse(60, laneY(2, 10)));
  assert.deepEqual(pointerUp(ctx(), r.g, mouse(60, laneY(2, 10))).fx, { menu: 2 });
  r = pointerDown(ctx(), mouse(20, laneY(1, 36)));
  const moved = pointerMove(ctx(), r.g, mouse(20, laneY(1, 36) + 40));
  assert.equal(moved.g.k, "idle");
});

test("pointer: dragging a name reorders (mouse); a long press then drag reorders (touch); a plain touch drag scrolls", () => {
  let r = pointerDown(ctx(), mouse(60, laneY(1, 10)));
  let m = pointerMove(ctx(), r.g, mouse(60, laneY(0, 10)));
  assert.equal(m.g.k, "tdrag");
  assert.deepEqual(pointerUp(ctx(), m.g, mouse(60, laneY(0, 10))).fx.ops, reorderTrack(scene, 1, 0)!.ops);
  const c = view({ gutter: GUTTER_COMPACT, compact: true });
  r = pointerDown(ctx(c), touch(30, laneY(1, 10)));
  assert.equal(r.g.k, "hdr");
  assert.equal(pointerMove(ctx(c), r.g, touch(30, laneY(1, 10) + 30)).g.k, "pan");
  const lp = longPress(ctx(c), r.g)!;
  assert.equal(lp.g.k, "tdrag");
  m = pointerMove(ctx(c), lp.g, touch(30, laneY(0, 10)));
  assert.deepEqual(pointerUp(ctx(c), m.g, touch(30, laneY(0, 10))).fx.ops, reorderTrack(scene, 1, 0)!.ops);
  assert.equal(pointerUp(ctx(c), IDLE, touch(0, 0)).fx.ops, undefined);
});
