/** Moving clips between tracks (M2 multi-track): drag, keyboard step, and where a dropped media card lands. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { TICKS, destTracks, insertOps, mediaRef, placeAt, type Probed } from "../../apps/web/src/media/plan";
import { flagsOf, laneChanger, laneOps, laneShift, laneStepOps, laneTracks } from "../../apps/web/src/timeline/edit";
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
  assert.deepEqual(laneChanger(scene, [pic, snd], rowOf("V2")), { movers: [pic], dest: [rowOf("V2")] });
  assert.equal(laneChanger(scene, [pic, snd], rowOf("A1")), null, "the sound is already on A1");
  assert.equal(laneChanger(scene, [pic, snd], rowOf("V1")), null, "the picture is already on V1");
  assert.deepEqual(laneChanger(scene, [pic, lone], rowOf("V2")), { movers: [pic, lone], dest: [rowOf("V2"), rowOf("V2")] }, "two pictures change lane together");
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
  assert.equal(laneOps(scene, [pic, snd], laneChanger(scene, [pic, snd], rowOf("V2"))!, TICKS)[0]!.op, "move");
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

test("a video dropped over occupied time keeps its picture on the target lane; its sound takes a free audio track or a new one, in one batch", () => {
  const ref = project.media[0]!;
  const seq = project.sequences[0]!;
  const v2 = seq.tracks[1]!.id, a1 = seq.tracks[2]!.id;
  let n = 100;
  const ids = () => id(String(n++));
  // V2 is free from 3 s, A1 is busy until 4 s: the sound clashes on A1, yet the picture stays at 3 s on V2 (picture-in-picture from the bin).
  const start = placeAt(project, 3 * TICKS, 4 * TICKS, [v2]);
  assert.equal(start, 3 * TICKS);
  const ops = insertOps(project, ref, video, start, ids, v2)!;
  assert.equal(ops[0]!.op === "insert_clip" && ops[0].track, v2);
  const add = ops.find((o) => o.op === "add_track");
  assert.ok(add && add.op === "add_track" && add.track.kind === "audio" && add.track.name === "A2", "a new audio track A2");
  assert.equal(add!.op === "add_track" && add!.index, seq.tracks.length, "at the bottom");
  const snd = ops[ops.length - 1]!;
  assert.ok(snd.op === "insert_clip" && snd.track === (add as { track: { id: string } }).track.id && snd.clip.start === 3 * TICKS);
  assert.ok(ops.indexOf(add!) < ops.indexOf(snd), "the track exists before its clip is inserted");
  // Free on A1 (after 4 s): no new track, the sound goes to A1.
  const late = insertOps(project, ref, video, 5 * TICKS, ids, v2)!;
  assert.equal(late.some((o) => o.op === "add_track"), false);
  assert.equal(late[late.length - 1]!.op === "insert_clip" && (late[late.length - 1] as { track: string }).track, a1);
});

/** V1 and V2 and V3 (top), A1. Display order: V3, V2, V1, A1. Clips are 2 s long at the given starts. */
function stack(clips: Record<"V1" | "V2" | "V3" | "A1", number[]>) {
  const p = structuredClone(newProject("x"));
  p.media.push(mediaRef("m1", "v.mp4", "u", video, null));
  const seq = p.sequences[0]!;
  seq.tracks.splice(1, 0, newTrack(id("20"), "video", "V2"), newTrack(id("30"), "video", "V3"));
  const by = { V1: seq.tracks[0]!, V2: seq.tracks[1]!, V3: seq.tracks[2]!, A1: seq.tracks[3]! };
  let n = 1;
  const ids: Record<string, string> = {};
  for (const k of ["V1", "V2", "V3", "A1"] as const) for (const s of clips[k]) { const cid = id(`c${n++}`); ids[`${k}@${s}`] = cid; by[k].clips.push({ id: cid, media: "m1", start: s * TICKS, source_in: 0, duration: 2 * TICKS, speed: { num: 1, den: 1 } }); }
  const sc = buildScene(p);
  return { sc, row: (name: string) => sc.trackName.indexOf(name), at: (name: string, s: number) => sc.id.indexOf(ids[`${name}@${s}`]!) };
}

test("several same-kind clips change lane together by the same number of lanes; all or nothing", () => {
  const { sc, row, at } = stack({ V1: [0, 3], V2: [6], V3: [], A1: [] });
  const [x, y] = [at("V1", 0), at("V1", 3)];
  const mv = laneChanger(sc, [x, y], row("V2"))!;
  assert.deepEqual(mv, { movers: [x, y], dest: [row("V2"), row("V2")] });
  assert.equal(laneShift(sc, [x, y], flagsOf(sc, [x, y]), mv, 0), 0, "V2 is free at 0-5 s");
  const ops = laneOps(sc, [x, y], mv, 0);
  assert.equal(ops.length, 2);
  assert.ok(ops.every((o) => o.op === "move" && o.track === sc.trackId[row("V2")]));
  assert.deepEqual(laneTracks(sc, [x, y], mv), [row("V2"), row("V2")]);
  // The clip on V2 at 6-8 s blocks y once the pair is dragged 3 s later (6-8 s): nobody moves.
  assert.equal(laneShift(sc, [x, y], flagsOf(sc, [x, y]), mv, 3 * TICKS), null);
});

test("lane changes on different tracks keep their spacing; the clip furthest along moves first; one that would leave the stack refuses all", () => {
  const { sc, row, at } = stack({ V1: [0], V2: [0], V3: [], A1: [] });
  const [a, b] = [at("V1", 0), at("V2", 0)];
  assert.equal(laneChanger(sc, [a, b], row("V3")), null, "a (V1) to the top is +2 lanes: b (V2) would leave the stack");
  const up = laneChanger(sc, [a, b], row("V2"))!; // one lane up: V1 -> V2, V2 -> V3
  assert.deepEqual(up.dest, [row("V2"), row("V3")]);
  assert.equal(laneShift(sc, [a, b], flagsOf(sc, [a, b]), up, 0), 0, "V2's clip leaves, so V1's clip fits where it was");
  const ops = laneOps(sc, [a, b], up, 0);
  assert.deepEqual(ops.map((o) => o.op === "move" && o.clip), [sc.id[b], sc.id[a]], "V2 -> V3 first, then V1 -> V2");
});
