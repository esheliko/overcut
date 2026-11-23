import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error plain .mjs script, no types
import { compare } from "../perf/compare.mjs";
// @ts-expect-error plain .mjs script, no types
import { metricsOf } from "../perf/device.mjs";
// @ts-expect-error plain .mjs script, no types
import { judge, byKey } from "../perf/metrics.mjs";

type Row = { key: string; status: string; pct: number | null };
const run = (metrics: Record<string, number>) => ({ metrics });
const status = (rows: Row[], key: string) => rows.find((r) => r.key === key)?.status;

test("compare: worse follows the metric direction; warn at +10%, fail at +25%", () => {
  const base = run({ "scrub.p50_ms": 10, "preview.fps": 60, "size.shell_js_gzip_kb": 100 });
  const rows: Row[] = compare(run({ "scrub.p50_ms": 12.6, "preview.fps": 52, "size.shell_js_gzip_kb": 105 }), base);
  assert.equal(status(rows, "scrub.p50_ms"), "FAIL"); // +26% time
  assert.equal(status(rows, "preview.fps"), "warn"); // -13% fps is worse
  assert.equal(status(rows, "size.shell_js_gzip_kb"), "ok"); // +5%
  assert.equal(status(compare(run({ "scrub.p50_ms": 8 }), base), "scrub.p50_ms"), "ok"); // faster is never a regression
});

test("compare: tiny absolute changes are noise; new and missing metrics are reported, not failed", () => {
  const rows: Row[] = compare(run({ "ops.apply_ms": 0.006, "scrub.p50_ms": 5 }), run({ "ops.apply_ms": 0.004, "preview.fps": 30 }));
  assert.equal(status(rows, "ops.apply_ms"), "ok"); // +50% of 0.004 ms is a timer tick
  assert.equal(status(rows, "scrub.p50_ms"), "new");
  assert.equal(status(rows, "preview.fps"), "missing");
});

test("device report maps to catalog metrics and is judged per tier", () => {
  const m = metricsOf({ tests: { decode: { fps: 45 }, seek: { gop30_p50_ms: 60, gop150_p95_ms: 200 }, fillRate: { layers_at_60fps: 4 }, gpuUpload: { copy_p50_ms: 3 } } });
  assert.deepEqual(m, { "device.decode_fps": 45, "device.seek_gop30_p50_ms": 60, "device.seek_gop150_p95_ms": 200, "device.fill_layers_at_60fps": 4, "device.upload_p50_ms": 3 });
  assert.equal(judge(byKey["device.decode_fps"], 45, "laptop"), "fail"); // laptop needs 60
  assert.equal(judge(byKey["device.decode_fps"], 45, "low"), "pass");
  assert.equal(judge(byKey["device.seek_gop150_p95_ms"], 200, "mid"), "none"); // no budget
});
