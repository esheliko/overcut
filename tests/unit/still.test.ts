import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { isImageHead, openStill } from "../../packages/engine-client/src/decode/still";
import { openBlobMedia } from "../../packages/engine-client/src/export/blob-media";

/** A picture is a one-frame clip: the same handle serves the preview and the export. The browser APIs it needs are stubbed (this runs in Node). */
const head = (...b: number[]) => Uint8Array.from([...b, ...new Array(16).fill(0)]);
const PNG = head(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const MP4 = Uint8Array.from([0, 0, 0, 0x20, ...Buffer.from("ftypisom"), 0, 0, 2, 0]);

let made = 0;
let closedFrames = 0;
let closedBitmaps = 0;
const g = globalThis as Record<string, unknown>;
const saved = { createImageBitmap: g.createImageBitmap, VideoFrame: g.VideoFrame, OffscreenCanvas: g.OffscreenCanvas };
function stubBrowser(opts: { videoFrame: boolean; decodes: boolean }) {
  made = closedFrames = closedBitmaps = 0;
  g.createImageBitmap = async () => {
    if (!opts.decodes) throw new Error("bad picture");
    return { width: 40, height: 30, close: () => void closedBitmaps++ };
  };
  g.VideoFrame = opts.videoFrame ? class { constructor() { made++; } close() { closedFrames++; } } : undefined;
  g.OffscreenCanvas = class {
    constructor(readonly width: number, readonly height: number) {}
    getContext() { return { drawImage() {}, getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(7) }) }; }
  };
}
afterEach(() => Object.assign(g, saved));
const file = (bytes: Uint8Array) => new Blob([bytes as BlobPart]);

test("pictures are recognised by their first bytes, movies and junk are not", () => {
  assert.ok(isImageHead(PNG));
  assert.ok(isImageHead(head(0xff, 0xd8, 0xff, 0xe0)));
  assert.ok(isImageHead(Uint8Array.from([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8 ")])));
  assert.ok(isImageHead(Uint8Array.from([0, 0, 0, 0x1c, ...Buffer.from("ftypheic"), 0, 0, 0, 0])));
  assert.ok(!isImageHead(MP4), "an MP4 is a movie");
  assert.ok(!isImageHead(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0])), "WebM");
  assert.ok(!isImageHead(new Uint8Array(4)), "too short");
});

test("openStill: not a picture means null (the video demuxer goes on); a picture is a one-frame clip at every time", async () => {
  stubBrowser({ videoFrame: true, decodes: true });
  assert.equal(await openStill(file(MP4)), null);
  const h = (await openStill(file(PNG)))!;
  assert.equal(h.info.video?.packets, 1);
  assert.deepEqual([h.info.video?.width, h.info.video?.height, h.info.video?.rotation], [40, 30, 0]);
  assert.equal(h.info.audio, undefined);
  assert.equal(h.frameKind, "gpu");
  for (const t of [0, 1, 5 * 705_600_000]) assert.equal(h.frameIndexAt(t), 0);
  const f = await h.videoFrame(7); // any index: there is one picture
  assert.equal(f.kind, "gpu");
  assert.equal(f.index, 0);
  f.release();
  f.release(); // twice is harmless
  assert.deepEqual([made, closedFrames, h.stats().open], [1, 1, 0]);
  const s = h.stream(0, 2);
  assert.ok(await s.next());
  assert.equal(await s.next(), null);
  await h.close();
  assert.equal(closedBitmaps, 1);
  await assert.rejects(h.videoFrame(0), /closed/);
});

test("without VideoFrame (or when asked for CPU frames) the picture comes as RGBA, a fresh copy each time", async () => {
  stubBrowser({ videoFrame: false, decodes: true });
  const h = (await openStill(file(PNG)))!;
  assert.equal(h.frameKind, "cpu");
  const a = await h.videoFrame(0);
  const b = await h.videoFrame(0);
  assert.ok(a.kind === "cpu" && b.kind === "cpu");
  assert.equal(a.rgba.length, 40 * 30 * 4);
  assert.notEqual(a.rgba.buffer, b.rgba.buffer, "the desktop bridge transfers (detaches) the buffer it is given");
  stubBrowser({ videoFrame: true, decodes: true });
  assert.equal((await openStill(file(PNG), { gpu: false }))!.frameKind, "cpu");
});

test("a picture this device cannot decode is an 'unsupported' error in words", async () => {
  stubBrowser({ videoFrame: true, decodes: false });
  await assert.rejects(openStill(file(PNG)), (e: { kind?: string; message?: string }) => e.kind === "unsupported" && /cannot open this kind of picture/.test(e.message ?? ""));
});

test("export reads a picture through the same adapter: one decode, held for the whole clip, no audio", async () => {
  stubBrowser({ videoFrame: true, decodes: true });
  const h = (await openStill(file(PNG)))!;
  const opened = await openBlobMedia({ open: async () => h }, file(PNG), 48_000, "photo.png");
  assert.ok(opened.video);
  assert.equal(opened.audio, undefined);
  for (const s of [0, 1, 2.5, 4.99]) await opened.video.frame(Math.round(s * 705_600_000));
  assert.equal(made, 1, "every frame of a 5 s still is the one decoded picture");
  opened.video.close();
  assert.equal(h.stats().open, 0);
});
