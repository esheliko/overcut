import assert from "node:assert/strict";
import { test } from "node:test";
import { KEEP_BUDGET_BYTES, fitsBudget, keepLimit, keptKey, unusedKeys, type KeptEntry } from "../../apps/web/src/media/keep-plan";
import { MediaCache, MemoryStore } from "../../apps/web/src/media/cache";

const GB = 1024 ** 3;

test("the budget is 2 GB, or half the device's quota when that is smaller", () => {
  assert.equal(keepLimit(null), KEEP_BUDGET_BYTES);
  assert.equal(keepLimit(100 * GB), 2 * GB);
  assert.equal(keepLimit(1 * GB), 0.5 * GB);
});

test("a file is kept only when it fits next to what is already kept", () => {
  assert.equal(fitsBudget(1 * GB, { used: 0, quota: null }), true);
  assert.equal(fitsBudget(1 * GB, { used: 1.5 * GB, quota: null }), false);
  assert.equal(fitsBudget(0, { used: 0, quota: null }), false);
  assert.equal(fitsBudget(300 * 1024 ** 2, { used: 0, quota: 1 * GB }), true);
  assert.equal(fitsBudget(600 * 1024 ** 2, { used: 0, quota: 1 * GB }), false);
});

test("kept: uris carry their key", () => {
  assert.equal(keptKey("kept:abc"), "abc");
  assert.equal(keptKey("fs:abc"), null);
});

test("unused copies: not in the open project, or owned by a deleted project; other live projects' copies stay", () => {
  const e = (key: string, owner: string): KeptEntry => ({ key, size: 1, meta: { name: key, size: 1, owner } });
  const entries = [e("a", "p1"), e("b", "p1"), e("c", "p2"), e("d", "gone")];
  assert.deepEqual(unusedKeys(entries, new Set(["a"]), new Set(["p1", "p2"]), "p1"), ["b", "d"]);
});

test("the poster cache evicts the least recently used picture first", async () => {
  const c = new MediaCache(new MemoryStore(), 25);
  await c.put("poster/a", new Uint8Array(10));
  await c.put("poster/b", new Uint8Array(10));
  await c.get("poster/a");
  await c.put("poster/c", new Uint8Array(10));
  assert.equal(await c.has("poster/b"), false);
  assert.equal(await c.has("poster/a"), true);
});
