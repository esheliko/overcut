import test from "node:test";
import assert from "node:assert/strict";
import type { MediaRef } from "../../packages/engine-client/src/model.generated";
import type { PeaksJob } from "../../packages/engine-client/src/types";
import { MediaCache, MemoryStore, fingerprint } from "../../apps/web/src/media/cache";
import { extractPeaks, peaksComplete, peaksKey } from "../../apps/web/src/media/peaks-job";
import { INTERVALS, intervalFor } from "../../apps/web/src/media/thumbs";
import type { MediaHost } from "../../apps/web/src/media/host";

const bytes = (n: number, v = 1) => new Uint8Array(n).fill(v);

test("cache: evicts least recently used entries past the byte limit, and keeps what was read recently", async () => {
  const c = new MediaCache(new MemoryStore(), 100);
  await c.put("a", bytes(40));
  await c.put("b", bytes(40));
  assert.ok(await c.get("a")); // a is now newer than b
  await c.put("c", bytes(40)); // 120 > 100: b (oldest) goes
  assert.equal(await c.has("b"), false);
  assert.equal(await c.has("a"), true);
  assert.equal(await c.has("c"), true);
  assert.equal(c.bytes, 80);
  await c.put("huge", bytes(500)); // larger than the whole cache: ignored, evicts nothing
  assert.equal(c.size, 2);
  await c.setLimit(40);
  assert.equal(c.bytes, 40);
  const before = c.bytes;
  await c.put("a", bytes(10)); // replacing an entry replaces its size
  assert.ok(c.bytes <= 40 && c.bytes !== before + 10);
});

test("cache: rebuilds its index from the store (survives a restart) and tolerates a failing store", async () => {
  const store = new MemoryStore();
  await new MediaCache(store, 1000).put("k", bytes(10, 7));
  const again = new MediaCache(store, 1000);
  assert.deepEqual([...(await again.get("k"))!], [...bytes(10, 7)]);
  const broken = new MediaCache({ list: async () => { throw new Error("x"); }, get: async () => { throw new Error("x"); }, put: async () => { throw new Error("x"); }, delete: async () => undefined }, 1000);
  await broken.put("k", bytes(1));
  assert.equal(await broken.get("k"), null);
});

test("fingerprint prefers the content hash and is file-name safe", () => {
  assert.equal(fingerprint({ hash: "ab12", uri: "x" }), "h-ab12");
  assert.equal(fingerprint({ uri: "../a b/c:d" }), "u-.._a_b_c_d");
});

test("thumbnail interval: smallest step whose slot is at least one thumbnail wide", () => {
  assert.equal(INTERVALS[intervalFor(40, 78)], 2); // 2 s * 40 px/s = 80 px
  assert.equal(INTERVALS[intervalFor(1200, 78)], 0.25);
  assert.equal(INTERVALS[intervalFor(2, 78)], 60);
  assert.equal(intervalFor(0.0001, 78), INTERVALS.length - 1);
  for (let i = 1; i < INTERVALS.length; i++) assert.ok(INTERVALS[i]! / INTERVALS[i - 1]! <= 2.5, "slots stay within 2.5x a thumbnail");
});

// A stand-in for the engine's builder: records frames and writes a header-only "file" (the real format is tested in Rust).
function stubEngine(log: { begun: (Uint8Array | undefined)[]; pushed: number }) {
  const file = (frames: number, complete: boolean) => { const b = new Uint8Array(24); b.set([0x4f, 0x43, 0x50, 0x4b, 1, complete ? 1 : 0]); new DataView(b.buffer).setUint32(12, frames, true); return b; };
  return {
    peaks: {
      begin: async (_sr: number, _ch: number, resume?: Uint8Array): Promise<PeaksJob> => {
        log.begun.push(resume);
        let frames = resume ? new DataView(resume.buffer).getUint32(12, true) : 0;
        return {
          nextFrame: frames,
          push: async (pcm: Int16Array) => { frames += pcm.length / 2; log.pushed += pcm.length / 2; },
          snapshot: async () => file(frames, false),
          finish: async () => file(frames, true),
          dispose: async () => undefined,
        };
      },
      open: async () => { throw new Error("unused"); },
    },
  };
}
const media: MediaRef = { id: "m", kind: "audio", name: "m", uri: "a.wav" };
const host = (total: number): MediaHost => ({
  audioFormat: async () => ({ sampleRate: 1000, channels: 2, frames: total }),
  readAudio: async (_m, start, n) => new Int16Array(Math.max(0, Math.min(n, total - start)) * 2),
  thumbnail: async () => { throw new Error("unused"); },
});

test("extractPeaks: decodes progressively, publishes partial files, caches the final one, and serves it next time", async () => {
  const log = { begun: [] as (Uint8Array | undefined)[], pushed: 0 };
  const cache = new MediaCache(new MemoryStore());
  const seen: number[] = [];
  const r = await extractPeaks({ engine: stubEngine(log), host: host(10_000), cache, media, chunkSeconds: 1, publishEveryMs: 0, onFile: (_f, p) => seen.push(p) });
  assert.ok(r.file && peaksComplete(r.file));
  assert.equal(r.decodedFrames, 10_000);
  assert.ok(seen.length > 3 && seen.every((p, i) => i === 0 || p >= seen[i - 1]!) && seen.at(-1) === 1, "progress is monotonic and ends at 1");
  assert.ok(await cache.has(peaksKey(media)));
  const again = await extractPeaks({ engine: stubEngine(log), host: host(10_000), cache, media });
  assert.equal(again.cached, true);
  assert.equal(again.decodedFrames, 0);
  assert.equal(log.pushed, 10_000, "the second run decoded nothing");
});

test("extractPeaks: a cancelled job keeps its partial file and the next run resumes where it stopped", async () => {
  const log = { begun: [] as (Uint8Array | undefined)[], pushed: 0 };
  const cache = new MediaCache(new MemoryStore());
  const ac = new AbortController();
  const first = await extractPeaks({ engine: stubEngine(log), host: host(10_000), cache, media, chunkSeconds: 1, publishEveryMs: 1e9, signal: ac.signal, onFile: () => undefined,
    ...{} });
  assert.ok(first.file);
  // Second scenario: abort after the third chunk.
  const cache2 = new MediaCache(new MemoryStore());
  let chunks = 0;
  const h = host(10_000);
  const abortingHost: MediaHost = { ...h, readAudio: async (m, s, n) => { if (++chunks === 4) ac.abort(); return h.readAudio(m, s, n); } };
  const cancelled = await extractPeaks({ engine: stubEngine(log), host: abortingHost, cache: cache2, media, chunkSeconds: 1, signal: ac.signal });
  assert.equal(cancelled.file, null);
  const partial = await cache2.get(peaksKey(media));
  assert.ok(partial && !peaksComplete(partial));
  const resumed = await extractPeaks({ engine: stubEngine(log), host: host(10_000), cache: cache2, media, chunkSeconds: 1 });
  assert.ok(resumed.file && peaksComplete(resumed.file));
  assert.ok(resumed.decodedFrames < 10_000 && resumed.decodedFrames >= 5_000, `resumed run decoded only the rest (${resumed.decodedFrames})`);
  assert.ok(log.begun.at(-1), "begin() received the cached partial file");
});

test("extractPeaks: media without audio yields no file", async () => {
  const r = await extractPeaks({ engine: stubEngine({ begun: [], pushed: 0 }), host: { ...host(1), audioFormat: async () => null }, cache: new MediaCache(new MemoryStore()), media });
  assert.equal(r.file, null);
});
