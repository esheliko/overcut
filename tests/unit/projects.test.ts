import assert from "node:assert/strict";
import test from "node:test";
import { copyName, ProjectLibrary, type KeyValue } from "../../packages/engine-client/src/persist/library";
import { memoryStorage } from "../../packages/engine-client/src/persist/memory";
import { VersionStore, VERSIONS_FILE, type VersionMeta } from "../../packages/engine-client/src/persist/versions";
import type { Editing, EditOutcome, Op, Project } from "../../packages/engine-client/src";
import { afterApply, afterRedo, afterUndo, describeOps, EMPTY_HISTORY } from "../../apps/web/src/store/history";
import { ProjectStore } from "../../apps/web/src/store/projectStore";
import { fixtureProject } from "../../apps/web/src/timeline/fixture";
import { importOps, type Probed } from "../../apps/web/src/media/plan";
import { CANVAS_PRESETS, nearestRatio, presetSize } from "../../apps/web/src/project/presets";
import { restoreOps } from "../../apps/web/src/project/restore";

const kv = (): KeyValue & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
};

test("the project list: newest first, merge on upsert, rename, remove, and a damaged index reads as empty", () => {
  const store = kv();
  const lib = new ProjectLibrary(store);
  lib.upsert("a", { name: "Alpha", updatedAt: 100 }, 100);
  lib.upsert("b", { name: "Beta", updatedAt: 200 }, 200);
  lib.upsert("a", { seconds: 12 }, 300); // merge keeps the name; updatedAt moves to now
  assert.deepEqual(lib.list().map((m) => m.id), ["a", "b"]);
  assert.equal(lib.get("a")!.name, "Alpha");
  assert.equal(lib.get("a")!.seconds, 12);
  lib.rename("a", "  Gamma  ");
  assert.equal(lib.get("a")!.name, "Gamma");
  assert.equal(lib.get("a")!.updatedAt, 300, "renaming is not an edit");
  lib.rename("a", "   ");
  assert.equal(lib.get("a")!.name, "Gamma", "an empty name is ignored");
  lib.remove("a");
  assert.deepEqual(lib.list().map((m) => m.id), ["b"]);
  store.map.set("overcut.projects.v1", "{not json");
  assert.deepEqual(lib.list(), []);
  assert.deepEqual(new ProjectLibrary(kv()).list(), []);
});

test("which project opens at start: the legacy one first, then the last open, null = Projects home", () => {
  const lib = new ProjectLibrary(kv());
  assert.equal(lib.currentId(), "default");
  lib.setCurrent("p-1");
  assert.equal(lib.currentId(), "p-1");
  lib.setCurrent(null);
  assert.equal(lib.currentId(), null);
  lib.upsert("p-1", { name: "x" });
  lib.setCurrent("p-1");
  lib.remove("p-1");
  assert.equal(lib.currentId(), null, "deleting the open project goes home");
  assert.match(ProjectLibrary.newId(), /^p-[a-z0-9]{1,14}$/);
});

test("duplicate names count up", () => {
  assert.equal(copyName("Trip", ["Trip"]), "Trip copy");
  assert.equal(copyName("Trip", ["Trip", "Trip copy"]), "Trip copy 2");
  assert.equal(copyName("Trip copy", ["Trip", "Trip copy"]), "Trip copy 2");
});

const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill);

test("versions: named and automatic snapshots, newest first, an unchanged automatic one is skipped", async () => {
  const vs = new VersionStore(memoryStorage());
  const a = await vs.save(bytes(10, 1), null, 1000);
  assert.ok(a?.auto);
  assert.equal(await vs.save(bytes(10, 1), null, 2000), null, "same bytes as the newest: nothing new");
  const n = await vs.save(bytes(10, 1), "Before the cut", 3000);
  assert.equal(n?.name, "Before the cut");
  assert.equal(n?.auto, false);
  assert.deepEqual((await vs.list()).map((v) => v.name), ["Before the cut", null]);
  assert.deepEqual([...(await vs.read(a!.id))!], [...bytes(10, 1)]);
  await vs.rename(a!.id, "Kept");
  assert.equal((await vs.list()).find((v) => v.id === a!.id)!.auto, false);
});

test("versions: keeps the last 20 automatic ones and every named one; the size cap drops the oldest automatic first", async () => {
  const st = memoryStorage();
  const vs = new VersionStore(st);
  await vs.save(bytes(5, 99), "Named early", 1);
  for (let i = 0; i < 25; i++) await vs.save(bytes(5, i), null, 10 + i);
  const list = await vs.list();
  assert.equal(list.filter((v) => v.auto).length, 20);
  assert.ok(list.some((v) => v.name === "Named early"), "named versions are never pruned by the count");
  assert.equal(await vs.read(list.at(-1)!.id) !== null, true);
  // dropped files are gone from storage, not just from the list
  const files = [...st.raw.files.keys()].filter((k) => k.startsWith("v-"));
  assert.equal(new Set(files.map((f) => f.replace(/\.(0|1|log)$/, ""))).size, 21);

  const small = new VersionStore(memoryStorage(), { autoKeep: 20, capBytes: 100 });
  await small.save(bytes(60, 1), "Old named", 1);
  await small.save(bytes(30, 2), null, 2);
  await small.save(bytes(30, 3), null, 3);
  const kept = await small.list();
  assert.deepEqual(kept.map((v) => v.at), [3, 1], "the oldest automatic one went first; the named one and the newest stay");
  const tiny = new VersionStore(memoryStorage(), { autoKeep: 20, capBytes: 10 });
  await tiny.save(bytes(60, 1), "Big", 1);
  assert.equal((await tiny.list()).length, 1, "the newest always stays, even over the cap");
});

test("versions: a damaged list reads as empty, and erasing a project removes every file", async () => {
  const st = memoryStorage();
  const vs = new VersionStore(st);
  await vs.save(bytes(4), "x", 1);
  await st.writeAtomic("project.overcut", bytes(3));
  await VersionStore.eraseAll(st);
  assert.deepEqual([...st.raw.files.keys()], []);
  await st.writeAtomic(VERSIONS_FILE, new TextEncoder().encode("garbage"));
  assert.deepEqual(await vs.list(), []);
});

// ---- restore: applying the ops to a project turns it into the target, one atomic edit ----
type P = Project;
function applyRef(p: P, ops: Op[]): P {
  const q = JSON.parse(JSON.stringify(p)) as P;
  const ids = () => new Set(q.sequences.flatMap((s) => s.tracks.flatMap((t) => t.clips.map((c) => c.id))));
  for (const o of ops) {
    if (o.op === "delete") {
      const t = q.sequences.flatMap((s) => s.tracks).find((x) => x.clips.some((c) => c.id === o.clip));
      assert.ok(t, "delete of an existing clip");
      t.clips = t.clips.filter((c) => c.id !== o.clip);
    } else if (o.op === "insert_clip") {
      assert.ok(!ids().has(o.clip.id), "the id is free when inserted");
      const t = q.sequences.flatMap((s) => s.tracks).find((x) => x.id === o.track)!;
      for (const c of t.clips) assert.ok(o.clip.start + o.clip.duration <= c.start || c.start + c.duration <= o.clip.start, "no overlap while restoring");
      assert.ok(q.media.some((m) => m.id === o.clip.media), "the media exists before a clip uses it");
      t.clips.push(o.clip);
    } else if (o.op === "add_media") q.media.push(o.media);
    else if (o.op === "remove_media") {
      assert.ok(!q.sequences.some((s) => s.tracks.some((t) => t.clips.some((c) => c.media === o.media))), "media in use cannot be removed");
      q.media = q.media.filter((m) => m.id !== o.media);
    } else if (o.op === "set_media") {
      const m = q.media.find((x) => x.id === o.media)!;
      m.uri = o.uri;
      m.hash = o.hash;
    } else if (o.op === "set_sequence_format") {
      const s = q.sequences.find((x) => x.id === o.sequence)!;
      s.frame_rate = o.frame_rate;
      s.resolution = o.resolution;
    } else assert.fail(`unexpected op ${o.op}`);
  }
  const norm = (x: P): P => ({ ...x, media: [...x.media].sort((a, b) => a.id.localeCompare(b.id)), sequences: x.sequences.map((s) => ({ ...s, tracks: s.tracks.map((t) => ({ ...t, clips: [...t.clips].sort((a, b) => a.start - b.start) })) })) });
  return norm(q);
}
const norm = (x: P): P => applyRef(x, []);

test("restore: the ops reach the target exactly (moved, trimmed, deleted, added clips, media, canvas) in an order the engine accepts", () => {
  const target = fixtureProject({ tracks: 4, clipsPerTrack: 5 });
  const current = JSON.parse(JSON.stringify(target)) as P;
  const tr = current.sequences[0]!.tracks;
  tr[0]!.clips[1]!.start += 1000; // moved
  tr[0]!.clips[2]!.duration -= 10; // trimmed
  tr[0]!.clips.pop(); // deleted since
  tr[1]!.clips.push({ ...tr[1]!.clips[0]!, id: "ffffffffffffffffffffffffffffffff", start: 10 ** 12 }); // added since
  current.media.push({ id: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", kind: "video", name: "new.mp4", uri: "x", hash: null, duration: 1 } as P["media"][number]);
  current.sequences[0]!.resolution = { width: 1080, height: 1920 };
  const ops = restoreOps(current, target)!;
  assert.ok(ops.length > 0);
  assert.deepEqual(applyRef(current, ops), norm(target));
  assert.deepEqual(restoreOps(target, target), [], "nothing to do when they are the same");
});

test("restore: a project with different tracks cannot be restored by ops (null), never half-applied", () => {
  const a = fixtureProject({ tracks: 2, clipsPerTrack: 2 });
  const b = fixtureProject({ tracks: 4, clipsPerTrack: 2 });
  assert.equal(restoreOps(a, b), null);
});

// ---- history panel ----
test("history names: what the user did, in terms of the clip's file", () => {
  const p = fixtureProject({ tracks: 2, clipsPerTrack: 2 });
  const clip = p.sequences[0]!.tracks[0]!.clips[0]!;
  const name = p.media.find((m) => m.id === clip.media)!.name;
  assert.deepEqual(describeOps([{ op: "split", clip: clip.id, at: 5, new_id: "x" }], p), { key: "history.split", params: {} });
  assert.deepEqual(describeOps([{ op: "trim_out", clip: clip.id, end: 5 }], p), { key: "history.trimEnd", params: { name } });
  assert.deepEqual(describeOps([{ op: "trim_in", clip: clip.id, start: 5 }], p), { key: "history.trimStart", params: { name } });
  assert.deepEqual(describeOps([{ op: "delete", clip: clip.id }], p), { key: "history.delete", params: { name } });
  assert.equal(describeOps([{ op: "set_sequence_format", sequence: "s", frame_rate: { num: 30, den: 1 }, resolution: { width: 1080, height: 1080 } }], p).params.size, "1080×1080");
  assert.equal(describeOps([{ op: "add_media", media: { id: "m", kind: "video", name: "Beach.mp4", uri: "u", hash: null, duration: 1 } as P["media"][number] }, { op: "insert_clip", track: "t", clip }], p).key, "history.import");
  assert.equal(describeOps([], p).key, "history.edit");
});

test("history steps follow apply, undo, redo; one drag is one step; a new edit drops the redo side", () => {
  const e = (n: number, coalesce?: number) => ({ label: { key: `k${n}`, params: {} }, coalesce });
  let h = afterApply(EMPTY_HISTORY, e(1));
  h = afterApply(h, e(2, 7));
  h = afterApply(h, e(3, 7)); // same drag
  assert.deepEqual(h.past.map((x) => x.label.key), ["k1", "k2"]);
  h = afterUndo(afterUndo(h));
  assert.equal(h.past.length, 0);
  assert.deepEqual(h.future.map((x) => x.label.key), ["k1", "k2"]);
  h = afterRedo(h);
  assert.deepEqual(h.past.map((x) => x.label.key), ["k1"]);
  h = afterApply(h, e(4));
  assert.deepEqual(h.future, []);
  assert.deepEqual(afterUndo(EMPTY_HISTORY), EMPTY_HISTORY);
});

/** A stand-in engine with a real undo stack, to drive the store's history and jumpTo. */
function stack() {
  const done: string[] = [];
  const undone: string[] = [];
  const project = () => ({ sequences: [{ id: "s", tracks: [{ id: "t", clips: done.map((id) => ({ id, media: "m", start: 0, duration: 1 })) }] }], media: [{ id: "m", name: "Beach.mp4" }] }) as unknown as Project;
  const out = (changed: boolean): EditOutcome => ({ revision: 0, changed, can_undo: done.length > 0, can_redo: undone.length > 0 });
  return {
    done,
    ed: {
      open: async () => undefined,
      project: async () => project(),
      apply: async (ops: Op | Op[]) => { done.push((([ops].flat()[0]) as unknown as { clip: string }).clip); undone.length = 0; return out(true); },
      undo: async () => { const x = done.pop(); if (x === undefined) return out(false); undone.push(x); return out(true); },
      redo: async () => { const x = undone.pop(); if (x === undefined) return out(false); done.push(x); return out(true); },
    } as unknown as Editing,
  };
}

test("jumpTo walks undo and redo to a step; later steps stay available until a new edit", async () => {
  const { ed, done } = stack();
  const s = new ProjectStore();
  await s.attach(ed);
  for (const c of ["a", "b", "c"]) await s.apply({ op: "split", clip: c, at: 1, new_id: "n" });
  assert.deepEqual(s.getState().history.past.map((x) => x.label.key), ["history.split", "history.split", "history.split"]);
  await s.jumpTo(1);
  assert.deepEqual(done, ["a"]);
  assert.equal(s.getState().history.future.length, 2);
  await s.jumpTo(3);
  assert.deepEqual(done, ["a", "b", "c"]);
  await s.jumpTo(0);
  assert.equal(s.getState().canUndo, false);
  await s.apply({ op: "split", clip: "z", at: 1, new_id: "n" });
  assert.equal(s.getState().history.future.length, 0);
});

test("a recovered session says there are earlier edits the list cannot name", async () => {
  const { ed } = stack();
  const s = new ProjectStore();
  await s.attach(ed, { canUndo: true });
  assert.equal(s.getState().history.earlier, true);
  assert.equal(s.getState().history.past.length, 0);
});

// ---- new project canvas ----
test("canvas presets: sizes, the nearest picker entry, and a chosen canvas is not replaced by the first clip", () => {
  assert.deepEqual(CANVAS_PRESETS.map((p) => `${p.width}x${p.height}`), ["1920x1080", "1080x1920", "1080x1080", "1080x1350", "3840x2160"]);
  assert.equal(nearestRatio(presetSize("4k")), "16:9");
  assert.equal(nearestRatio({ width: 1080, height: 1350 }), "4:5");
  assert.equal(nearestRatio({ width: 720, height: 1280 }), "9:16");

  const p = fixtureProject({ tracks: 0, clipsPerTrack: 0 });
  p.media = [];
  const probed = { kind: "video", hasVideo: true, hasAudio: false, width: 1280, height: 720, fps: { num: 24, den: 1 }, durationTicks: 1, rotation: 0 } as unknown as Probed;
  const ref = { id: "m", kind: "video", name: "a.mp4", uri: "u", hash: null, duration: 1 } as P["media"][number];
  assert.equal(importOps(p, ref, probed).length, 2, "match first clip: the format is adopted");
  assert.equal(importOps(p, ref, probed, { size: true, rate: true }).length, 1, "both chosen: untouched");
  const half = importOps(p, ref, probed, { size: true, rate: false })[1] as Extract<Op, { op: "set_sequence_format" }>;
  assert.deepEqual(half.resolution, p.sequences[0]!.resolution, "size kept");
  assert.deepEqual(half.frame_rate, { num: 24, den: 1 }, "rate adopted");
});

test("VersionMeta shape is plain data", () => {
  const m: VersionMeta = { id: "x", name: null, auto: true, at: 1, size: 2 };
  assert.deepEqual(JSON.parse(JSON.stringify(m)), m);
});
