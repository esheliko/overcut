import test from "node:test";
import assert from "node:assert/strict";
import type { MediaHandle } from "../../packages/engine-client/src/types";
import { engineMediaHost } from "../../apps/web/src/media/engine-host";

const media = { id: "m", kind: "video" as const, name: "m", uri: "x" };
const fake = (): MediaHandle => ({
  info: { container: "mp4", durationTicks: 705_600_000 * 2, audio: { codec: "opus", width: 0, height: 0, rotation: 0, sampleRate: 48000, channels: 2, durationTicks: 705_600_000 * 2, packets: 10, vfr: false } },
  frameKind: "cpu", audioRate: 48000,
  videoFrame: async () => { throw new Error("unused"); },
  audio: async (_s: number, n: number) => Float32Array.from({ length: n * 2 }, (_, i) => (i % 2 ? -2 : 0.5)),
  stats: () => ({ received: 0, closed: 0, open: 0 }),
  close: async () => undefined,
}) as unknown as MediaHandle;

test("engineMediaHost: audio format from the track, f32 -> clamped i16, handle opened once", async () => {
  const h = fake();
  let opens = 0;
  const host = engineMediaHost(async () => { opens++; return h; });
  assert.deepEqual(await host.audioFormat(media), { sampleRate: 48000, channels: 2, frames: 96000 });
  const pcm = await host.readAudio(media, 0, 3);
  assert.deepEqual([...pcm], [16384, -32768, 16384, -32768, 16384, -32768]);
  assert.equal(opens, 1);
});

test("engineMediaHost: a media file without audio has no audio format; a failed open can be retried", async () => {
  const noAudio = { ...fake(), info: { container: "mp4", durationTicks: 1 } } as MediaHandle;
  assert.equal(await engineMediaHost(async () => noAudio).audioFormat(media), null);
  let n = 0;
  const host = engineMediaHost(async () => { if (n++ === 0) throw new Error("boom"); return fake(); });
  await assert.rejects(host.audioFormat(media));
  assert.ok(await host.audioFormat(media));
});

import { thumbPlan } from "../../apps/web/src/media/engine-host";

test("thumbPlan: a portrait phone clip (rotation 90/270) comes out upright and covers the box; 0/180 keep the coded shape", () => {
  // coded 1920x1080 landscape pixels, rotation 90: displayed portrait 1080x1920
  const p = thumbPlan(1920, 1080, 90, 96, 54);
  assert.equal(p.rot, 90);
  assert.ok(p.out.h > p.out.w, "upright output is portrait");
  assert.ok(p.out.w >= 96 && p.out.h >= 54, "covers the box");
  assert.deepEqual({ w: p.coded.w, h: p.coded.h }, { w: p.out.h, h: p.out.w });
  const q = thumbPlan(1920, 1080, 270, 96, 54);
  assert.equal(q.rot, 270);
  assert.deepEqual(q.out, p.out);
  assert.deepEqual(thumbPlan(1920, 1080, 0, 96, 54).out, thumbPlan(1920, 1080, 180, 96, 54).out);
  assert.equal(thumbPlan(1920, 1080, -90, 96, 54).rot, 270);
  assert.equal(thumbPlan(1920, 1080, 360, 96, 54).rot, 0);
});

test("importedMediaHost: opens the bin's file through the engine; offline media rejects (placeholder)", async () => {
  const { importedMediaHost } = await import("../../apps/web/src/media/engine-host");
  const file = new Blob([new Uint8Array(4)]) as unknown as File;
  let opened: unknown = null;
  const engine = { media: { open: async (f: Blob) => { opened = f; return fake(); } } } as never;
  const host = importedMediaHost(engine, async (id) => (id === "m" ? file : null));
  assert.ok(await host.audioFormat(media));
  assert.equal(opened, file);
  await assert.rejects(host.audioFormat({ ...media, id: "gone" }));
});

test("engineMediaHost: release closes the handle once and the next request opens the file again", async () => {
  let opens = 0, closed = 0;
  const mk = () => { const h = fake(); (h as { close: () => Promise<void> }).close = async () => { closed++; }; return h; };
  const host = engineMediaHost(async () => { opens++; return mk(); });
  await host.audioFormat(media);
  await host.release!(media.id);
  await host.release!(media.id); // nothing left to close
  assert.equal(closed, 1);
  await host.audioFormat(media);
  assert.equal(opens, 2);
});
