import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SIZE, FPS_CHOICES, SHAPES, adoptedFormat, canvasOp, canvasSummary, choiceOf, fpsLabel, qualityOf, resolutionOf, sameCanvas, shapeOf, sizeOf, frameRateOf } from "../../apps/web/src/canvas";
import { importOps } from "../../apps/web/src/media/plan";
import { nameOfFile, projectFileName } from "../../apps/web/src/projectName";
import type { Project, Sequence } from "../../packages/engine-client/src/model.generated";
import { newProject } from "../../packages/engine-client/src/project";

const seqOf = (p: Project): Sequence => p.sequences[0]!;
const probed = { kind: "video" as const, durationTicks: 705_600_000, width: 1080, height: 1920, fps: { num: 60, den: 1 }, hasAudio: false, hasVideo: true };
const ref = (id: string) => ({ id, kind: "video" as const, name: "a.mp4", uri: "fs:a", hash: null, duration: 705_600_000 });

test("every preset gives even pixel sizes at every resolution, and the size maps back to its shape", () => {
  for (const s of SHAPES) {
    for (const q of [720, 1080, 1440, 2160]) {
      const r = sizeOf(s, q);
      assert.equal(r.width % 2, 0);
      assert.equal(r.height % 2, 0);
      assert.equal(Math.min(r.width, r.height), q);
      assert.equal(shapeOf(r), s.id, `${s.id} @ ${q}`);
      assert.equal(qualityOf(r), q);
    }
  }
  assert.deepEqual(sizeOf(SHAPES.find((s) => s.id === "9:16")!, 1080), { width: 1080, height: 1920 });
  assert.deepEqual(sizeOf(SHAPES.find((s) => s.id === "4:5")!, 1080), { width: 1080, height: 1350 });
  assert.deepEqual(sizeOf(SHAPES.find((s) => s.id === "21:9")!, 1080), { width: 2520, height: 1080 });
  assert.equal(shapeOf({ width: 1000, height: 777 }), "custom");
  assert.equal(qualityOf({ width: 1000, height: 777 }), null);
});

test("a new project follows its first clip until the canvas is chosen; a chosen canvas is never overwritten by an import", () => {
  const p = newProject("t");
  const seq = seqOf(p);
  const c = choiceOf(seq);
  assert.equal(c.shape, "match");
  assert.equal(c.fps, "match");
  assert.deepEqual(DEFAULT_SIZE, seq.resolution);
  // first import, nothing chosen: size and rate come from the clip (the zero-question flow)
  let ops = importOps(p, ref("a".repeat(32)), probed);
  assert.deepEqual(ops[1], { op: "set_sequence_format", sequence: seq.id, frame_rate: { num: 60, den: 1 }, resolution: { width: 1080, height: 1920 } });
  // size chosen (1:1), rate not: the clip sets only the rate
  const sq = { ...seq, size_fixed: true, resolution: { width: 1080, height: 1080 } };
  const withSq = { ...p, sequences: [sq] };
  ops = importOps(withSq, ref("b".repeat(32)), probed);
  assert.deepEqual(ops[1], { op: "set_sequence_format", sequence: seq.id, frame_rate: { num: 60, den: 1 }, resolution: { width: 1080, height: 1080 } });
  // both chosen: the import adds media only
  const both = { ...p, sequences: [{ ...sq, rate_fixed: true }] };
  assert.equal(importOps(both, ref("c".repeat(32)), probed).length, 1);
  assert.equal(adoptedFormat({ ...sq, rate_fixed: true }, { frame_rate: { num: 1, den: 1 }, resolution: { width: 2, height: 2 } }), null);
});

test("a choice becomes one set_canvas op; 'match' keeps the current values and leaves them unfixed", () => {
  const seq = seqOf(newProject("t"));
  const c = { ...choiceOf(seq), shape: "9:16", short: 1080, fps: "25" };
  assert.deepEqual(canvasOp(seq, c), { op: "set_canvas", sequence: seq.id, resolution: { width: 1080, height: 1920 }, frame_rate: { num: 25, den: 1 }, size_fixed: true, rate_fixed: true });
  const m = canvasOp({ ...seq, resolution: { width: 640, height: 480 } }, choiceOf(seq));
  assert.deepEqual(m, { op: "set_canvas", sequence: seq.id, resolution: { width: 640, height: 480 }, frame_rate: seq.frame_rate, size_fixed: false, rate_fixed: false });
  assert.equal(sameCanvas(seq, choiceOf(seq)), true, "nothing to apply");
  assert.equal(sameCanvas(seq, c), false);
  // a custom size is clamped and made even
  assert.deepEqual(resolutionOf({ ...c, shape: "custom", custom: { width: 1001, height: 5 } }, seq.resolution), { width: 1002, height: 16 });
  assert.deepEqual(resolutionOf({ ...c, shape: "custom", custom: { width: 99999, height: 720 } }, seq.resolution), { width: 8192, height: 720 });
  assert.deepEqual(frameRateOf({ ...c, fps: "match" }, { num: 24000, den: 1001 }), { num: 24000, den: 1001 });
});

test("the dialog starts from what the sequence says, including a non-preset size and rate", () => {
  const seq = { ...seqOf(newProject("t")), size_fixed: true, rate_fixed: true, resolution: { width: 1000, height: 777 }, frame_rate: { num: 24000, den: 1001 } };
  const c = choiceOf(seq);
  assert.equal(c.shape, "custom");
  assert.equal(c.fps, "custom");
  assert.deepEqual(c.custom, { width: 1000, height: 777 });
  assert.equal(fpsLabel({ num: 24000, den: 1001 }), "23.976");
  assert.equal(fpsLabel({ num: 30, den: 1 }), "30");
  assert.equal(canvasSummary(seq.resolution, seq.frame_rate), "1000:777 · 1000 × 777 · 23.976 fps");
  assert.deepEqual([...FPS_CHOICES], [24, 25, 30, 50, 60]);
});

test("project file names are safe and round-trip", () => {
  assert.equal(projectFileName("My film"), "My film.overcut");
  assert.equal(projectFileName("a/b\\c:d*e?.overcut"), "abcde.overcut");
  assert.equal(projectFileName("   "), "Untitled project.overcut");
  assert.equal(projectFileName("x".repeat(200)).length, 80 + ".overcut".length);
  assert.equal(nameOfFile("My film.OVERCUT"), "My film");
  assert.equal(nameOfFile("plain"), "plain");
});
