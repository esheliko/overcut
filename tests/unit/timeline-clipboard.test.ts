import assert from "node:assert/strict";
import { test } from "node:test";
import type { Clip, Project } from "../../packages/engine-client/src";
import { copyClips, duplicateAt, planPlacement, selectedTrack, timingOps } from "../../apps/web/src/timeline/clipboard";
import { trimRange } from "../../apps/web/src/timeline/edit";
import { fixtureProject } from "../../apps/web/src/timeline/fixture";
import { buildScene, TICKS_PER_SECOND as TPS } from "../../apps/web/src/timeline/scene";
import { globalCommand, type KeyLike } from "../../apps/web/src/timeline/shortcuts";
import { parseTimecode, timecode } from "../../apps/web/src/timecode";

const key = (o: Partial<KeyLike> & { key: string }): KeyLike => ({ code: "", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o });
let n = 0;
const nid = () => (++n).toString(16).padStart(32, "0");
const fresh = (): Project => structuredClone(fixtureProject({ tracks: 4, clipsPerTrack: 4 }));
const tr = (p: Project, i: number) => p.sequences[0]!.tracks[i]!;
const inserts = (ops: ReturnType<typeof planPlacement>["ops"]) => ops.map((o) => { assert.equal(o.op, "insert_clip"); return o as Extract<typeof o, { op: "insert_clip" }>; });
/** Apply the plan to a copy and check the track stays sorted and non-overlapping, like `Project::validate`. */
function applied(p: Project, ops: ReturnType<typeof planPlacement>["ops"]): Project {
  const q = structuredClone(p);
  for (const o of inserts(ops)) { const t = q.sequences[0]!.tracks.find((x) => x.id === o.track)!; t.clips.push(o.clip); t.clips.sort((a, b) => a.start - b.start); }
  for (const t of q.sequences[0]!.tracks) t.clips.forEach((c, i) => { if (i > 0) assert.ok(c.start >= t.clips[i - 1]!.start + t.clips[i - 1]!.duration, "no overlap"); });
  return q;
}

test("copyClips takes independent copies, earliest first", () => {
  const p = fresh();
  const [a, b] = [tr(p, 0).clips[1]!, tr(p, 0).clips[0]!];
  const held = copyClips(p, new Set([a.id, b.id]));
  assert.deepEqual(held.map((h) => h.clip.id), [b.id, a.id]);
  held[0]!.clip.start = 7;
  assert.notEqual(b.start, 7, "editing the copy never changes the project");
  assert.equal(copyClips(p, new Set(["nope"])).length, 0);
});

test("duplicate lands right after the clip, on the same track, with a new id", () => {
  const p = fresh();
  const c = tr(p, 0).clips[3]!; // last clip: free space after it
  const held = copyClips(p, new Set([c.id]));
  const plan = planPlacement(p, held, duplicateAt(held), null, nid);
  const [op] = inserts(plan.ops);
  assert.equal(plan.placed, 1);
  assert.equal(op!.track, tr(p, 0).id);
  assert.equal(op!.clip.start, c.start + c.duration);
  assert.equal(op!.clip.duration, c.duration);
  assert.equal(op!.clip.source_in, c.source_in);
  assert.equal(op!.clip.media, c.media);
  assert.notEqual(op!.clip.id, c.id);
  applied(p, plan.ops);
});

test("duplicate in the middle of a track slides to the next free slot instead of overlapping", () => {
  const p = fresh();
  const c = tr(p, 0).clips[0]!; // the next clip starts 1 s after it: the copy does not fit there
  const held = copyClips(p, new Set([c.id]));
  const plan = planPlacement(p, held, duplicateAt(held), null, nid);
  const q = applied(p, plan.ops);
  const start = inserts(plan.ops)[0]!.clip.start;
  assert.ok(start >= tr(p, 0).clips[1]!.start + tr(p, 0).clips[1]!.duration, "after the neighbour it would have hit");
  assert.equal(tr(q, 0).clips.length, 5);
});

test("a group keeps its offsets and moves as one", () => {
  const p = fresh();
  const [a, b] = tr(p, 0).clips.slice(0, 2) as [Clip, Clip];
  const held = copyClips(p, new Set([a.id, b.id]));
  const at = 100 * TPS; // far past everything
  const plan = planPlacement(p, held, at, null, nid);
  const ops = inserts(plan.ops);
  assert.equal(ops[0]!.clip.start, at);
  assert.equal(ops[1]!.clip.start - ops[0]!.clip.start, b.start - a.start);
  assert.equal(plan.start, at);
  assert.equal(new Set(ops.map((o) => o.clip.id)).size, 2);
});

test("paste goes to the selected track when the clipboard came from one track of the same kind", () => {
  const p = fresh();
  const c = tr(p, 0).clips[0]!;
  const held = copyClips(p, new Set([c.id]));
  const other = tr(p, 2); // another video track
  assert.equal(selectedTrack(p, new Set([other.clips[0]!.id])), other.id);
  const plan = planPlacement(p, held, 200 * TPS, other.id, nid);
  assert.equal(inserts(plan.ops)[0]!.track, other.id);
  // the wrong kind (audio) is ignored: the clip returns to its own track
  const audio = planPlacement(p, held, 200 * TPS, tr(p, 1).id, nid);
  assert.equal(inserts(audio.ops)[0]!.track, tr(p, 0).id);
});

test("paste skips clips whose track is locked or gone, and says how many", () => {
  const p = fresh();
  const held = copyClips(p, new Set([tr(p, 0).clips[0]!.id, tr(p, 2).clips[0]!.id]));
  tr(p, 2).locked = true;
  const plan = planPlacement(p, held, 300 * TPS, null, nid);
  assert.equal(plan.placed, 1);
  assert.equal(plan.skipped, 1);
  p.sequences[0]!.tracks.splice(0, 1);
  assert.equal(planPlacement(p, held, 300 * TPS, null, nid).placed, 0);
  assert.deepEqual(planPlacement(p, [], 0, null, nid).ops, []);
});

test("paste at a time before 0 starts at 0 and never overlaps what is there", () => {
  const p = fresh();
  const held = copyClips(p, new Set([tr(p, 0).clips[2]!.id]));
  const plan = planPlacement(p, held, -5 * TPS, null, nid);
  applied(p, plan.ops);
  assert.ok(inserts(plan.ops)[0]!.clip.start >= 0);
});

test("numeric timing becomes one trim op, validated against the allowed range", () => {
  const p = fresh();
  const scene = buildScene(p);
  const i = scene.trackFirst[1]! + 1; // second clip of the first model track (row 1 once video rows are shown top-down): free space before and after
  const c = tr(p, 0).clips[1]!;
  const ft = scene.frameTicks;
  const sr = trimRange(scene, i, "start"), er = trimRange(scene, i, "end");
  const span = { start: c.start, end: c.start + c.duration };
  const dur = timingOps(c.id, span, "duration", 2 * TPS, sr, er);
  assert.deepEqual(dur, { ok: true, ops: [{ op: "trim_out", clip: c.id, end: c.start + 2 * TPS }] });
  const end = timingOps(c.id, span, "end", span.end - ft, sr, er);
  assert.deepEqual(end, { ok: true, ops: [{ op: "trim_out", clip: c.id, end: span.end - ft }] });
  const start = timingOps(c.id, span, "start", span.start + ft, sr, er);
  assert.deepEqual(start, { ok: true, ops: [{ op: "trim_in", clip: c.id, start: span.start + ft }] });
  assert.deepEqual(timingOps(c.id, span, "end", span.end, sr, er), { ok: true, ops: [] }, "unchanged = nothing to do");
  const bad = timingOps(c.id, span, "start", span.end, sr, er);
  assert.equal(bad.ok, false);
  assert.equal(!bad.ok && bad.reason, "range", "a clip cannot start at its own end");
  assert.equal(timingOps(c.id, span, "end", Number.NaN, sr, er).ok, false);
  const overNeighbour = timingOps(c.id, span, "end", er.max + ft, sr, er);
  assert.equal(overNeighbour.ok, false);
});

test("timecodes parse like they are shown, and nothing else", () => {
  for (const f of [0, 1, 29, 30, 31, 1799, 1800, 5999]) assert.equal(parseTimecode(timecode(f)), f);
  assert.equal(parseTimecode("00:12:15"), 12 * 30 + 15);
  assert.equal(parseTimecode("1:02:03"), (60 + 2) * 30 + 3);
  assert.equal(parseTimecode("12:15"), 375);
  assert.equal(parseTimecode("45"), 45, "a bare number is frames");
  assert.equal(parseTimecode(" 00;00;10 "), 10);
  assert.equal(parseTimecode("01:00:00:00"), 3600 * 30);
  assert.equal(parseTimecode("00:00:30"), null, "30 frames at 30 fps is out of range");
  assert.equal(parseTimecode("00:60:00"), null);
  assert.equal(parseTimecode("1.5"), parseTimecode("1:5"), "a dot is a separator, not a fraction");
  for (const bad of ["", "abc", "-1", "1:-2", "1::2", "1:2:3:4:5", "00:00:1x"]) assert.equal(parseTimecode(bad), null, bad);
  assert.equal(parseTimecode("00:00:24", 24), null);
  assert.equal(parseTimecode("00:01:00", 24), 24);
});

test("copy / cut / paste / duplicate shortcuts", () => {
  const mod = { ctrlKey: true };
  assert.deepEqual(globalCommand(key({ key: "c", ...mod })), { c: "copy" });
  assert.deepEqual(globalCommand(key({ key: "x", ...mod })), { c: "cut" });
  assert.deepEqual(globalCommand(key({ key: "v", metaKey: true })), { c: "paste" });
  assert.deepEqual(globalCommand(key({ key: "d", ...mod })), { c: "duplicate" });
  assert.equal(globalCommand(key({ key: "c", ...mod, shiftKey: true })), null);
  assert.equal(globalCommand(key({ key: "c", ...mod, altKey: true })), null);
  assert.equal(globalCommand(key({ key: "c" })), null, "a bare C is not a command");
});
