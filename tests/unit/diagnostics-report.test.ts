import test from "node:test";
import assert from "node:assert/strict";
import { percentile, rng, summarize } from "../../apps/web/src/diagnostics/stats";
import { buildReport, sentence, verdict } from "../../apps/web/src/diagnostics/report";
import type { TestResult } from "../../apps/web/src/diagnostics/types";

const ok = (id: TestResult["id"], metrics: TestResult["metrics"]): TestResult => ({ id, status: "ok", metrics, took_ms: 10 });

test("percentiles and the seeded generator are deterministic", () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.deepEqual(summarize([10, 20, 30, 40]), { n: 4, p50: 30, p95: 40, max: 40 });
  assert.deepEqual([rng(1)(), rng(1)()], [rng(1)(), rng(1)()]);
});

test("verdicts follow the rough thresholds, and failed tests have none", () => {
  assert.equal(verdict(ok("decode", { fps: 120 })), "good");
  assert.equal(verdict(ok("decode", { fps: 20 })), "slow");
  assert.equal(verdict(ok("seek", { gop150_p95_ms: 300 })), "ok");
  assert.equal(verdict({ id: "fillRate", status: "unsupported", metrics: {}, took_ms: 0 }), "na");
});

test("a failed or unsupported test is explained, never blank", () => {
  assert.match(sentence({ id: "gpuUpload", status: "unsupported", reason: "No WebGPU.", metrics: {}, took_ms: 0 }), /Not supported.*No WebGPU/);
  assert.match(sentence({ id: "seek", status: "timeout", metrics: {}, took_ms: 0 }), /too long/);
});

test("the copied report is one compact JSON line that survives with no capabilities and carries every test", () => {
  const text = buildReport(null, [ok("decode", { fps: 100 }), { id: "seek", status: "error", reason: "boom", metrics: {}, took_ms: 5 }], { version: "0.1.0", backend: "wasm" }, new Date("2026-01-02T03:04:05Z"));
  assert.ok(!text.includes("\n"));
  const r = JSON.parse(text);
  assert.equal(r.at, "2026-01-02T03:04:05.000Z");
  assert.equal(r.tests.decode.fps, 100);
  assert.equal(r.tests.seek.status, "error");
  assert.equal(r.tests.seek.why, "boom");
});
