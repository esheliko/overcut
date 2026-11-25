import test from "node:test";
import assert from "node:assert/strict";
import { createNativeExportApi, nativeContainer, type NativeBeginArgs, type NativeExportBackend, type NativeExportHost } from "../../packages/engine-client/src/export/native";
import { frameIndexAtTicks } from "../../packages/engine-client/src/native-media";
import { TICKS_PER_SECOND } from "../../packages/engine-client/src/export/plan";
import { ExportError } from "../../packages/engine-client/src/export/types";
import type { GpuRenderer } from "../../packages/engine-client/src/render";
import type { MediaHandle } from "../../packages/engine-client/src/types";
import type { Project } from "../../packages/engine-client/src/model.generated";

const T = Number(TICKS_PER_SECOND);
const project: Project = {
  id: "p",
  name: "t",
  schema_version: 1,
  media: [{ id: "m", kind: "video", name: "pattern", uri: "clip.mp4" }],
  sequences: [
    {
      id: "s",
      name: "s",
      frame_rate: { num: 30, den: 1 },
      resolution: { width: 64, height: 36 },
      sample_rate: 48000,
      tracks: [{ id: "v", kind: "video", locked: false, muted: false, name: "V", clips: [{ id: "c", media: "m", start: 0, source_in: 0, duration: T }] }],
    },
  ],
};

class FakeCanvas {
  constructor(public width: number, public height: number) {}
}
(globalThis as unknown as { OffscreenCanvas: typeof FakeCanvas }).OffscreenCanvas = FakeCanvas;

function fake(over: { failBegin?: string; failVideoAt?: number } = {}) {
  const calls = { begin: [] as NativeBeginArgs[], frames: [] as number[], pcm: 0, finished: 0, cancelled: 0, removed: [] as string[], inFlight: 0, maxInFlight: 0 };
  const file = new Uint8Array(10_000_000).map((_, i) => i % 251);
  const backend: NativeExportBackend = {
    begin: async (a) => {
      if (over.failBegin) throw new Error(over.failBegin);
      calls.begin.push(a);
      return { id: 7, path: "/x/" + a.fileName, encoder: "libopenh264" };
    },
    video: async (id, rgba) => {
      assert.equal(id, 7);
      calls.inFlight++;
      calls.maxInFlight = Math.max(calls.maxInFlight, calls.inFlight);
      await new Promise((r) => setTimeout(r, 0));
      if (over.failVideoAt === calls.frames.length) {
        calls.inFlight--;
        throw new Error("encoder exploded");
      }
      calls.frames.push(rgba.length);
      calls.inFlight--;
    },
    audio: async (_id, pcm) => void (calls.pcm += pcm.length),
    finish: async () => (calls.finished++, { frames: calls.frames.length, videoEncoder: "libopenh264", audioSamples: calls.pcm / 2, fileBytes: file.length, encodeMs: 10 }),
    cancel: async () => void calls.cancelled++,
    read: async (_n, off, len) => file.slice(off, off + len),
    remove: async (n) => void calls.removed.push(n),
  };
  const renderer = {
    info: { backend: "fake" },
    resize: () => undefined,
    present: () => undefined,
    readback: async (_l: unknown, _s: unknown, out: { width: number; height: number }) => new Uint8Array(out.width * out.height * 4),
    allocStats: () => ({ textures: 0, buffers: 0, bind_groups: 0 }),
    dispose: () => undefined,
  } as unknown as GpuRenderer;
  const host: NativeExportHost = {
    backend,
    project: async () => project,
    evaluate: async (_s, ticks, n) => ({
      time: ticks, frame: 0, video_time: ticks, sample: 0, audio_samples: n,
      layers: [{ track: "v", clip: "c", media: "m", source_time: ticks, transform: { center: [0, 0], scale: [1, 1], rotation: 0 }, props: { position: [0, 0], scale: [1, 1], rotation: 0, anchor: [0, 0], crop: [0, 0, 0, 0], opacity: 1, flip: [false, false], fit: "contain" }, opacity: 1 }],
      audio: n ? [{ track: "a", clip: "c", media: "m", out_start: 0, len: n, source_start: ticks, speed: { num: 1, den: 1 }, gain: 1 }] : [],
    }),
    media: {
      open: async () =>
        ({
          info: { container: "mp4", durationTicks: T, video: { codec: "avc1.640028", width: 64, height: 36, rotation: 0, sampleRate: 0, channels: 0, durationTicks: T, packets: 30, fps: { num: 30, den: 1 }, vfr: false }, audio: { codec: "mp4a.40.2", width: 0, height: 0, rotation: 0, sampleRate: 48000, channels: 1, durationTicks: T, packets: 47, vfr: false } },
          frameKind: "cpu",
          audioRate: 48000,
          videoFrame: async (i: number) => ({ kind: "cpu", index: i, ptsTicks: 0, width: 64, height: 36, rgba: new Uint8Array(64 * 36 * 4), release: () => undefined }),
          audio: async (_s: number, n: number) => new Float32Array(n),
          stats: () => ({ received: 0, closed: 0, open: 0 }),
          close: async () => undefined,
        }) as unknown as MediaHandle,
    },
    openRenderer: async () => renderer,
  };
  return { host, calls, file };
}

test("native export: every frame and audio sample reaches the encoder once, one frame in flight, result is an MP4 the app can read back", async () => {
  const { host, calls, file } = fake();
  const job = await createNativeExportApi(host).start({ sequence: "s", sources: { m: new Blob([]) }, hardware: "prefer-software", creationTime: 86_400_000 });
  const seen: number[] = [];
  job.onProgress((p) => seen.push(p.framesDone));
  const r = await job.result;
  assert.equal(calls.begin.length, 1);
  const b = calls.begin[0]!;
  assert.deepEqual([b.width, b.height, b.fpsNum, b.fpsDen, b.audioRate, b.audioChannels, b.preferSoftware, b.creationTime], [64, 36, 30, 1, 48000, 2, true, 86400]);
  assert.match(b.fileName, /\.mp4$/);
  assert.equal(calls.frames.length, 30);
  assert.ok(calls.frames.every((n) => n === 64 * 36 * 4));
  assert.equal(calls.pcm, 48000 * 2);
  assert.equal(calls.maxInFlight, 1);
  assert.equal(calls.finished, 1);
  assert.equal(seen.at(-1), 30);
  assert.equal(r.mime, "video/mp4");
  assert.equal(r.stats.frames, 30);
  assert.equal(r.stats.codecs, "libopenh264 + aac");
  const f = await r.file();
  assert.equal(f.size, file.length);
  assert.equal(f.type, "video/mp4");
  await r.remove();
  assert.deepEqual(calls.removed, [r.fileName]);
});

test("native export: cancel stops the loop, tells Rust to delete the partial file, and rejects with 'cancelled'", async () => {
  const { host, calls } = fake();
  let cancel = (): void => undefined;
  const video = host.backend.video;
  host.backend.video = async (id, rgba) => {
    await video(id, rgba);
    if (calls.frames.length === 5) cancel();
  };
  const job = await createNativeExportApi(host).start({ sequence: "s", sources: { m: new Blob([]) } });
  cancel = () => job.cancel();
  await assert.rejects(job.result, (e: unknown) => e instanceof ExportError && e.code === "cancelled");
  assert.equal(calls.cancelled, 1);
  assert.equal(calls.finished, 0);
  assert.ok(calls.frames.length < 30);
});

test("native export: an encoder failure aborts the job as encode_failed and cleans up", async () => {
  const { host, calls } = fake({ failVideoAt: 3 });
  const job = await createNativeExportApi(host).start({ sequence: "s", sources: { m: new Blob([]) } });
  await assert.rejects(job.result, (e: unknown) => e instanceof ExportError && e.code === "encode_failed" && /exploded/.test(e.message));
  assert.equal(calls.cancelled, 1);
});

test("native export: mixed containers are refused up front; no H.264 encoder is 'unsupported'", async () => {
  const { host } = fake();
  for (const s of [{ container: "webm" as const, videoCodec: "h264" as const }, { container: "mp4" as const, audioCodec: "opus" as const }, { videoCodec: "vp9" as const, audioCodec: "aac" as const }]) {
    await assert.rejects(createNativeExportApi(host).start({ sequence: "s", sources: { m: new Blob([]) }, ...s }), (e: unknown) => e instanceof ExportError && e.code === "unsupported", JSON.stringify(s));
  }
  const none = fake({ failBegin: "libopenh264: no H.264 encoder is available" });
  const job = await createNativeExportApi(none.host).start({ sequence: "s", sources: { m: new Blob([]) } });
  await assert.rejects(job.result, (e: unknown) => e instanceof ExportError && e.code === "unsupported");
  await assert.rejects(createNativeExportApi(host).start({ sequence: "missing", sources: { m: new Blob([]) } }), (e: unknown) => e instanceof ExportError && e.code === "invalid_settings");
});

test("native export: the container follows the settings (nothing = MP4, WebM / VP9 / Opus = WebM)", () => {
  assert.equal(nativeContainer({ sequence: "s" }), "mp4");
  assert.equal(nativeContainer({ sequence: "s", container: "mp4", videoCodec: "h264", audioCodec: "aac" }), "mp4");
  assert.equal(nativeContainer({ sequence: "s", container: "webm" }), "webm");
  assert.equal(nativeContainer({ sequence: "s", videoCodec: "vp9" }), "webm");
  assert.equal(nativeContainer({ sequence: "s", container: "webm", videoCodec: "vp9", audioCodec: "opus" }), "webm");
});

test("native export: WebM (VP9 + Opus) asks Rust for a .webm file at the WebM bitrates and returns video/webm", async () => {
  const { host, calls, file } = fake();
  const job = await createNativeExportApi(host).start({ sequence: "s", sources: { m: new Blob([]) }, container: "webm", videoCodec: "vp9", audioCodec: "opus" });
  const r = await job.result;
  const b = calls.begin[0]!;
  assert.match(b.fileName, /\.webm$/);
  assert.equal(b.audioBitrate, 128_000);
  assert.equal(b.videoBitrate, 1_000_000); // the VP9 default (0.075 bpp) is clamped to the 1 Mbit/s floor at this tiny size
  assert.equal(r.mime, "video/webm");
  assert.match(r.stats.codecs, /\+ opus$/);
  const f = await r.file();
  assert.equal(f.type, "video/webm");
  assert.equal(f.size, file.length);
});

test("native decoder: frameIndexAt picks the last frame not after the time (VFR safe), clamps at both ends", () => {
  const pts = [0, 100, 300, 301];
  assert.deepEqual([-5, 0, 99, 100, 299, 300, 301, 10_000].map((t) => frameIndexAtTicks(pts, t)), [0, 0, 0, 1, 1, 2, 3, 3]);
  assert.equal(frameIndexAtTicks([], 5), 0);
});

test("native export: a shell built without the native-media feature says 'not_yet', not a crash", async () => {
  const { host } = fake({ failBegin: "Command native_export_begin not found" });
  const job = await createNativeExportApi(host).start({ sequence: "s", sources: { m: new Blob([]) } });
  await assert.rejects(job.result, (e: unknown) => e instanceof ExportError && e.code === "not_yet");
});
