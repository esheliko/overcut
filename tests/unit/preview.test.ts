import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFrameTable, frameIndexAt, isVariable, startPacket } from "../../packages/engine-client/src/decode/frames";
import { limit, mixSegment, mixStretched, sampleAtTicks, sourceSamplesFor } from "../../apps/web/src/preview/audioMix";
import { canvasBackingSize, displaySize, normalizeRotation } from "../../apps/web/src/preview/layout";
import { frameAtTicks, frameStartTicks, nominalFps, positionAt, prefetchFrames, rateLabel, shuttle, TICKS_PER_SECOND, timecodeHMS } from "../../apps/web/src/preview/timing";

const r30 = { num: 30, den: 1 };
const pk = (ts: number, key = false) => ({ offset: 0, size: 1, key, ts, dur: 1 });

test("frame <-> ticks is exact on standard rates and quantises like evaluate", () => {
  assert.equal(frameStartTicks(1, r30), 23_520_000);
  assert.equal(frameStartTicks(30, { num: 30000, den: 1001 }), 705_600_000 * 1001 / 1000);
  for (const n of [0, 1, 29, 30, 12345]) assert.equal(frameAtTicks(frameStartTicks(n, r30), r30), n);
  assert.equal(frameAtTicks(frameStartTicks(7, r30) + 23_519_999, r30), 7);
  assert.equal(frameAtTicks(-5, r30), 0);
});

test("timecode is HH:MM:SS:FF", () => {
  assert.equal(timecodeHMS(0, r30), "00:00:00:00");
  assert.equal(timecodeHMS(30 * 3661 + 7, r30), "01:01:01:07");
  assert.equal(timecodeHMS(25, { num: 25, den: 1 }), "00:00:01:00");
  assert.equal(nominalFps({ num: 30000, den: 1001 }), 30);
});

test("the audio clock decides the position, forward and reverse, and clamps", () => {
  const a = { ticks: 1_000_000, at: 10, rate: 1 };
  assert.equal(positionAt(a, 10, 1e12), 1_000_000);
  assert.equal(positionAt(a, 11, 1e12), 1_000_000 + TICKS_PER_SECOND);
  assert.equal(positionAt({ ...a, rate: 2 }, 11, 1e12), 1_000_000 + 2 * TICKS_PER_SECOND);
  assert.equal(positionAt({ ticks: 3 * TICKS_PER_SECOND, at: 0, rate: -1 }, 1, 1e12), 2 * TICKS_PER_SECOND);
  assert.equal(positionAt({ ...a, rate: -1 }, 100, 1e12), 0);
  assert.equal(positionAt(a, 100, 5 * TICKS_PER_SECOND), 5 * TICKS_PER_SECOND);
  // No accumulated error: a long run lands on the same tick as the closed form.
  assert.equal(positionAt({ ticks: 0, at: 0, rate: 1 }, 3600, 1e15), 3600 * TICKS_PER_SECOND);
});

test("JKL: repeated L is 2x then 4x, J mirrors, K stops, opposite key restarts at 1x", () => {
  assert.equal(shuttle(0, "L"), 1);
  assert.equal(shuttle(1, "L"), 2);
  assert.equal(shuttle(2, "L"), 4);
  assert.equal(shuttle(4, "L"), 4);
  assert.equal(shuttle(0, "J"), -1);
  assert.equal(shuttle(-1, "J"), -2);
  assert.equal(shuttle(-2, "J"), -4);
  assert.equal(shuttle(4, "J"), -1);
  assert.equal(shuttle(-2, "L"), 1);
  assert.equal(shuttle(4, "K"), 0);
  assert.equal(rateLabel(2), "2×");
  assert.equal(rateLabel(1), "");
});

test("prefetch depth follows the byte budget", () => {
  assert.equal(prefetchFrames(192 * 2 ** 20, 1920, 1080), 12);
  assert.equal(prefetchFrames(32 * 2 ** 20, 1920, 1080), 4);
  assert.equal(prefetchFrames(1, 3840, 2160), 2);
});

test("rotation: display size swaps for 90/270", () => {
  assert.deepEqual(displaySize(1920, 1080, 90), { width: 1080, height: 1920 });
  assert.deepEqual(displaySize(1920, 1080, 180), { width: 1920, height: 1080 });
  assert.equal(normalizeRotation(-90), 270);
  assert.equal(normalizeRotation(450), 90);
  // The texture mapping itself lives in the Rust compositor (`app_render::texture_matrix`, tested in crates/render/tests/golden.rs).
});

test("canvas size", () => {
  const s = canvasBackingSize(640, 360, 2, { width: 1920, height: 1080 });
  assert.deepEqual(s, { width: 1280, height: 720 });
  assert.deepEqual(canvasBackingSize(2000, 1000, 2, { width: 1920, height: 1080 }), { width: 1920, height: 960 });
  assert.deepEqual(canvasBackingSize(100, 100, 1, { width: 50, height: 50 }), { width: 50, height: 50 });
});

test("VFR: frames are chosen by timestamp, not by index arithmetic", () => {
  // decode order with B-frames: pts (us) 0, 33333, 100000(!), ... frames held for their real duration
  const t = buildFrameTable([pk(0, true), pk(100_000), pk(33_333), pk(300_000), pk(200_000)]);
  assert.deepEqual([...t.pts], [0, 33_333, 100_000, 200_000, 300_000]);
  assert.ok(isVariable(t));
  const at = (sec: number) => frameIndexAt(t, Math.round(sec * TICKS_PER_SECOND));
  assert.equal(at(0), 0);
  assert.equal(at(0.05), 1); // between 33 and 100 ms: still frame 1
  assert.equal(at(0.1), 2);
  assert.equal(at(0.25), 3);
  assert.equal(at(5), 4); // past the end: last frame
  assert.equal(at(-1), 0);
  const cfr = buildFrameTable(Array.from({ length: 10 }, (_, i) => pk(i * 33_333, i % 5 === 0)));
  assert.ok(!isVariable(cfr));
  assert.equal(startPacket(cfr, 7), 5);
  assert.equal(startPacket(cfr, 4), 0);
});

test("audio mixing: gain, offsets, mono to stereo, speed, trimming and limiting", () => {
  const l = new Float32Array(8), r = new Float32Array(8);
  mixSegment(l, r, { out_start: 2, len: 4, speed: { num: 1, den: 1 }, gain: 0.5, fade_in: 0, fade_out: 0, clip_len: 0, clip_offset: 0 }, Float32Array.from([1, 1, 1, 1]), 1);
  assert.deepEqual([...l], [0, 0, 0.5, 0.5, 0.5, 0.5, 0, 0]);
  assert.deepEqual([...r], [...l]);
  const l2 = new Float32Array(4), r2 = new Float32Array(4);
  mixSegment(l2, r2, { out_start: 0, len: 4, speed: { num: 1, den: 1 }, gain: 1, fade_in: 0, fade_out: 0, clip_len: 0, clip_offset: 0 }, Float32Array.from([1, -1, 2, -2, 3, -3, 4, -4]), 2, 2);
  assert.deepEqual([...l2], [0, 0, 3, 4]);
  assert.deepEqual([...r2], [0, 0, -3, -4]);
  const l3 = new Float32Array(2), r3 = new Float32Array(2);
  mixSegment(l3, r3, { out_start: 0, len: 2, speed: { num: 2, den: 1 }, gain: 1, fade_in: 0, fade_out: 0, clip_len: 0, clip_offset: 0 }, Float32Array.from([0, 1, 2, 3]), 1);
  assert.deepEqual([...l3], [0, 2]);
  assert.equal(sourceSamplesFor({ len: 100, speed: { num: 3, den: 2 } }), 150);
  assert.equal(sampleAtTicks(TICKS_PER_SECOND, 48_000), 48_000);
  const b = Float32Array.from([0.5, 3, -3]);
  limit(b);
  assert.equal(b[0], 0.5);
  assert.ok(b[1]! < 1 && b[1]! > 0.9 && b[2]! > -1);
});

test("mixStretched adds the pre-stretched clip from clip_offset, scaled by gain, with skip and mono", () => {
  const l = new Float32Array(6);
  const r = new Float32Array(6);
  mixStretched(l, r, { out_start: 1, len: 4, gain: 0.5, fade_in: 0, fade_out: 0, clip_len: 0, clip_offset: 2 }, [Float32Array.from([0, 0, 2, 4, 6, 8]), Float32Array.from([0, 0, -2, -4, -6, -8])]);
  assert.deepEqual(Array.from(l), [0, 1, 2, 3, 4, 0]);
  assert.deepEqual(Array.from(r), [0, -1, -2, -3, -4, 0]);
  const m = new Float32Array(6);
  const m2 = new Float32Array(6);
  mixStretched(m, m2, { out_start: 0, len: 2, gain: 1, fade_in: 0, fade_out: 0, clip_len: 0, clip_offset: 0 }, [Float32Array.from([1, 2])]);
  assert.deepEqual([Array.from(m), Array.from(m2)], [[1, 2, 0, 0, 0, 0], [1, 2, 0, 0, 0, 0]]);
});
