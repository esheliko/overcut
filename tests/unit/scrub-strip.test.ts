import test from "node:test";
import assert from "node:assert/strict";
import { MediaCache, MemoryStore } from "../../apps/web/src/media/cache";
import { SCRUB_BUDGET_MS, deviceTier, estimateSeekP95, gopOf, needsStrip, nearestStored, planStrip } from "../../apps/web/src/preview/strip/policy";
import { baseKey, loadManifest, manifestKey, packSegment, saveManifest, segmentCount, segmentKey, segmentOf, unpackSegment } from "../../apps/web/src/preview/strip/store";
import { StripManager } from "../../apps/web/src/preview/strip/manager";

const gop = (frames: number, every: number) => gopOf(Array.from({ length: Math.ceil(frames / every) }, (_, i) => i * every), frames);

test("gop: longest and mean keyframe distance from the demuxer index", () => {
  assert.deepEqual(gopOf([0, 30, 60, 100], 130), { frames: 130, maxGop: 40, meanGop: 32.5 });
  assert.deepEqual(gopOf([], 90), { frames: 90, maxGop: 90, meanGop: 90 }); // no index: the whole clip is one GOP
  assert.deepEqual(gopOf([0], 0), { frames: 0, maxGop: 0, meanGop: 0 });
});

test("tier: phones and low-memory machines rank below desktops; unknown values never count as slow", () => {
  assert.equal(deviceTier({ cores: 12, memoryGb: 8 }), "high");
  assert.equal(deviceTier({ cores: 4, memoryGb: 8 }), "mid");
  assert.equal(deviceTier({ cores: 2, memoryGb: 8 }), "low");
  assert.equal(deviceTier({ cores: 8, memoryGb: 8, mobile: true }), "mid"); // Galaxy S24
  assert.equal(deviceTier({ cores: 8, memoryGb: 4, mobile: true }), "low"); // Galaxy A15
  assert.equal(deviceTier({}), "high");
});

test("rule: the estimate reproduces the owner's device numbers (GOP 150 1080p laptop ~202 ms, S24 ~376 ms)", () => {
  const g = gop(900, 150);
  assert.ok(Math.abs(estimateSeekP95(g, 1920, 1080, "high") - 202) < 15);
  assert.ok(Math.abs(estimateSeekP95(g, 1920, 1080, "mid") - 376) < 25);
});

test("rule: long GOP at 1080p needs a strip on every tier; GOP 30 only on a low phone", () => {
  for (const tier of ["high", "mid", "low"] as const) assert.equal(needsStrip(gop(900, 150), 1920, 1080, tier).build, true, tier);
  assert.equal(needsStrip(gop(900, 30), 1920, 1080, "high").build, false);
  assert.equal(needsStrip(gop(900, 30), 1920, 1080, "mid").build, false); // S24 measured p95 88 ms
  assert.equal(needsStrip(gop(900, 30), 1920, 1080, "low").build, true); // calibrated low-end proxy misses the budget
});

test("rule: tiny clips and small pictures never get one", () => {
  assert.deepEqual(needsStrip(gop(40, 40), 1920, 1080, "low").reason, "short");
  assert.deepEqual(needsStrip(gop(900, 150), 480, 270, "low").reason, "small");
});

test("rule: measured seeks outrank the estimate once there are enough of them", () => {
  const g = gop(900, 150);
  const slow = [200, 220, 240, 260, 280, 300, 320, 340];
  const fast = [30, 35, 40, 45, 50, 55, 60, 65];
  assert.equal(needsStrip(gop(900, 30), 1280, 720, "high", slow.slice(0, 7)).reason, "fast-enough"); // 7 samples: the estimate still decides
  assert.equal(needsStrip(g, 1920, 1080, "high", slow.slice(0, 7)).reason, "estimate");
  assert.equal(needsStrip(gop(900, 30), 1280, 720, "high", slow).reason, "measured"); // the estimate said fine, the device says slow
  assert.equal(needsStrip(gop(900, 30), 1280, 720, "high", slow).build, true);
  const quick = needsStrip(g, 1920, 1080, "low", fast); // the estimate said slow, the device is fast
  assert.equal(quick.build, false);
  assert.equal(quick.reason, "fast-enough");
  assert.ok(quick.measuredP95! <= 0.6 * SCRUB_BUDGET_MS);
});

test("plan: 480 px long edge, even sizes, about 15 stored frames per second, segments a whole number of strides", () => {
  const a = planStrip(1920, 1080, 30);
  assert.deepEqual([a.w, a.h, a.stride], [480, 270, 2]);
  assert.equal(a.segFrames % a.stride, 0);
  const portrait = planStrip(1080, 1920, 60);
  assert.deepEqual([portrait.w, portrait.h, portrait.stride], [270, 480, 4]);
  assert.deepEqual([planStrip(320, 180, 24).w, planStrip(320, 180, 24).h], [320, 180]); // never enlarged
  assert.equal(planStrip(1921, 1081, 30).w % 2, 0);
});

test("nearest stored frame: earlier on a tie, clamped to the clip", () => {
  assert.equal(nearestStored(10, 2, 100), 10);
  assert.equal(nearestStored(11, 2, 100), 10); // tie: earlier
  assert.equal(nearestStored(13, 4, 100), 12);
  assert.equal(nearestStored(15, 4, 100), 16);
  assert.equal(nearestStored(99, 4, 100), 96); // the one after (100) is past the end
  assert.equal(nearestStored(5, 1, 100), 5);
});

test("segment: pack and unpack round-trip; damaged data is rejected", () => {
  const jpegs = [Uint8Array.of(1, 2, 3), Uint8Array.of(4), new Uint8Array(0), Uint8Array.of(9, 9)];
  const seg = unpackSegment(packSegment(240, 2, jpegs))!;
  assert.deepEqual([seg.first, seg.stride, seg.count], [240, 2, 4]);
  assert.deepEqual([...seg.jpeg(0)!], [1, 2, 3]);
  assert.deepEqual([...seg.jpeg(1)!], [4]);
  assert.equal(seg.jpeg(2)!.length, 0);
  assert.deepEqual([...seg.jpeg(3)!], [9, 9]);
  assert.equal(seg.jpeg(4), undefined);
  const packed = packSegment(0, 2, jpegs);
  assert.equal(unpackSegment(packed.subarray(0, packed.length - 1)), null); // truncated
  assert.equal(unpackSegment(new Uint8Array(40)), null); // no magic
});

test("keys: a strip is keyed by source fingerprint and shape; a different shape or file is a different strip", () => {
  const a = planStrip(1920, 1080, 30);
  assert.notEqual(baseKey("h-aaa", a), baseKey("h-bbb", a));
  assert.notEqual(baseKey("h-aaa", a), baseKey("h-aaa", planStrip(1920, 1080, 60)));
  assert.equal(baseKey("h-aaa", a), baseKey("h-aaa", { ...a }));
  assert.equal(segmentKey(baseKey("h-aaa", a), 3), `${baseKey("h-aaa", a)}/3`);
  assert.equal(segmentOf(a.segFrames * 2 + 5, a), 2);
  assert.equal(segmentCount(a.segFrames * 2 + 1, a), 3);
});

test("cache: the least recently used segments are evicted past the cap, and the manifest forgets them", async () => {
  const spec = planStrip(1920, 1080, 30);
  const base = baseKey("h-x", spec);
  const cache = new MediaCache(new MemoryStore(), 3_000);
  const seg = (n: number) => packSegment(n * spec.segFrames, spec.stride, [new Uint8Array(1000 - 20 - 8)]); // 1000 bytes each
  const frames = spec.segFrames * 3;
  const m = await loadManifest(cache, base, spec, frames);
  assert.equal(m.done.length, 0);
  for (let s = 0; s < 3; s++) { await cache.put(segmentKey(base, s), seg(s)); m.done.push(s); }
  await saveManifest(cache, base, m); // + manifest bytes: over the cap, segment 0 (oldest) goes
  assert.equal(await cache.has(segmentKey(base, 0)), false);
  assert.equal(await cache.has(manifestKey(base)), true);
  const again = await loadManifest(cache, base, spec, frames);
  assert.deepEqual(again.done.filter((s) => s !== 0).sort(), [1, 2].filter((s) => again.done.includes(s)));
  assert.equal(again.done.includes(0), false);
  // A different frame count (the file changed) starts over.
  assert.deepEqual((await loadManifest(cache, base, spec, frames + 1)).done, []);
  // The cap can be lowered later: everything beyond it goes.
  await cache.setLimit(1_200);
  assert.ok(cache.bytes <= 1_200);
});

test("manager: a clip that needs a strip is queued, a fast short one is not, off cancels", async () => {
  const handle = (frames: number, maxGop: number, w: number, h: number) => ({
    info: { container: "mp4", durationTicks: 0, video: { codec: "avc1", width: w, height: h, rotation: 0, sampleRate: 0, channels: 0, durationTicks: 0, packets: frames, fps: { num: 30, den: 1 }, vfr: false } },
    gop: () => ({ frames, maxGop, meanGop: maxGop }),
    stream: () => { throw new Error("never idle in this test"); },
  }) as never;
  const progress: (number | null)[] = [];
  const m = new StripManager({ idle: () => false, progress: (p) => progress.push(p), store: () => new MemoryStore(), tier: "mid" });
  m.register("long", handle(900, 150, 1920, 1080), "h-long");
  m.register("short-gop", handle(900, 30, 1920, 1080), "h-short");
  await new Promise((r) => setTimeout(r, 30));
  const by = (id: string) => m.stats().media.find((e) => e.id === id)!;
  assert.equal(by("long").state, "building"); // picked up (waiting for idle)
  assert.equal(by("short-gop").state, "skipped");
  assert.equal(by("short-gop").reason, "fast-enough");
  assert.ok(progress.includes(0));
  // Measured slow seeks wake the skipped clip.
  for (let i = 0; i < 8; i++) m.noteSeek("short-gop", 300);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(["queued", "building"].includes(by("short-gop").state));
  m.setEnabled(false);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(progress.at(-1), null); // the status indicator goes away
  assert.equal(await m.picture("long", 10), undefined);
  m.dispose();
});
