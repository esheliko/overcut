/** Linked picture and sound (TL-05): selection, trim, split, copy and unlink planning. The engine side (ops, undo, file) is tested in Rust. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { TICKS, insertOps, mediaRef, type Probed } from "../../apps/web/src/media/plan";
import { copyClips, planPlacement } from "../../apps/web/src/timeline/clipboard";
import { deleteOps, expandLinks, flagsOf, groupReps, linkedTrimOps, mirrorTrims, moveOps, partnersOf, splitOps, trimRange, unlinkOps } from "../../apps/web/src/timeline/edit";
import { applySelect, pointerUp, type Ctx } from "../../apps/web/src/timeline/interact";
import { buildScene } from "../../apps/web/src/timeline/scene";
import { newProject } from "../../packages/engine-client/src/project";
import type { Project } from "../../packages/engine-client/src";

let n = 0;
const nid = () => (++n).toString(16).padStart(32, "0");
const video: Probed = { kind: "video", durationTicks: 10 * TICKS, width: 1920, height: 1080, rotation: 0, fps: { num: 30, den: 1 }, hasAudio: true, hasVideo: true };

/** An import of a 10 s video with sound (picture on V1, sound on A1, linked), then a lone 2 s clip after it. */
function linked(): Project {
  const p = structuredClone(newProject("x"));
  const ref = mediaRef("m1", "v.mp4", "u", video, null);
  p.media.push(ref);
  const [v, a] = p.sequences[0]!.tracks;
  for (const o of insertOps(p, ref, video, 0, nid)!) if (o.op === "insert_clip") (o.track === v!.id ? v! : a!).clips.push(o.clip);
  v!.clips.push({ id: nid(), media: "m1", start: 12 * TICKS, source_in: 0, duration: 2 * TICKS, speed: { num: 1, den: 1 } });
  return p;
}
const project = linked();
const scene = buildScene(project);
const idx = (track: number, clip: number) => scene.trackFirst[track]! + clip;
const [pic, snd, lone] = [idx(0, 0), idx(1, 0), idx(0, 1)];

test("import links the picture and the sound of a video; audio-only, silent video and stills stay unlinked", () => {
  const p = newProject("x");
  const ref = mediaRef("m1", "v.mp4", "u", video, null);
  const clips = (ops: ReturnType<typeof insertOps>) => ops!.map((o) => (o.op === "insert_clip" ? o.clip : null)!);
  const [a, b] = clips(insertOps(p, ref, video, 0, nid));
  assert.ok(a!.link && a!.link === b!.link, "one shared link");
  assert.notEqual(a!.link, a!.id);
  assert.equal(clips(insertOps(p, ref, { ...video, hasAudio: false }, 0, nid))[0]!.link, undefined);
  const song = mediaRef("m2", "s.m4a", "u", { kind: "audio", durationTicks: 3 * TICKS, hasAudio: true, hasVideo: false }, null);
  assert.equal(clips(insertOps(p, song, { kind: "audio", durationTicks: 3 * TICKS, hasAudio: true, hasVideo: false }, 0, nid))[0]!.link, undefined);
  const still = mediaRef("m3", "p.jpg", "u", { kind: "image", durationTicks: null, hasAudio: false, hasVideo: true }, null);
  assert.equal(clips(insertOps(p, still, { kind: "image", durationTicks: null, hasAudio: false, hasVideo: true }, 0, nid))[0]!.link, undefined);
});

test("partners, expansion and one-clip counting follow the link", () => {
  assert.deepEqual(partnersOf(scene, pic), [snd]);
  assert.deepEqual(partnersOf(scene, lone), []);
  assert.deepEqual([...expandLinks(scene, [scene.id[snd]!])].sort(), [scene.id[pic]!, scene.id[snd]!].sort());
  assert.deepEqual([...expandLinks(scene, [scene.id[lone]!])], [scene.id[lone]]);
  assert.deepEqual(groupReps(scene, [pic, snd, lone]), [pic, lone], "the pair counts once");
});

test("selecting or toggling half of a link picks or drops both halves", () => {
  const set = applySelect(new Set(), { mode: "set", ids: [scene.id[snd]!] }, scene);
  assert.deepEqual([...set].sort(), [scene.id[pic]!, scene.id[snd]!].sort());
  const off = applySelect(set, { mode: "toggle", ids: [scene.id[pic]!] }, scene);
  assert.equal(off.size, 0);
  const add = applySelect(new Set([scene.id[lone]!]), { mode: "toggle", ids: [scene.id[pic]!] }, scene);
  assert.equal(add.size, 3);
});

test("delete and move of a selected pair cover both halves by the same amount", () => {
  assert.equal(deleteOps(scene, [pic, snd]).length, 2);
  const m = moveOps(scene, [pic, snd], TICKS);
  assert.deepEqual(m.map((o) => (o.op === "move" ? o.start : -1)), [TICKS + scene.tStart[pic]!, TICKS + scene.tStart[snd]!]);
});

test("trimming one half trims the other by the same amount, in one op list", () => {
  const ops = linkedTrimOps(scene, pic, "start", 3 * TICKS);
  assert.deepEqual(ops, [{ op: "trim_in", clip: scene.id[pic], start: 3 * TICKS }, { op: "trim_in", clip: scene.id[snd], start: 3 * TICKS }]);
  const out = linkedTrimOps(scene, snd, "end", 8 * TICKS);
  assert.deepEqual(out.map((o) => (o.op === "trim_out" ? o.end : -1)), [8 * TICKS, 8 * TICKS]);
  assert.equal(linkedTrimOps(scene, lone, "end", 13 * TICKS).length, 1, "a clip alone trims alone");
  assert.deepEqual(mirrorTrims(scene, [{ op: "trim_in", clip: scene.id[pic]!, start: 2 * TICKS }]).length, 2, "numeric timing is mirrored too");
  assert.deepEqual(mirrorTrims(scene, [{ op: "delete", clip: scene.id[pic]! }]).length, 1);
});

test("the trim range is what BOTH halves allow", () => {
  // The picture's end is stopped by the lone clip at 12 s; give the sound a 6 s tail room by shortening its media is not possible here, so
  // block the sound instead: a clip on A1 starting at 11 s.
  const p = structuredClone(project);
  p.sequences[0]!.tracks[1]!.clips.push({ id: nid(), media: "m1", start: 11 * TICKS, source_in: 0, duration: TICKS, speed: { num: 1, den: 1 } });
  p.media[0]!.duration = 20 * TICKS;
  const sc = buildScene(p);
  const r = trimRange(sc, sc.trackFirst[0]!, "end");
  assert.equal(r.max, 11 * TICKS, "the picture alone could reach 12 s, the sound stops at 11 s");
  // Locked partner does not limit and is not trimmed.
  p.sequences[0]!.tracks[1]!.locked = true;
  const lk = buildScene(p);
  assert.equal(trimRange(lk, lk.trackFirst[0]!, "end").max, 12 * TICKS);
  assert.equal(linkedTrimOps(lk, lk.trackFirst[0]!, "end", 10 * TICKS).length, 1);
});

test("dragging an edge applies the trim to the partner as well", () => {
  const c: Ctx = { scene, view: { pps: 40, scrollX: 0, scrollY: 0, width: 900, height: 400 }, selected: new Set(), selFlags: flagsOf(scene, []) };
  const r = pointerUp(c, { k: "trim", sx: 0, clip: pic, edge: "end", orig: 10 * TICKS, value: 9 * TICKS }, { x: 0, y: 0, kind: "mouse", shift: false, additive: false });
  assert.deepEqual(r.fx.ops?.map((o) => o.op), ["trim_out", "trim_out"]);
});

test("a split of both halves shares one new link; one half alone or an unlinked clip gets none", () => {
  let k = 100;
  const id = () => (++k).toString(16).padStart(32, "0");
  const both = splitOps(scene, [pic, snd], 4 * TICKS, id);
  assert.ok(both[0]!.op === "split" && both[0]!.new_link && both[1]!.op === "split" && both[1]!.new_link === both[0]!.new_link);
  const half = splitOps(scene, [pic], 4 * TICKS, id)[0]!;
  assert.ok(half.op === "split" && half.new_link === undefined);
  const alone = splitOps(scene, [lone], 13 * TICKS, id)[0]!;
  assert.ok(alone.op === "split" && alone.new_link === undefined);
});

test("copies of a pair are linked to each other (a new link); a lone copy of one half is unlinked", () => {
  const ids = new Set([scene.id[pic]!, scene.id[snd]!]);
  const plan = planPlacement(project, copyClips(project, ids), 30 * TICKS, null, nid);
  const copies = plan.ops.map((o) => (o.op === "insert_clip" ? o.clip : null)!);
  assert.equal(copies.length, 2);
  assert.ok(copies[0]!.link && copies[0]!.link === copies[1]!.link);
  assert.notEqual(copies[0]!.link, project.sequences[0]!.tracks[0]!.clips[0]!.link, "not the original's link");
  const one = planPlacement(project, copyClips(project, new Set([scene.id[snd]!])), 30 * TICKS, null, nid);
  assert.equal(one.ops[0]!.op === "insert_clip" && one.ops[0]!.clip.link, undefined);
});

test("unlink gives one set_link null per linked clip, and nothing for an unlinked selection", () => {
  assert.deepEqual(unlinkOps(scene, [pic, snd]).map((o) => o.op === "set_link" && o.link), [null, null]);
  assert.deepEqual(unlinkOps(scene, [lone]), []);
  const p = structuredClone(project);
  for (const t of p.sequences[0]!.tracks) for (const c of t.clips) delete c.link;
  const un = buildScene(p);
  assert.deepEqual(expandLinks(un, [un.id[0]!]).size, 1, "after unlinking, a click selects one clip");
});
