import test from "node:test";
import assert from "node:assert/strict";
import { createNetworkLog, hostOf, summarize } from "../../apps/web/src/privacy/networkLog";

test("network log: records in order, notifies, and keeps a stable list until something changes", () => {
  const log = createNetworkLog();
  let n = 0;
  const off = log.subscribe(() => n++);
  const a = log.list();
  assert.equal(log.list(), a);
  log.record({ url: "https://app.test/a.js", bytes: 10, at: 1, initiator: "app-asset" });
  log.record({ url: "https://app.test/b.wasm", at: 2, initiator: "worker" });
  assert.equal(n, 2);
  assert.notEqual(log.list(), a);
  assert.deepEqual(log.list().map((e) => [e.url, e.bytes]), [["https://app.test/a.js", 10], ["https://app.test/b.wasm", null]]);
  off();
  log.record({ url: "https://app.test/c", at: 3, initiator: "app-asset" });
  assert.equal(n, 2);
});

test("network log: a replayed observer entry is not listed twice, a user download always is, and the list is capped", () => {
  const log = createNetworkLog(3);
  const e = { url: "https://app.test/a.js", at: 5, initiator: "app-asset" } as const;
  log.record(e); log.record(e);
  assert.equal(log.list().length, 1);
  const d = { url: "https://ciscobinary.openh264.org/x.zip", at: 6, bytes: 1_000_000, initiator: "user-download" } as const;
  log.record(d); log.record(d);
  assert.equal(log.list().length, 3);
  log.record({ url: "https://app.test/z", at: 9, initiator: "app-asset" });
  assert.equal(log.list().length, 3);
  assert.equal(log.list()[0]!.at, 6);
});

test("summary: own host only is quiet; another host, and downloads, are named", () => {
  const log = createNetworkLog();
  log.record({ url: "https://app.test/a.js", bytes: 100, at: 1, initiator: "app-asset" });
  log.record({ url: "blob:https://app.test/1", bytes: 50, at: 2, initiator: "app-asset" });
  assert.deepEqual(summarize(log.list(), "app.test"), { total: 2, bytes: 150, outside: [], downloads: 0 });
  log.record({ url: "https://ciscobinary.openh264.org/x.zip", bytes: 900, at: 3, initiator: "user-download" });
  const s = summarize(log.list(), "app.test");
  assert.deepEqual(s.outside, ["ciscobinary.openh264.org"]);
  assert.equal(s.downloads, 1);
  assert.equal(hostOf("data:text/plain,hi"), null);
  assert.equal(hostOf("not a url"), null);
});
