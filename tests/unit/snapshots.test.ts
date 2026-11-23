import test from "node:test";
import assert from "node:assert/strict";
import { memoryStorage } from "../../packages/engine-client/src/persist/memory";
import { MAX_AUTO, SnapshotStore, retain, snapshotFile, type SnapshotInfo } from "../../packages/engine-client/src/persist/snapshots";

const info = (n: number, kind: SnapshotInfo["kind"]): SnapshotInfo => ({ id: String(n), at: n, kind, label: "", bytes: 1, sig: String(n) });
const bytes = (s: string) => new TextEncoder().encode(s);

test("retention keeps every manual snapshot and the newest MAX_AUTO of the rest", () => {
  const items = [...Array.from({ length: 30 }, (_, i) => info(i + 1, i % 2 ? "auto" : "before-open")), info(2000, "manual"), info(1, "manual")];
  const { keep, drop } = retain(items);
  assert.equal(keep.filter((s) => s.kind === "manual").length, 2, "manual snapshots are never pruned, however old");
  const autos = keep.filter((s) => s.kind !== "manual");
  assert.equal(autos.length, MAX_AUTO);
  assert.deepEqual(autos.map((s) => s.at), Array.from({ length: MAX_AUTO }, (_, i) => 30 - i), "newest automatic ones stay");
  assert.equal(drop.length, 10);
  assert.ok(drop.every((s) => s.kind !== "manual" && s.at <= 10));
  assert.deepEqual(retain([]).keep, []);
});

test("snapshots are stored beside the project, listed newest first, restored byte for byte and deleted", async () => {
  let now = 1_000;
  const store = new SnapshotStore(memoryStorage(), () => now);
  const a = await store.add("manual", "  Before the intro  ", bytes("one"));
  now += 5;
  const b = await store.add("auto", "", bytes("two"));
  assert.equal(a?.label, "Before the intro");
  assert.deepEqual((await store.list()).map((s) => s.id), [b!.id, a!.id]);
  assert.deepEqual(await store.read(a!.id), bytes("one"));
  await store.remove(a!.id);
  assert.deepEqual((await store.list()).map((s) => s.id), [b!.id]);
  assert.equal(await store.read(a!.id), null, "the payload is gone with its entry");
});

test("an automatic snapshot of an unchanged project is skipped; a manual one never is; the clock may stand still", async () => {
  const store = new SnapshotStore(memoryStorage(), () => 50);
  assert.ok(await store.add("auto", "", bytes("same")));
  assert.equal(await store.add("auto", "", bytes("same")), null);
  assert.equal(await store.add("before-open", "", bytes("same")), null);
  const m = await store.add("manual", "keep", bytes("same"));
  const m2 = await store.add("manual", "again", bytes("same"));
  assert.notEqual(m!.id, m2!.id, "same millisecond, still distinct ids");
});

test("pruning removes the payload files of dropped automatic snapshots only", async () => {
  const mem = memoryStorage();
  let now = 0;
  const store = new SnapshotStore(mem, () => ++now);
  const manual = await store.add("manual", "m", bytes("m"));
  for (let i = 0; i < MAX_AUTO + 5; i++) await store.add("auto", "", bytes(`auto ${i}`));
  const list = await store.list();
  assert.equal(list.length, MAX_AUTO + 1);
  assert.ok(list.some((s) => s.id === manual!.id));
  for (const k of list) assert.ok(await mem.read(snapshotFile(k.id)), "every listed snapshot has its payload");
  const gone = [...Array(MAX_AUTO + 6).keys()].map((i) => (i + 2).toString(36)); // ids of the dropped, oldest autos (clock 2..6)
  for (const id of gone.slice(0, 5)) assert.equal(await mem.read(snapshotFile(id)), null, "pruned payloads are removed");
});

test("a damaged index lists nothing instead of failing", async () => {
  const mem = memoryStorage();
  await mem.writeAtomic("snapshots.json", bytes("{not json"));
  assert.deepEqual(await new SnapshotStore(mem).list(), []);
});
