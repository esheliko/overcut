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

// ---- Op patches (ADR 0020): the store applies the engine's patch to its copy instead of re-reading the whole project ----

/** An engine whose outcomes carry a patch; counts `project()` reads. Revisions count changes like the real one. */
function patched(opts: { patches?: boolean; skipRevision?: boolean } = {}) {
  const { patches = true } = opts;
  let clips = [{ id: "a", start: 0, duration: 10 }, { id: "b", start: 20, duration: 10 }];
  const other = { id: "t2", clips: [{ id: "z", start: 0, duration: 5 }] };
  let rev = 0;
  const past: (typeof clips)[] = [];
  const future: (typeof clips)[] = [];
  const stats = { reads: 0 };
  const project = () => ({ sequences: [{ id: "s", tracks: [{ id: "t", clips }, other] }], media: [] }) as unknown as Project;
  const patchOf = (from: typeof clips, to: typeof clips) => {
    let p = 0;
    while (p < from.length && p < to.length && from[p] === to[p]) p++;
    let s = 0;
    while (s < from.length - p && s < to.length - p && from[from.length - 1 - s] === to[to.length - 1 - s]) s++;
    return { sequences: [{ id: "s", tracks: [{ id: "t", splice: { start: p, remove: from.length - p - s, insert: to.slice(p, to.length - s) } }] }] };
  };
  const out = (changed: boolean, from: typeof clips): EditOutcome => ({ changed, revision: rev, can_undo: past.length > 0, can_redo: future.length > 0, ...(changed && patches ? { patch: patchOf(from, clips) } : {}) }) as unknown as EditOutcome;
  const ed = {
    open: async () => undefined,
    project: async () => (stats.reads++, project()),
    apply: async (ops: Op | Op[]) => { const from = clips; past.push(clips); future.length = 0; clips = (ops as unknown as { clips: typeof clips }).clips; rev += opts.skipRevision ? 2 : 1; return out(true, from); },
    undo: async () => { const p = past.pop(); if (!p) return out(false, clips); const from = clips; future.push(clips); clips = p; rev++; return out(true, from); },
    redo: async () => { const f = future.pop(); if (!f) return out(false, clips); const from = clips; past.push(clips); clips = f; rev++; return out(true, from); },
  } as unknown as Editing;
  return { ed, stats, other, get clips() { return clips; } };
}
const edit = (clips: unknown[]) => ({ clips }) as unknown as Op;
const idsOf = (s: ProjectStore) => s.getState().project!.sequences[0]!.tracks[0]!.clips.map((c) => c.id);

test("with a patch the store does not re-read the project, and untouched tracks and clips keep their identity", async () => {
  const e = patched();
  const s = new ProjectStore();
  await s.attach(e.ed);
  assert.equal(e.stats.reads, 1);
  const before = s.getState().project!;
  const [a, b] = e.clips;
  await s.apply(edit([a, { id: "c", start: 10, duration: 5 }, b]));
  assert.equal(e.stats.reads, 1, "no project() read after the edit");
  assert.deepEqual(idsOf(s), ["a", "c", "b"]);
  const after = s.getState().project!;
  assert.notEqual(after, before);
  assert.equal(after.sequences[0]!.tracks[1], before.sequences[0]!.tracks[1], "the other track is the same object");
  assert.equal(after.sequences[0]!.tracks[0]!.clips[0], before.sequences[0]!.tracks[0]!.clips[0], "an untouched clip is the same object");
  await s.undo();
  await s.redo();
  assert.equal(e.stats.reads, 1);
  assert.deepEqual(idsOf(s), ["a", "c", "b"]);
});

test("the store re-reads when an outcome has no patch, when revisions skip (the engine changed behind us), or when the patch does not fit", async () => {
  const none = patched({ patches: false });
  const s1 = new ProjectStore();
  await s1.attach(none.ed);
  await s1.apply(edit([none.clips[0]]));
  assert.equal(none.stats.reads, 2);
  assert.deepEqual(idsOf(s1), ["a"]);

  const skip = patched({ skipRevision: true });
  const s2 = new ProjectStore();
  await s2.attach(skip.ed);
  await s2.apply(edit([skip.clips[0]])); // first outcome after a read: nothing to compare with, trusted
  await s2.apply(edit([])); // revision jumped by 2: re-read
  assert.equal(skip.stats.reads, 3 - 1, "one re-read for the second edit");
  assert.deepEqual(idsOf(s2), []);

  const bad = patched();
  const s3 = new ProjectStore();
  await s3.attach(bad.ed);
  const orig = bad.ed.apply;
  bad.ed.apply = async (o, c) => { const r = await orig(o, c); return { ...r, patch: { sequences: [{ id: "gone", tracks: [] }] } }; };
  await s3.apply(edit([bad.clips[0]]));
  assert.deepEqual(idsOf(s3), ["a"], "fell back to the engine's project");
});

test("jumpTo applies every step's patch and reads nothing", async () => {
  const e = patched();
  const s = new ProjectStore();
  await s.attach(e.ed);
  const [a, b] = e.clips;
  await s.apply(edit([a]), undefined, "one");
  await s.apply(edit([]), undefined, "two");
  await s.apply(edit([b]), undefined, "three");
  await s.jumpTo(0);
  assert.deepEqual(idsOf(s), ["a", "b"]);
  await s.jumpTo(3);
  assert.deepEqual(idsOf(s), ["b"]);
  assert.equal(e.stats.reads, 1);
});
