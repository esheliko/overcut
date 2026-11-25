/** Moving clips between tracks (M2 multi-track): drag, keyboard step, and where a dropped media card lands. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { TICKS, destTracks, insertOps, mediaRef, placeAt, type Probed } from "../../apps/web/src/media/plan";
import { flagsOf, laneChanger, laneOps, laneStepOps } from "../../apps/web/src/timeline/edit";
import { pointerDown, pointerMove, pointerUp, type Ctx, type PEvent } from "../../apps/web/src/timeline/interact";
import { buildScene } from "../../apps/web/src/timeline/scene";
import { gut, LANE, RULER, type View } from "../../apps/web/src/timeline/view";
import { newTrack } from "../../packages/engine-client/src/editing";
import { newProject } from "../../packages/engine-client/src/project";

const video: Probed = { kind: "video", durationTicks: 10 * TICKS, width: 1920, height: 1080, rotation: 0, fps: { num: 30, den: 1 }, hasAudio: true, hasVideo: true };
const id = (n: string) => n.padStart(32, "0");
/** V1 (bottom video), V2 (top video), A1. A linked picture+sound pair at 0-4 s (picture on V1), a lone clip on V1 at 6-8 s, and a blocker on V2 at 0-2 s. */
function build() {
  const p = structuredClone(newProject("x"));
  p.media.push(mediaRef("m1", "v.mp4", "u", video, null));
  const seq = p.sequences[0]!;
  seq.tracks.splice(1, 0, newTrack(id("20"), "video", "V2")); // [V1, V2, A1]: stack order, bottom first
  const [v1, v2, a1] = seq.tracks as [typeof seq.tracks[0], typeof seq.tracks[0], typeof seq.tracks[0]];
  const c = (n: string, start: number, dur: number, link?: string) => ({ id: id(n), media: "m1", start: start * TICKS, source_in: 0, duration: dur * TICKS, speed: { num: 1, den: 1 }, ...(link ? { link } : {}) });
  v1.clips.push(c("a", 0, 4, id("f1")), c("c", 6, 2));
  a1.clips.push(c("b", 0, 4, id("f1")));
  v2.clips.push(c("d", 0, 2));
  return p;
}
const project = build();
const scene = buildScene(project);
// Display order: video tracks top of the stack first, then audio.
const rowOf = (name: string) => scene.trackName.indexOf(name);
const clipIdx = (cid: string) => scene.id.indexOf(id(cid));
const [pic, snd, lone, block] = [clipIdx("a"), clipIdx("b"), clipIdx("c"), clipIdx("d")];

test("display rows: V2 is above V1; a picture changes lane alone while its sound stays on its track", () => {
  assert.ok(rowOf("V2") < rowOf("V1") && rowOf("V1") < rowOf("A1"));
  assert.equal(laneChanger(scene, [pic, snd], rowOf("V2")), pic);
  assert.equal(laneChanger(scene, [pic, snd], rowOf("A1")), -1, "the sound is already on A1");
  assert.equal(laneChanger(scene, [pic, snd], rowOf("V1")), -1, "the picture is already on V1");
  assert.equal(laneChanger(scene, [pic, lone], rowOf("V2")), -1, "two pictures: no single one to move");
});

test("dragging a linked pair's picture onto V2 moves it there and shifts the sound in time; a blocked lane refuses", () => {
  const view: View = { pps: 100, scrollX: 0, scrollY: 0, width: 1200, height: 400 };
  const ctx = (): Ctx => ({ scene, view, selected: new Set([id("a"), id("b")]), selFlags: flagsOf(scene, [pic, snd]) });
  const ev = (xSec: number, row: number): PEvent => ({ x: gut(view) + xSec * view.pps, y: RULER + row * LANE + LANE / 2, kind: "mouse", shift: false, additive: false });
  // Press on the picture (V1) at 3 s (it spans 0-4 s), drag to V2 and 3.5 s later: 3.5-7.5 s is free on V2 (its blocker is 0-2 s).
  const down = pointerDown(ctx(), ev(3, rowOf("V1")));
  const m = pointerMove(ctx(), down.g, ev(3.5, rowOf("V2")));
  const mv = pointerMove(ctx(), m.g, ev(6.5, rowOf("V2")));
  assert.equal(mv.g.k, "move");
  assert.equal((mv.g as { track: number }).track, rowOf("V2"));
  const up = pointerUp(ctx(), mv.g, ev(6.5, rowOf("V2")));
  const ops = up.fx.ops!;
  assert.equal(ops.length, 2, "sound shifted, picture moved");
  const pm = ops.find((o) => o.op === "move" && o.clip === id("a")) as { track: string; start: number };
  const sm = ops.find((o) => o.op === "move" && o.clip === id("b")) as { track: string; start: number };
  assert.equal(pm.track, id("20"), "picture on V2");
  assert.equal(sm.track, scene.trackId[rowOf("A1")], "sound stays on A1");
  assert.equal(pm.start, sm.start, "same shift");
  assert.ok(pm.start > 0);
  // Only 0.5 s later it would overlap the blocker on V2 (0-2 s): does not fit, the clip stays on V1.
  const blocked = pointerMove(ctx(), down.g, ev(3.5, rowOf("V2")));
  assert.equal((blocked.g as { track: number }).track, rowOf("V1"));
  void block;
});

test("keyboard: one lane up or down, same kind only, refused when it would overlap", () => {
  const down = laneStepOps(scene, [lone], "up");
  assert.equal(down?.track, rowOf("V2"));
  assert.deepEqual(down?.ops, [{ op: "move", clip: id("c"), track: id("20"), start: 6 * TICKS }]);
  assert.equal(laneStepOps(scene, [pic, snd], "up"), null, "a is over the blocker on V2");
  assert.equal(laneStepOps(scene, [lone], "down")?.track, undefined, "below V1 is audio: no video lane");
  assert.equal(laneStepOps(scene, [snd], "up"), null, "audio cannot go to a video lane");
  assert.equal(laneOps(scene, [pic, snd], pic, rowOf("V2"), TICKS)[0]!.op, "move");
});

test("a media card dropped on a lane uses that lane and judges free space there only", () => {
  const ref = project.media[0]!;
  const v2 = project.sequences[0]!.tracks[1]!.id;
  assert.equal(destTracks(project, ref, v2).vt?.id, v2);
  assert.equal(destTracks(project, ref, undefined).vt?.id, project.sequences[0]!.tracks[0]!.id, "no target: the first video track");
  const ops = insertOps(project, ref, video, 5 * TICKS, undefined, v2)!;
  assert.equal(ops[0]!.op === "insert_clip" && ops[0].track, v2);
  assert.equal(ops[1]!.op === "insert_clip" && ops[1].track, project.sequences[0]!.tracks[2]!.id, "its sound goes to the first audio track");
  // V1 is busy at 6-8 s; V2 is free there, so a drop on V2 keeps its time instead of being pushed to the end.
  assert.equal(placeAt(project, 6 * TICKS, 2 * TICKS), 8 * TICKS, "all tracks: busy");
  assert.equal(placeAt(project, 6 * TICKS, 2 * TICKS, [v2]), 6 * TICKS, "V2 only: free");
});

test("keyboard reorder hops over exactly one neighbour and refuses at the ends", async () => {
  const { hopStep } = await import("../../apps/web/src/timeline/arrange");
  // V1 holds a (0-4 s, linked to the sound on A1) and c (6-8 s): the pair cannot hop over c (the sound has no neighbour), a lone c hops back over a? no: the pair's lengths differ.
  assert.deepEqual(hopStep(scene, [lone], 1), [], "c is the last clip on V1: nothing after it");
  const back = hopStep(scene, [lone], -1);
  assert.ok(back.length > 0, "c hops before a");
  assert.ok(back.every((o) => o.op === "move"));
  assert.deepEqual(hopStep(scene, [pic, snd], 1), [], "the sound has no neighbour, so the pair stays together");
  assert.deepEqual(hopStep(scene, [], 1), []);
});
