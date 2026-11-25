import test from "node:test";
import assert from "node:assert/strict";
import type { Project } from "@app/engine-client";
import { clipSpan, formatSpeed, speedOf, speedOps, speedTarget, toRational } from "../../apps/web/src/inspector/speedModel";

test("toRational: two decimals, reduced, 0.25 to 4 only", () => {
  assert.deepEqual(toRational(2), { num: 2, den: 1 });
  assert.deepEqual(toRational(1.5), { num: 3, den: 2 });
  assert.deepEqual(toRational(0.25), { num: 1, den: 4 });
  assert.deepEqual(toRational(1.333), { num: 133, den: 100 });
  for (const bad of [0, 0.24, 4.01, -1, NaN, Infinity]) assert.equal(toRational(bad), null, String(bad));
});

test("speed labels and values", () => {
  assert.equal(formatSpeed(1.5), "1.5×");
  assert.equal(formatSpeed(2), "2×");
  assert.equal(formatSpeed(0.25), "0.25×");
  assert.equal(speedOf({ speed: { num: 3, den: 2 } }), 1.5);
  assert.equal(speedOf({}), 1);
});

const clip = (id: string, media: string, link?: string) => ({ id, media, start: 0, source_in: 0, duration: 1, speed: { num: 1, den: 1 }, link: link ?? null });
const project = {
  media: [{ id: "v", kind: "video" }, { id: "i", kind: "image" }],
  sequences: [{ tracks: [{ kind: "video", clips: [clip("a", "v", "L"), clip("s", "i")] }, { kind: "audio", clips: [clip("b", "v", "L")] }] }],
} as unknown as Project;

test("the target is one clip with its linked partners; a still is flagged; mixed selections are refused", () => {
  assert.deepEqual(speedTarget(project, new Set(["a"]))?.group.map((c) => c.id), ["a", "b"]);
  assert.deepEqual(speedTarget(project, new Set(["a", "b"]))?.group.map((c) => c.id), ["a", "b"]);
  assert.equal(speedTarget(project, new Set(["s"]))?.still, true);
  assert.equal(speedTarget(project, new Set(["a", "s"])), null);
  assert.equal(speedTarget(project, new Set()), null);
  assert.equal(speedTarget(project, new Set(["nope"])), null);
});

test("one set_clip_speed per clip of the group", () => {
  const t = speedTarget(project, new Set(["a"]))!;
  assert.deepEqual(speedOps(t.group, { num: 2, den: 1 }, true), [
    { op: "set_clip_speed", clip: "a", speed: { num: 2, den: 1 }, ripple: true },
    { op: "set_clip_speed", clip: "b", speed: { num: 2, den: 1 }, ripple: true },
  ]);
});

test("clipSpan reads the clip's current span (after a speed change the end moves)", () => {
  const T = 705_600_000;
  const p = { media: [{ id: "v", name: "B.mp4" }], sequences: [{ tracks: [{ name: "V1", clips: [{ id: "b", media: "v", start: 6 * T, duration: 3 * T }] }] }] } as unknown as Project;
  assert.deepEqual(clipSpan(p, "b"), { name: "B.mp4", track: "V1", from: "0:06.00", to: "0:09.00" });
  assert.equal(clipSpan(p, "gone"), null);
  assert.equal(clipSpan(null, "b"), null);
});
