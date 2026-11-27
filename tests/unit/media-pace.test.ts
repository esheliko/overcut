import test from "node:test";
import assert from "node:assert/strict";
import type { MediaRef } from "../../packages/engine-client/src/model.generated";
import type { PeaksJob } from "../../packages/engine-client/src/types";
import { MediaCache, MemoryStore } from "../../apps/web/src/media/cache";
import { extractPeaks } from "../../apps/web/src/media/peaks-job";
import { pace, setPlaybackBusy, backgroundBusy } from "../../apps/web/src/media/pace";
import type { MediaHost } from "../../apps/web/src/media/host";

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

test("pace: yields to the event loop even when nothing is busy", async () => {
  let ran = false;
  setTimeout(() => { ran = true; }, 0);
  await pace();
  assert.equal(ran, true, "a zero-delay timer queued before pace() ran before it resolved");
});

test("pace: holds while the preview plays and goes on as soon as it stops", async () => {
  setPlaybackBusy(true);
  assert.equal(backgroundBusy(), true);
  let done = false;
  const p = pace().then(() => { done = true; });
  await tick(30);
  assert.equal(done, false, "still waiting while playing");
  setPlaybackBusy(false);
  await p;
  assert.equal(done, true);
  assert.equal(backgroundBusy(), false);
});

test("extractPeaks: takes a step of the supplied pacing between chunks", async () => {
  const media = { id: "m", kind: "audio", name: "a", uri: "a.wav", hash: "h", duration: 1 } as unknown as MediaRef;
  const host: MediaHost = {
    audioFormat: async () => ({ sampleRate: 1000, channels: 1, frames: 5000 }),
    readAudio: async (_m, s, n) => new Int16Array(Math.max(0, Math.min(n, 5000 - s))),
    thumbnail: async () => { throw new Error("unused"); },
  };
  const job: PeaksJob = { nextFrame: 0, push: async () => undefined, snapshot: async () => new Uint8Array(1), finish: async () => new Uint8Array([0x4f, 0x43, 0x50, 0x4b, 0, 1, ...new Array(18).fill(0)]), dispose: async () => undefined } as unknown as PeaksJob;
  let paced = 0;
  await extractPeaks({ engine: { peaks: { begin: async () => job } } as never, host, cache: new MediaCache(new MemoryStore()), media, chunkSeconds: 1, publishEveryMs: 1e9, pace: async () => { paced++; } });
  assert.equal(paced, 5, "one pause per 1 s chunk of a 5 s file");
});
