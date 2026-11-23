import test from "node:test";
import assert from "node:assert/strict";
import { MediaDecodeError, type DecodedFrame, type MediaApi, type MediaHandle } from "../../packages/engine-client/src/types";
import { createRemoteMedia, frameIndexIn, NativeMediaBridge, type NativeCall, type NativeOp } from "../../apps/web/src/preview/nativeMedia";

const PTS = [0, 100, 300];
const info = { container: "mp4", durationTicks: 400, video: { codec: "h264", width: 4, height: 2, rotation: 0, sampleRate: 0, channels: 0, durationTicks: 400, packets: 3, vfr: false }, audio: { codec: "aac", width: 0, height: 0, rotation: 0, sampleRate: 48000, channels: 2, durationTicks: 400, packets: 1, vfr: false } };

/** A native decoder over a made-up file: frame i is filled with i, audio sample n is n. */
function fakeMedia(log: string[] = []): MediaApi {
  return {
    open: async (file) => {
      const path = (file as Blob & { path?: string }).path;
      log.push(`open ${path}`);
      if (path === "/gone.mp4") throw new MediaDecodeError("io", "no such file");
      let closed = false;
      const h = {
        info, frameKind: "cpu", audioRate: 48000,
        frameIndexAt: () => 0,
        presentationTicks: () => PTS,
        videoFrame: async (i: number): Promise<DecodedFrame> => {
          if (i === 2) throw new MediaDecodeError("unsupported", "codec x");
          // The real native handle returns a view 8 bytes into the IPC buffer.
          const buf = new Uint8Array(8 + 4 * 2 * 4).fill(i);
          return { kind: "cpu", index: i, ptsTicks: PTS[i] ?? 0, width: 4, height: 2, rgba: new Uint8Array(buf.buffer, 8), release: () => void log.push(`release ${i}`) };
        },
        stream: () => { throw new Error("unused"); },
        audio: async (s: number, n: number) => Float32Array.from({ length: n * 2 }, (_, k) => s + k),
        stats: () => ({ received: 0, closed: 0, open: 0 }),
        close: async () => { closed = true; log.push("close"); },
      } as unknown as MediaHandle;
      void closed;
      return h;
    },
  };
}

/** The UI thread and the Worker, joined by a function call (the real ones use postMessage with transfer). */
function wire(media: MediaApi): { call: NativeCall; bridge: NativeMediaBridge; transfers: number[] } {
  const bridge = new NativeMediaBridge(media);
  const transfers: number[] = [];
  const call: NativeCall = async (q: NativeOp) => {
    const { value, transfer } = await bridge.answer(q);
    transfers.push(transfer.length);
    return value;
  };
  return { call, bridge, transfers };
}

test("preview of an on-disk file: the Worker side gets info, timestamps and frames from the native decoder, no copy of the file", async () => {
  const log: string[] = [];
  const { call, transfers } = wire(fakeMedia(log));
  const h = await createRemoteMedia(call).openPath("/clips/a.mp4");
  assert.equal(h.info.container, "mp4");
  assert.equal(h.audioRate, 48000);
  assert.deepEqual([-1, 0, 99, 100, 299, 300, 10_000].map((t) => h.frameIndexAt(t)), [0, 0, 0, 1, 1, 2, 2]);
  const f = await h.videoFrame(1);
  assert.equal(f.kind, "cpu");
  assert.deepEqual([f.width, f.height, f.ptsTicks], [4, 2, 100]);
  assert.ok(f.kind === "cpu" && f.rgba.length === 32 && f.rgba.every((v) => v === 1));
  f.release();
  assert.deepEqual(h.stats(), { received: 1, closed: 1, open: 0 });
  assert.ok(log.includes("open /clips/a.mp4") && log.includes("release 1"), "the native frame is released after it was handed over");
  assert.ok(transfers.every((n) => n <= 1));
});

test("preview audio comes back as interleaved f32 at the project rate", async () => {
  const { call } = wire(fakeMedia());
  const h = await createRemoteMedia(call).openPath("/a.mp4");
  assert.deepEqual([...(await h.audio(10, 2))], [10, 11, 12, 13]);
});

test("preview errors keep their kind across the thread boundary (unsupported names the codec, io for a missing file)", async () => {
  const { call } = wire(fakeMedia());
  await assert.rejects(createRemoteMedia(call).openPath("/gone.mp4"), (e: unknown) => e instanceof MediaDecodeError && e.kind === "io" && /no such file/.test(e.message));
  const h = await createRemoteMedia(call).openPath("/a.mp4");
  await assert.rejects(h.videoFrame(2), (e: unknown) => e instanceof MediaDecodeError && e.kind === "unsupported" && /codec x/.test(e.message));
  await assert.rejects(h.videoFrame(99), (e: unknown) => e instanceof MediaDecodeError && e.kind === "out_of_range");
});

test("preview: close frees the native handle once, later calls say 'closed'; the bridge closes leftovers on dispose", async () => {
  const log: string[] = [];
  const { call, bridge } = wire(fakeMedia(log));
  const a = await createRemoteMedia(call).openPath("/a.mp4");
  await createRemoteMedia(call).openPath("/b.mp4");
  await a.close();
  await a.close();
  assert.equal(log.filter((l) => l === "close").length, 1);
  await assert.rejects(a.videoFrame(0), (e: unknown) => e instanceof MediaDecodeError && e.kind === "invalid");
  await bridge.dispose();
  assert.equal(log.filter((l) => l === "close").length, 2);
  const r = await bridge.answer({ op: "frame", handle: 1, index: 0 });
  assert.ok(typeof r.value === "object" && r.value !== null && "error" in r.value);
});

test("preview: a stream reads frames in order and ends", async () => {
  const { call } = wire(fakeMedia());
  const h = await createRemoteMedia(call).openPath("/a.mp4");
  const s = h.stream(1);
  const a = await s.next();
  assert.equal(a?.index, 1);
  a?.release();
  assert.equal(await s.next().catch(() => "stop"), "stop"); // frame 2 fails in this fake: the error reaches the caller
  s.close();
  assert.equal(await s.next(), null);
});

test("frameIndexIn matches the engine client rule on empty and single-frame clips", () => {
  assert.equal(frameIndexIn([], 5), 0);
  assert.equal(frameIndexIn([0], 5), 0);
});
