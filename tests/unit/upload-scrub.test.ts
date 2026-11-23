import test from "node:test";
import assert from "node:assert/strict";
import { browserVersion, chooseUploadPath, parseChoice, pickPath, uploadKey, type UploadChoice } from "../../apps/web/src/preview/uploadPath";
import { FrameCache, ThumbStore } from "../../apps/web/src/preview/scrubCache";
import { Player } from "../../apps/web/src/preview/player";
import { fastestUpload, verdict } from "../../apps/web/src/diagnostics/report";
import type { TestResult } from "../../apps/web/src/diagnostics/types";

// --- upload path selection ----------------------------------------------------------------------------------------------------------------------

test("the faster measured path wins, zero-copy is never assumed, a failed path never wins, nothing measurable falls back to the frame path", () => {
  assert.equal(pickPath({ frame: 5.9, cpu: 27 }), "frame"); // Intel UHD 630: copy 5.9 ms vs CPU 27 ms
  assert.equal(pickPath({ frame: 40, cpu: 9 }), "cpu");
  assert.equal(pickPath({ frame: 10, cpu: 9.5 }), "frame"); // within 10%: the path that needs no CPU copy
  assert.equal(pickPath({ frame: null, cpu: 30 }), "cpu");
  assert.equal(pickPath({ frame: 8, cpu: null }), "frame");
  assert.equal(pickPath({ frame: null, cpu: null }), "frame");
});

test("the cache key changes with the GPU, the backend and the browser version", () => {
  const ua = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/157.0.0.0 Mobile Safari/537.36";
  assert.equal(browserVersion(ua), "Chrome/157.0.0.0");
  assert.equal(browserVersion("something odd"), "unknown");
  const k = uploadKey("webgl2", "Xclipse 940", ua);
  assert.notEqual(k, uploadKey("webgpu", "Xclipse 940", ua));
  assert.notEqual(k, uploadKey("webgl2", "Mali", ua));
  assert.notEqual(k, uploadKey("webgl2", "Xclipse 940", ua.replace("157", "158")));
});

test("a stored choice is reused without measuring; a bad or missing one is measured and saved; a run where nothing worked is not remembered", async () => {
  const measured: string[] = [];
  const saved: [string, UploadChoice][] = [];
  const base = {
    key: "k",
    save: (k: string, v: UploadChoice) => void saved.push([k, v]),
    measure: async (p: "frame" | "cpu") => { measured.push(p); return p === "frame" ? 22 : 7; },
  };
  const hit = await chooseUploadPath({ ...base, cached: async () => ({ path: "cpu", ms: { cpu: 7, frame: 22 } }) });
  assert.deepEqual([hit.path, hit.source, measured.length], ["cpu", "cached", 0]);

  for (const bad of [null, "frame", { path: "direct" }, { path: 3 }]) assert.equal(parseChoice(bad), null);
  const fresh = await chooseUploadPath({ ...base, cached: async () => { throw new Error("storage blocked"); } });
  assert.deepEqual([fresh.path, fresh.source, measured], ["cpu", "measured", ["frame", "cpu"]]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0]![0], "k");

  const none = await chooseUploadPath({ key: "k", cached: async () => null, save: (k, v) => void saved.push([k, v]), measure: async () => { throw new Error("no GPU"); } });
  assert.deepEqual([none.path, none.source, saved.length], ["frame", "default", 1]);
});

// --- caches -------------------------------------------------------------------------------------------------------------------------------------

const fr = (index: number, log: number[] = []) => ({ index, release: () => void log.push(index) });

test("frame cache: nearest frame, LRU by count, pinned frames survive eviction until unpinned, media can be dropped", () => {
  const released: number[] = [];
  const c = new FrameCache(1e9, 3, () => 10);
  for (const i of [10, 11, 12]) c.unpin(c.put("m", fr(i, released)));
  const n14 = c.nearest("m", 14)!, n11 = c.nearest("m", 11)!;
  assert.deepEqual([n14.index, n11.index], [12, 11]);
  c.unpin(n14); c.unpin(n11);
  c.unpin(c.get("m", 10)!); // 10 is now the most recent: order 11, 12, 10
  const held = c.get("m", 11)!; // pinned and recent: order 12, 10, 11
  c.unpin(c.put("m", fr(13, released)));
  assert.deepEqual(released, [12], "12 is the oldest unpinned");
  c.unpin(held);
});

test("frame cache evicts the oldest unpinned frame and releases it only once nothing draws it", () => {
  const released: number[] = [];
  const c = new FrameCache(1e9, 2, () => 10);
  const a = c.put("m", fr(1, released)); // pinned by put
  c.unpin(c.put("m", fr(2, released)));
  c.unpin(c.put("m", fr(3, released)));
  assert.deepEqual(released, [2], "1 is pinned, so 2 (the oldest unpinned) goes");
  c.unpin(a);
  c.unpin(c.put("m", fr(4, released)));
  assert.deepEqual(released, [2, 1]);
  c.dropMedia("m");
  assert.deepEqual(released.sort(), [1, 2, 3, 4]);
  assert.equal(c.size, 0);
});

test("frame cache honours the byte budget", () => {
  const released: number[] = [];
  const c = new FrameCache(25, 100, () => 10);
  for (const i of [1, 2, 3]) c.unpin(c.put("m", fr(i, released)));
  assert.deepEqual(released, [1]);
  assert.equal(c.usedBytes, 20);
});

test("thumbnail store returns the nearest in time and forgets a media item", () => {
  const closed: string[] = [];
  const b = (n: string) => ({ n, close: () => void closed.push(n) });
  const s = new ThumbStore<ReturnType<typeof b>>(3);
  s.add("m", 4, b("4"), 160, 90); s.add("m", 0, b("0"), 160, 90); s.add("m", 2, b("2"), 160, 90);
  assert.equal(s.nearest("m", 2.9)?.bitmap.n, "2");
  assert.equal(s.nearest("m", 3.1)?.bitmap.n, "4");
  assert.equal(s.nearest("m", 99)?.bitmap.n, "4");
  assert.equal(s.nearest("other", 1), undefined);
  s.add("m", 6, b("6"), 160, 90); // over the cap: the oldest added (4) goes
  assert.deepEqual(closed, ["4"]);
  s.dropMedia("m");
  assert.equal(s.nearest("m", 1), undefined);
});

// --- stand-in -> exact swap ---------------------------------------------------------------------------------------------------------------------

const T = 705_600_000;
const STEP = T / 30;

function setup(opts: { thumb?: boolean; strip?: boolean } = {}) {
  const closed: number[] = [];
  const seeks: [string, number][] = [];
  const calls: number[] = [];
  const waiting = new Map<number, { resolve(f: unknown): void; reject(e: unknown): void }>();
  let latest = 0;
  const frame = (index: number) => ({ index, ptsTicks: index * STEP, width: 1920, height: 1080, kind: "cpu" as const, rgba: new Uint8Array(4).fill(index), release: () => undefined });
  const media = {
    info: { video: { width: 1920, height: 1080, rotation: 0 } },
    frameIndexAt: (t: number) => Math.round(t / STEP),
    videoFrame: (index: number) => {
      calls.push(index);
      const mine = ++latest;
      for (const [k, w] of waiting) { w.reject({ kind: "cancelled" }); waiting.delete(k); }
      return new Promise((resolve, reject) => { waiting.set(mine, { resolve: (f) => resolve(f), reject }); });
    },
    stream: (start: number) => { let i = start; return { next: async () => frame(i++), buffered: () => 0, close: () => undefined }; },
  };
  const renders: { scale: number[]; first: number | "bitmap" }[] = [];
  const player = new Player({
    rate: { num: 30, den: 1 }, size: { width: 1920, height: 1080 }, endTicks: 10 * T, sequence: "s",
    evaluate: async (ticks, n) => ({ time: ticks, frame: 0, video_time: ticks, sample: 0, audio_samples: n, audio: [], layers: [{ clip: "c", media: "m", source_time: ticks, opacity: 1, transform: { center: [960, 540], scale: [1, 1], rotation: 0 } }] }) as never,
    media: () => media as never,
    renderer: { render: (layers) => void renders.push({ scale: [...layers[0]!.scale], first: "rgba" in layers[0]!.source ? (layers[0]!.source as { rgba: Uint8Array }).rgba[0]! : "bitmap" }), dispose: () => undefined },
    fallbackClock: { now: () => 0 },
    onFrame: () => undefined,
    raf: () => () => undefined,
    standIn: opts.thumb ? () => ({ seconds: 0, bitmap: {} as ImageBitmap, width: 160, height: 90 }) : undefined,
    strip: opts.strip ? async (_m, index) => ({ bitmap: { close: () => void closed.push(index) } as unknown as ImageBitmap, width: 480, height: 270, index: index - 1 }) : undefined,
    onSeek: (m, ms) => void seeks.push([m, ms]),
  });
  const finish = (index: number) => { const w = [...waiting.values()].at(-1)!; waiting.clear(); w.resolve(frame(index)); };
  return { player, renders, calls, finish, closed, seeks, pending: () => waiting.size };
}
const settle = () => new Promise((r) => setTimeout(r, 15));

test("scrub shows the nearest filmstrip thumbnail at once, scaled to the clip, then swaps in the exact frame", async () => {
  const s = setup({ thumb: true });
  s.player.seek(30);
  await settle();
  assert.equal(s.renders.length, 1, "stand-in first");
  assert.equal(s.renders[0]!.first, "bitmap");
  assert.deepEqual(s.renders[0]!.scale, [12, 12], "1920x1080 shown from a 160x90 thumbnail");
  assert.equal(s.player.stats.firstUpdateMs.length, 1);
  assert.equal(s.player.stats.scrubMs.length, 0, "the exact frame is not there yet");
  s.finish(30);
  await settle();
  assert.equal(s.renders.length, 2);
  assert.equal(s.renders[1]!.first, 30, "then the exact frame");
  assert.deepEqual(s.renders[1]!.scale, [1, 1]);
  assert.deepEqual([s.player.stats.standIns, s.player.stats.thumbStandIns, s.player.stats.scrubMs.length], [1, 1, 1]);
  s.player.dispose();
});

test("scrub strip: its picture of the asked-for frame comes first (before a thumbnail), is scaled to the clip and closed, then the exact frame replaces it; the exact seek time is reported", async () => {
  const s = setup({ thumb: true, strip: true });
  s.player.seek(30);
  await settle();
  assert.equal(s.renders.length, 1, "stand-in first");
  assert.equal(s.renders[0]!.first, "bitmap");
  assert.deepEqual(s.renders[0]!.scale, [4, 4], "1920x1080 shown from a 480x270 strip picture");
  assert.deepEqual([s.player.stats.stripStandIns, s.player.stats.thumbStandIns, s.player.stats.standInOff], [1, 0, [1]]);
  assert.equal(s.seeks.length, 0, "the exact frame is not there yet");
  s.finish(30);
  await settle();
  assert.equal(s.renders[1]!.first, 30, "then the exact frame");
  assert.deepEqual(s.closed, [30], "the strip bitmap is closed once drawn");
  assert.equal(s.seeks.length, 1);
  assert.equal(s.seeks[0]![0], "m");
  assert.equal(s.player.isIdle(), false, "just scrubbed: background work waits");
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(s.player.isIdle(), true, "quiet for 400 ms: the strip builder may run");
  s.player.dispose();
});

test("with no thumbnail the nearest decoded frame is the stand-in; the held picture stays when there is nothing; latest wins", async () => {
  const s = setup();
  s.player.seek(30);
  await settle();
  assert.equal(s.renders.length, 0, "nothing to show yet: the previous picture stays");
  s.player.seek(31); // cancels the first request
  await settle();
  s.finish(31);
  await settle();
  assert.deepEqual(s.renders.map((r) => r.first), [31], "only the latest frame is drawn");
  s.player.seek(60); // nothing near the cache for 60 except what decode-ahead and 31 gave us
  await settle();
  assert.equal(s.renders.length >= 2 && typeof s.renders.at(-1)!.first === "number", true, "a cached frame stands in");
  assert.ok(s.renders.at(-1)!.first !== 60);
  s.finish(60);
  await settle();
  assert.equal(s.renders.at(-1)!.first, 60);
  s.player.dispose();
});

test("decode-ahead fills the cache around a paused playhead so a frame step needs no decode and updates at once", async () => {
  const s = setup();
  s.player.seek(40);
  await settle();
  s.finish(40);
  await settle(); // exact shown, decode-ahead ran
  assert.ok(s.player.cached >= 5, `cached ${s.player.cached}`);
  const decodes = s.calls.length;
  s.player.step(1);
  await settle();
  s.player.step(-2);
  await settle();
  assert.equal(s.calls.length, decodes, "no new decode for steps inside the window");
  assert.equal(s.player.stats.cacheHits, 2);
  assert.deepEqual(s.renders.slice(-2).map((r) => r.first), [41, 39]);
  assert.equal(s.player.stats.firstUpdateMs.length, 3);
  s.player.dispose();
});

// --- diagnostics verdicts -----------------------------------------------------------------------------------------------------------------------

const ok = (id: TestResult["id"], metrics: TestResult["metrics"]): TestResult => ({ id, status: "ok", metrics, took_ms: 1 });

test("upload verdict follows the fastest route, so Intel UHD 630 (copy 5.9 ms, direct 22.8 ms) is not 'slow'; phones with only WebGL2 get a verdict", () => {
  const laptop = ok("gpuUpload", { direct_p50_ms: 22.8, copy_p50_ms: 5.9, cpu_p50_ms: 27 });
  assert.equal(fastestUpload(laptop)?.route, "copy");
  assert.equal(verdict(laptop), "good");
  const phone = ok("gpuUpload", { gl_frame_p50_ms: 11, gl_cpu_p50_ms: 30, gl_gpu: "x" });
  assert.equal(verdict(phone), "ok");
  assert.equal(verdict(ok("gpuUpload", { direct_p50_ms: "failed", copy_p50_ms: 40 })), "slow");
  assert.equal(verdict(ok("fillRate", { gl_layers_at_60fps: 9 })), "good");
  assert.equal(verdict(ok("fillRate", { layers_at_60fps: 3, gl_layers_at_60fps: 5 })), "ok");
});
