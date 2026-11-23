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
