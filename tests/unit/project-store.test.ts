import test from "node:test";
import assert from "node:assert/strict";
import type { Editing, EditOutcome, Op, Project } from "../../packages/engine-client/src";
import { ProjectStore } from "../../apps/web/src/store/projectStore";
import { Player } from "../../apps/web/src/preview/player";

/** A stand-in engine: ops append clips ("add:<id>") and undo/redo walk a history, like the real one. */
function engine(initial: string[] = []) {
  let ids = [...initial];
  const past: string[][] = [];
  const future: string[][] = [];
  const project = (): Project => ({ sequences: [{ id: "s", tracks: [{ id: "t", clips: ids.map((id) => ({ id, start: 0, duration: 10 })) }] }], media: [] }) as unknown as Project;
  const out = (changed: boolean): EditOutcome => ({ changed, can_undo: past.length > 0, can_redo: future.length > 0 }) as EditOutcome;
  const ed = {
    open: async () => undefined,
    project: async () => project(),
    apply: async (ops: Op | Op[]) => { past.push([...ids]); future.length = 0; for (const o of [ops].flat()) ids = (o as unknown as { ids: string[] }).ids; return out(true); },
    undo: async () => { const p = past.pop(); if (!p) return out(false); future.push([...ids]); ids = p; return out(true); },
    redo: async () => { const f = future.pop(); if (!f) return out(false); past.push([...ids]); ids = f; return out(true); },
  } as unknown as Editing;
  return ed;
}
const set = (ids: string[]) => ({ ids }) as unknown as Op;
const clipIds = (s: ProjectStore) => s.getState().project!.sequences[0]!.tracks[0]!.clips.map((c) => c.id);

test("the store follows apply, undo and redo from any caller, and tells every subscriber", async () => {
  const s = new ProjectStore();
  let seen = 0;
  s.subscribe(() => seen++);
  await s.attach(engine(["a"]));
  assert.deepEqual(clipIds(s), ["a"]);
  await s.apply(set(["a", "b"]));
  assert.deepEqual(clipIds(s), ["a", "b"]);
  assert.equal(s.getState().canUndo, true);
  await s.undo();
  assert.deepEqual(clipIds(s), ["a"]);
  assert.equal(s.getState().canRedo, true);
  await s.redo();
  assert.deepEqual(clipIds(s), ["a", "b"]);
  assert.ok(seen >= 4);
});

test("calls are serialised in the order made, and a no-op undo keeps the same project object", async () => {
  const s = new ProjectStore();
  await s.attach(engine());
  await Promise.all([s.apply(set(["x"])), s.apply(set(["x", "y"])), s.undo()]);
  assert.deepEqual(clipIds(s), ["x"]);
  const s2 = new ProjectStore();
  await s2.attach(engine());
  const before = s2.getState().project;
  await s2.undo(); // nothing to undo
  assert.equal(s2.getState().project, before);
});

test("selection drops clips that an edit or undo removed, and keeps the same set when nothing was lost", async () => {
  const s = new ProjectStore();
  await s.attach(engine(["a"]));
  await s.apply(set(["a", "b"]));
  s.setSelection(new Set(["a", "b"]));
  const sel = s.getState().selection;
  await s.apply(set(["a", "b", "c"]));
  assert.equal(s.getState().selection, sel);
  await s.undo();
  await s.undo(); // back to ["a"]
  assert.deepEqual([...s.getState().selection], ["a"]);
});

test("playhead lives in the store; setting the same frame does not notify", () => {
  const s = new ProjectStore();
  let n = 0;
  s.subscribe(() => n++);
  s.setPlayhead(12);
  s.setPlayhead(12);
  assert.equal(s.getState().playhead, 12);
  assert.equal(n, 1);
});

test("attach(null) empties the store; a stale attach cannot overwrite a newer one", async () => {
  const s = new ProjectStore();
  const slow: Editing = { ...engine(["old"]), project: () => new Promise((r) => setTimeout(() => r({ sequences: [{ id: "s", tracks: [{ id: "t", clips: [{ id: "old", start: 0, duration: 1 }] }] }], media: [] } as unknown as Project), 20)) } as Editing;
  const first = s.attach(slow);
  await s.attach(engine(["new"]));
  await first;
  assert.deepEqual(clipIds(s), ["new"]);
  await s.attach(null);
  assert.equal(s.getState().project, null);
});

test("the player takes a new length and rate without being rebuilt", () => {
  const T = 705_600_000;
  const p = new Player({
    rate: { num: 30, den: 1 }, size: { width: 16, height: 16 }, endTicks: 2 * T, sequence: "s",
    evaluate: async (ticks, n) => ({ time: ticks, frame: 0, video_time: ticks, sample: 0, audio_samples: n, layers: [], audio: [] }),
    media: () => undefined,
    renderer: { render: () => undefined, dispose: () => undefined },
    fallbackClock: { now: () => 0 },
    onFrame: () => undefined,
    raf: () => () => undefined,
  });
  assert.equal(p.endFrame, 60);
  p.reconfigure({ endTicks: 1 * T });
  assert.equal(p.endFrame, 30);
  p.reconfigure({ endTicks: 3 * T, rate: { num: 24, den: 1 } });
  assert.equal(p.endFrame, 72);
  p.dispose();
});

test("attach reports the history the engine already has (a recovered session can undo before its first edit)", async () => {
  const s = new ProjectStore();
  await s.attach(engine(["a"]), { canUndo: true });
  assert.equal(s.getState().canUndo, true);
  assert.equal(s.getState().canRedo, false);
  await s.attach(engine(["a"])); // a fresh history (undo recovery, a new project)
  assert.equal(s.getState().canUndo, false);
});

test("undo and redo know the label of the step they would undo or redo; unlabelled and coalesced steps stay honest", async () => {
  const s = new ProjectStore();
  await s.attach(engine());
  assert.equal(s.getState().undoLabel, null);
  await s.apply(set(["a"]), undefined, "import of a.mp4");
  assert.equal(s.getState().undoLabel, "import of a.mp4");
  await s.apply(set(["a", "b"])); // no label: the control falls back to plain "Undo"
  assert.equal(s.getState().undoLabel, null);
  await s.undo();
  assert.equal(s.getState().undoLabel, "import of a.mp4");
  assert.equal(s.getState().redoLabel, null);
  await s.undo();
  assert.equal(s.getState().undoLabel, null); // nothing left to undo
  assert.equal(s.getState().redoLabel, "import of a.mp4");
  await s.redo();
  assert.equal(s.getState().undoLabel, "import of a.mp4");
  await s.apply(set(["x"]), undefined, "second"); // a new edit clears redo
  assert.equal(s.getState().redoLabel, null);
});

test("a drag (same coalesce key) is one undo step, so it adds one label, not one per move", async () => {
  const s = new ProjectStore();
  await s.attach(engine());
  await s.apply(set(["a"]), undefined, "first");
  const ed = (s as unknown as { editing: { apply: (o: Op | Op[], c?: number) => Promise<EditOutcome> } }).editing;
  const merging = { ...ed, apply: async () => ({ changed: true, can_undo: true, can_redo: false }) as EditOutcome };
  (s as unknown as { editing: unknown }).editing = merging; // the real engine merges steps sharing a key: outcome unchanged in depth
  await s.apply(set(["a"]), 7, "drag");
  await s.apply(set(["a"]), 7, "drag");
  assert.equal(s.getState().undoLabel, "drag");
  assert.equal((s as unknown as { undoStack: unknown[] }).undoStack.length, 2);
});

test("the history lists labelled steps and jumpTo undoes or redoes to any of them in one job", async () => {
  const s = new ProjectStore();
  await s.attach(engine(["a"]));
  await s.apply(set(["a", "b"]), undefined, "split 1 clip");
  await s.apply(set(["a", "b", "c"]), undefined, "paste of 1 clip");
  await s.apply(set(["a"]), undefined, "delete of 2 clips");
  assert.deepEqual(s.getState().undoSteps, ["split 1 clip", "paste of 1 clip", "delete of 2 clips"]);
  assert.deepEqual(s.getState().redoSteps, []);
  await s.jumpTo(1); // keep the first step only
  assert.deepEqual(clipIds(s), ["a", "b"]);
  assert.deepEqual(s.getState().undoSteps, ["split 1 clip"]);
  assert.deepEqual(s.getState().redoSteps, ["paste of 1 clip", "delete of 2 clips"], "next redo first");
  assert.equal(s.getState().undoLabel, "split 1 clip");
  assert.equal(s.getState().redoLabel, "paste of 1 clip");
  await s.jumpTo(3); // forward again, past the paste
  assert.deepEqual(clipIds(s), ["a"]);
  assert.equal(s.getState().canRedo, false);
  await s.jumpTo(0);
  assert.deepEqual(clipIds(s), ["a"]);
  assert.equal(s.getState().canUndo, false);
  assert.equal(s.getState().redoSteps.length, 3);
  await s.jumpTo(99); // clamps to everything redone
  assert.equal(s.getState().undoSteps.length, 3);
  await s.apply(set(["z"]), undefined, "new edit");
  await s.jumpTo(0);
  await s.apply(set(["y"]), undefined, "replaces the future");
  assert.deepEqual(s.getState().redoSteps, [], "a new edit clears the undone steps");
});

test("a recovered history shows one 'earlier edits' row; read-only projects refuse to jump", async () => {
  const s = new ProjectStore();
  await s.attach(engine(["a"]), { canUndo: true });
  assert.equal(s.getState().earlierEdits, true);
  s.setReadOnly(true);
  assert.equal(await s.jumpTo(0), null);
});
