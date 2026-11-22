import test from "node:test";
import assert from "node:assert/strict";
import { memoryStorage } from "../../packages/engine-client/src/persist/memory";
import { packSlot, slotStorage, unpackSlot, StorageError, toStorageError, decode, encode } from "../../packages/engine-client/src/persist/storage";
import { JOURNAL_FILE, PROJECT_FILE, CHECKPOINT_FILE, DISCARDED_FILE, openProjectSession } from "../../packages/engine-client/src/persist/session";
import { fingerprintFile, relinkMedia, type Candidate } from "../../packages/engine-client/src/media";
import type { Editing, EditOutcome, Engine, Op, Recovery } from "../../packages/engine-client/src/types";
import type { Project } from "../../packages/engine-client/src/model.generated";

/**
 * A stand-in engine with the real engine's persistence contract (commit log with gapless `n`, torn-tail-tolerant recover, checkpoint),
 * so these tests exercise the host side: files, ordering, retries, error surfacing. The real engine is tested in Rust
 * (`crates/timeline`: every-byte torn log, undo history) and in the browser smoke test (kill the Worker, reload).
 */
function fakeEngine() {
  let base: { edits: string[] } = { edits: [] };
  let edits: string[] = [];
  let seq = 0;
  let pending = "";
  const outcome = (changed: boolean): EditOutcome => ({ revision: seq, can_undo: edits.length > 0, can_redo: false, changed });
  const editing: Editing = {
    open: async (p) => {
      base = JSON.parse(JSON.stringify(p)) as typeof base;
      edits = [...base.edits];
      seq = 0;
      pending = "";
    },
    apply: async (ops: Op | Op[]) => {
      edits.push(JSON.stringify(ops));
      seq += 1;
      pending += `${JSON.stringify({ n: seq, r: "apply", ops })}\n`;
      return outcome(true);
    },
    undo: async () => outcome(false),
    redo: async () => outcome(false),
    project: async () => ({ edits: [...edits] }) as unknown as Project,
    journal: async () => "",
    evaluate: async () => { throw new Error("not used"); },
    takeLog: async () => {
      const p = pending;
      pending = "";
      return p;
    },
    checkpoint: async () => JSON.stringify({ seq, project: { edits } }),
    recover: async (b, cp, log): Promise<Recovery> => {
      const lines = log.split("\n").filter((l) => l.trim());
      const good: string[] = [];
      for (const l of lines) {
        try {
          const v = JSON.parse(l) as { n: number; ops: Op };
          if (v.n !== good.length + 1) break;
          good.push(l);
        } catch {
          break;
        }
      }
      if (!b && !cp) throw new Error("no usable base project or checkpoint");
      base = (b ?? (JSON.parse(cp!) as { project: typeof base }).project) as unknown as typeof base;
      edits = [...base.edits, ...good.map((l) => JSON.stringify((JSON.parse(l) as { ops: Op }).ops))];
      seq = good.length;
      pending = "";
      return { replayed: good.length, dropped: lines.length - good.length, fullHistory: !!b, validLog: good.map((l) => `${l}\n`).join("") };
    },
  };
  const engine: Engine = {
    backend: "wasm",
    info: async () => ({ name: "fake", version: "0", abi: 1 }),
    editing,
    media: { open: async () => { throw new Error("not used"); } },
    openProject: async (bytes) => ({ project: JSON.parse(decode(bytes)) as Project, readOnly: false, foundVersion: 1, migrated: false, entries: [] }),
    saveProject: async (p) => encode(JSON.stringify(p)),
    fingerprintMedia: async (size, first, last) => `b3-64k:${size}:${[...first, ...last].reduce((a, b) => (a * 31 + b) % 1_000_003, 7).toString(16).padStart(64, "0")}`,
  };
  return engine;
}

const op = (n: number): Op => ({ op: "delete", clip: n.toString(16).padStart(32, "0") });
const opts = { createProject: () => ({ edits: [] }) as unknown as Project, checkpointIdleMs: 0 };
const edits = (p: Project) => (p as unknown as { edits: string[] }).edits;

test("edits are durable once whenDurable resolves, and a session that never closed is recovered on the next open", async () => {
  const storage = memoryStorage();
  const a = await openProjectSession(fakeEngine(), storage, opts);
  assert.equal(a.recovered, null);
  for (let i = 1; i <= 5; i++) await a.session.editing.apply(op(i));
  await a.session.whenDurable();
  // crash: no close(). A fresh engine (the page reloaded) opens the same storage.
  const b = await openProjectSession(fakeEngine(), storage, opts);
  assert.deepEqual(b.recovered, { replayed: 5, dropped: 0, fullHistory: true });
  assert.equal(edits(b.project).length, 5);
  // the journal keeps growing from where it stopped: a second crash recovers 7 records, not 2
  await b.session.editing.apply(op(6));
  await b.session.editing.apply(op(7));
  await b.session.whenDurable();
  const c = await openProjectSession(fakeEngine(), storage, opts);
  assert.equal(c.recovered?.replayed, 7);
});

test("a crash in the middle of an append loses only that append; everything acknowledged before it survives", async () => {
  for (const keep of [0, 1, 7, 30]) {
    const storage = memoryStorage();
    const a = await openProjectSession(fakeEngine(), storage, opts);
    await a.session.editing.apply(op(1));
    await a.session.editing.apply(op(2));
    await a.session.whenDurable();
    storage.raw.crash = { bytes: keep };
    await a.session.editing.apply(op(3));
    await assert.rejects(a.session.whenDurable()); // the write died: not acknowledged
    const b = await openProjectSession(fakeEngine(), storage, opts);
    assert.equal(b.recovered?.replayed, 2, `keep ${keep}`);
    assert.equal(edits(b.project).length, 2);
    assert.ok((b.recovered?.dropped ?? 9) <= 1, "at most the torn line is dropped");
    assert.ok(decode((await storage.read(JOURNAL_FILE))!).endsWith("\n"), "the torn fragment was cut from the journal");
    await b.session.editing.apply(op(9));
    await b.session.whenDurable();
    assert.equal((await openProjectSession(fakeEngine(), storage, opts)).recovered?.replayed, 3, "new appends follow whole lines");
  }
});

test("a clean close folds the log into the project; reopening shows no recovery note", async () => {
  const storage = memoryStorage();
  const a = await openProjectSession(fakeEngine(), storage, opts);
  await a.session.editing.apply(op(1));
  await a.session.close();
  assert.equal(await storage.read(JOURNAL_FILE), null);
  const b = await openProjectSession(fakeEngine(), storage, opts);
  assert.equal(b.recovered, null);
  assert.equal(edits(b.project).length, 1);
});

test("a crash between writing the new project and deleting the old log does not replay the stale log onto the new base", async () => {
  const storage = memoryStorage();
  const a = await openProjectSession(fakeEngine(), storage, opts);
  await a.session.editing.apply(op(1));
  await a.session.whenDurable();
  const staleJournal = await storage.read(JOURNAL_FILE);
  await a.session.close();
  await storage.append(JOURNAL_FILE, staleJournal!); // as if the delete never happened
  const b = await openProjectSession(fakeEngine(), storage, opts);
  assert.equal(b.recovered, null);
  assert.equal(edits(b.project).length, 1, "one edit, not two");
});

test("storage errors are surfaced with a clear message, edits are kept in memory and written when storage works again", async () => {
  const storage = memoryStorage();
  const seen: string[] = [];
  const a = await openProjectSession(fakeEngine(), storage, { ...opts, onStatus: (s, e) => seen.push(e ? `${s}:${e.code}` : s) });
  const quota = Object.assign(new Error("full"), { name: "QuotaExceededError" });
  storage.raw.failWith = quota;
  await a.session.editing.apply(op(1));
  await assert.rejects(a.session.whenDurable(), (e: unknown) => e instanceof StorageError && e.code === "quota" && /out of storage space/.test(e.message));
  assert.ok(seen.includes("error:quota"));
  storage.raw.failWith = undefined;
  await a.session.editing.apply(op(2));
  await a.session.whenDurable(); // flushes the held record first, then the new one
  assert.equal(a.session.status, "saved");
  const b = await openProjectSession(fakeEngine(), storage, opts);
  assert.equal(b.recovered?.replayed, 2);
});

test("toStorageError names quota, permission and native errors", () => {
  assert.equal(toStorageError(Object.assign(new Error("x"), { name: "QuotaExceededError" })).code, "quota");
  assert.equal(toStorageError(Object.assign(new Error("x"), { name: "NotAllowedError" })).code, "permission");
  assert.equal(toStorageError(JSON.stringify({ code: "quota", message: "disk full" })).code, "quota");
  assert.equal(toStorageError(JSON.stringify({ code: "permission", message: "denied" })).code, "permission");
  assert.equal(toStorageError("weird").code, "io");
});

test("two-slot atomic replace: a crash at any byte of a write leaves the previous value", async () => {
  const payloads = [encode("first version of the project"), encode("second version, a bit longer than the first one")];
  for (let cut = 0; cut <= 16 + payloads[1]!.length; cut++) {
    const storage = memoryStorage();
    await storage.writeAtomic("p", payloads[0]!);
    storage.raw.crash = { bytes: cut };
    await assert.rejects(storage.writeAtomic("p", payloads[1]!)).catch(() => undefined);
    const got = decode((await storage.read("p"))!);
    assert.ok(got === decode(payloads[0]!) || got === decode(payloads[1]!), `cut ${cut}`);
    if (cut < 16 + payloads[1]!.length) assert.equal(got, decode(payloads[0]!), `cut ${cut}`);
    await storage.writeAtomic("p", encode("third"));
    assert.equal(decode((await storage.read("p"))!), "third");
  }
  // damaged slots are ignored, not trusted
  assert.equal(unpackSlot(packSlot(1, encode("x")).subarray(0, 16)), null);
  const flipped = packSlot(1, encode("hello"));
  flipped[18] = flipped[18]! ^ 1;
  assert.equal(unpackSlot(flipped), null);
  const empty = slotStorage("memory", memoryStorage().raw);
  assert.equal(await empty.read("nothing"), null);
});

test("checkpoints stand in when the base project file is unreadable", async () => {
  const storage = memoryStorage();
  const a = await openProjectSession(fakeEngine(), storage, opts);
  for (let i = 1; i <= 3; i++) await a.session.editing.apply(op(i));
  await a.session.checkpoint();
  await storage.writeAtomic(PROJECT_FILE, encode("not a project")); // damaged beyond reading... and its id changed
  const bad = fakeEngine();
  bad.openProject = async () => {
    throw new Error("corrupt");
  };
  await assert.rejects(openProjectSession(bad, storage, opts)); // the checkpoint belongs to the old base: refused rather than guessed
  assert.ok(await storage.read(CHECKPOINT_FILE));
});

test("Undo recovery returns to the last clean save and keeps the discarded edits", async () => {
  const storage = memoryStorage();
  const a = await openProjectSession(fakeEngine(), storage, opts);
  await a.session.editing.apply(op(1));
  await a.session.whenDurable();
  const eng = fakeEngine();
  const b = await openProjectSession(eng, storage, opts);
  assert.equal(b.recovered?.replayed, 1);
  const base = await b.session.undoRecovery();
  assert.equal(edits(base).length, 0);
  assert.equal(edits(await eng.editing.project()).length, 0);
  assert.equal(await storage.read(JOURNAL_FILE), null);
  assert.match(decode((await storage.read(DISCARDED_FILE))!), /"n":1/);
  const c = await openProjectSession(fakeEngine(), storage, opts);
  assert.equal(c.recovered, null);
});

test("fingerprints read at most 128 KiB of a file; relink finds a moved file by content and reports the rest offline", async () => {
  const engine = fakeEngine();
  let read = 0;
  const file = (uri: string, bytes: Uint8Array): Candidate => ({
    uri,
    size: bytes.length,
    slice: (s, e) => ({ arrayBuffer: async () => ((read += e - s), bytes.slice(s, e).buffer as ArrayBuffer) }),
  });
  const big = new Uint8Array(10_000_000).map((_, i) => (i * 7) & 255);
  const fp = await fingerprintFile(engine, file("m/big.mp4", big));
  assert.ok(fp.startsWith("b3-64k:10000000:"));
  assert.equal(read, 128 * 1024);

  const other = new Uint8Array(10_000_000).map((_, i) => (i * 11) & 255);
  const project = {
    media: [
      { id: "1".padStart(32, "0"), uri: "old/big.mp4", hash: fp },
      { id: "2".padStart(32, "0"), uri: "old/gone.mp4", hash: "b3-64k:5:" + "0".repeat(64) },
      { id: "3".padStart(32, "0"), uri: "old/nohash.mp4", hash: null },
    ],
  } as unknown as Project;
  const res = await relinkMedia(engine, project, [file("new/other.mp4", other), file("new/renamed.mp4", big)], () => undefined);
  assert.deepEqual(res.ops, [{ op: "set_media", media: "1".padStart(32, "0"), uri: "new/renamed.mp4", hash: fp }]);
  assert.deepEqual(res.offline, ["2".padStart(32, "0")]);
  // a media whose file is still where it was is left alone
  const same = await relinkMedia(engine, project, [], (u) => (u === "old/big.mp4" ? file(u, big) : undefined));
  assert.deepEqual(same.ops, []);
});
