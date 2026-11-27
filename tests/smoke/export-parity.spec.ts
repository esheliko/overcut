import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * M2-030: what the export writes is what the preview shows. A two-track project (V1 at 2x speed, V2 a smaller overlay of the same clip whose position is
 * keyframed and whose opacity is below 1) on a vertical canvas with the blurred background is shown in the preview and exported through the production
 * pipeline (decode -> evaluate -> compositor -> VP9 -> WebM). The file is then decoded again, and its frames at three timestamps are compared with the
 * preview's frames at the same timestamps; the length must be exact. Headless Chromium (software GL, software VP9): deterministic, no ffprobe.
 *
 * "Same" means within a tolerance on a 36 x 64 area-averaged copy of both pictures (the preview canvas and the export have their own sizes, and VP9 is
 * lossy). The tolerance is far below the difference between two different frames of this project, which the test also checks, so it cannot pass by
 * comparing black with black or the wrong frame with the right one. It found a real export bug: two layers reading one media at different times
 * (here V1 and V2 are the same file) released the first picture before it was drawn (`export/blob-media.ts`).
 *
 * To look at a failure: `PARITY_DUMP=<existing dir> npm run smoke -- tests/smoke/export-parity.spec.ts --project=desktop` writes the pictures and the file.
 */
const CLIP = resolve("crates/media/tests/fixtures/h264_aac.mp4"); // 160x120, 30 fps, 1 s, testsrc (moves every frame) + sine
const TICKS = 705_600_000;
const FRAMES = [2, 7, 12]; // of 15: the overlay is at 1/15, 7/15 and 12/15 of its way across
const DUMP = process.env.PARITY_DUMP;

type Px = { width: number; height: number; data: number[] };
type Result = {
  stats: { frames: number; durationSeconds: number };
  videoPackets: number;
  lastPtsTicks: number;
  frameTicks: number;
  size: [number, number];
  /** per tested frame: mean absolute difference (0..255, RGB) between the preview and the export at the same frame */
  same: number[];
  /** the same, preview frame i against the export's frame j (-1 on the diagonal) */
  other: number[][];
  /** brightest value in the top band (blurred background) of the export and of the preview */
  topBand: number;
  previewTopBand: number;
  dump?: { preview: string; export: string }[];
};

test("export parity: the decoded export matches the preview at three timestamps and has the exact length (multi-track, keyframes, opacity, speed, blur)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "export does not depend on the viewport");
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?e2e=bare"); // the test hooks, without the seeded offline media item of `?e2e`
  await page.waitForFunction(() => !!(window as unknown as { __overcut?: unknown }).__overcut, undefined, { timeout: 30_000 });
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await page.getByTestId("media-input").setInputFiles(CLIP);
  await expect(page.locator("#tl-summary")).toContainText("2 clips");
  await expect(page.locator(".canvas")).toHaveAttribute("data-loaded", "true", { timeout: 20_000 });
  await expect.poll(() => page.evaluate(async () => (await (window as unknown as { __overcutPreview: { media(): Promise<unknown[]> } }).__overcutPreview.media()).length), { timeout: 20_000 }).toBeGreaterThan(0);

  // 1. The project, through the store the panels use (so the preview follows), as one batch of the ops the UI sends.
  await page.evaluate(async (TICKS) => {
    const { session } = (window as unknown as { __overcut: { session: { editing: { project(): Promise<unknown> } } } }).__overcut;
    const store = (window as unknown as { __overcutStore: { apply(o: unknown[]): Promise<unknown> } }).__overcutStore;
    const id = (n: number) => n.toString(16).padStart(32, "0");
    type P = { media: { id: string }[]; sequences: { id: string; tracks: { id: string; kind: string; clips: { id: string }[] }[] }[] };
    const p = (await session.editing.project()) as P;
    const seq = p.sequences[0]!;
    const media = p.media[0]!.id;
    const v1 = seq.tracks.find((t) => t.kind === "video")!;
    const a1 = seq.tracks.find((t) => t.kind === "audio")!;
    const double = { num: 2, den: 1 };
    const line = (a: number, b: number) => [{ t: 0, v: a, easing: { kind: "linear" } }, { t: TICKS / 2, v: b, easing: { kind: "linear" } }];
    await store.apply([
      { op: "set_canvas", sequence: seq.id, frame_rate: { num: 30, den: 1 }, resolution: { width: 360, height: 640 }, size_fixed: true, rate_fixed: false },
      { op: "set_background", sequence: seq.id, background: { mode: "blur", colour: [0, 0, 0], blur: 50 } },
      // V1 and its sound at 2x: the 1 s clip becomes 0.5 s (15 frames), and so is the whole timeline
      { op: "set_clip_speed", clip: v1.clips[0]!.id, speed: double, ripple: true },
      { op: "set_clip_speed", clip: a1.clips[0]!.id, speed: double, ripple: true },
      // V2: the same file at 1x (another part of it at every frame), 40% size, sliding across and down, 70% opaque
      { op: "add_track", sequence: seq.id, index: 1, track: { id: id(0x7001), kind: "video", name: "V2", muted: false, locked: false, clips: [] } },
      { op: "insert_clip", track: id(0x7001), clip: { id: id(0x7002), media, start: 0, source_in: 0, duration: TICKS / 2 } },
      {
        op: "set_clip_transform",
        clip: id(0x7002),
        transform: { scale_x: { value: 0.4 }, scale_y: { value: 0.4 }, position_x: { value: 0, keys: line(-0.25, 0.25) }, position_y: { value: 0.3, keys: line(0.1, 0.35) }, opacity: { value: 0.7 } },
      },
    ]);
  }, TICKS);
  await expect.poll(async () => { const b = (await page.locator(".canvas").boundingBox())!; return b.height > b.width; }).toBe(true); // the canvas took its new shape
  // ... and its backing store has followed the (animated, debounced) layout: the same size twice in a row, 9:16
  let last = "";
  await expect.poll(async () => {
    const { canvas } = await page.evaluate(() => (window as unknown as { __overcutPreview: { gpu(): Promise<{ canvas: { width: number; height: number } }> } }).__overcutPreview.gpu());
    const now = `${canvas.width}x${canvas.height}`;
    const stable = now === last && Math.abs(canvas.width / canvas.height - 9 / 16) < 0.01;
    last = now;
    return stable;
  }, { timeout: 15_000, intervals: [400] }).toBe(true);

  // 2. The preview's frames at the three timestamps: seek, wait until the exact frame has been drawn, then read what the preview settles on.
  const shots = await page.evaluate(async (frames) => {
    type Hook = { player: { seek(f: number): void }; stats(): Promise<{ scrubMs: number[] }>; shot(): Promise<{ width: number; height: number; data: Uint8ClampedArray }> };
    const h = (window as unknown as { __overcutPreview: Hook }).__overcutPreview;
    const out: Px[] = [];
    for (const f of frames) {
      const n = (await h.stats()).scrubMs.length;
      h.player.seek(f);
      const until = performance.now() + 15_000;
      while ((await h.stats()).scrubMs.length <= n && performance.now() < until) await new Promise((r) => setTimeout(r, 25));
      let s = await h.shot();
      // A picture the compositor has not drawn yet (a canvas that was just resized is empty): ask again, a few times.
      for (let k = 0; k < 6 && !s.data.some((v, i) => i % 4 !== 3 && v > 24); k++) s = await h.shot();
      out.push({ width: s.width, height: s.height, data: Array.from(s.data) });
    }
    return out;
  }, FRAMES);

  // 3. Export through the production pipeline, decode the file again, compare.
  const bytes = readFileSync(CLIP).toString("base64");
  const r = await page.evaluate(async ({ shots, bytes, frames, TICKS, dump }): Promise<Result> => {
    type Engine = {
      editing: { project(): Promise<unknown> };
      export: { start(s: unknown): Promise<{ result: Promise<{ file(): Promise<File>; remove(): Promise<void>; stats: { frames: number; durationSeconds: number } }> }> };
      media: { open(b: Blob, o: unknown): Promise<{ info: { video?: { packets: number } }; videoFrame(i: number): Promise<{ kind: string; rgba: Uint8Array; width: number; height: number; ptsTicks: number; release(): void }>; close(): Promise<void> }> };
    };
    const { engine } = (window as unknown as { __overcut: { engine: Engine } }).__overcut;
    const p = (await engine.editing.project()) as { media: { id: string }[]; sequences: { id: string }[] };
    const blob = new Blob([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))], { type: "video/mp4" });
    const job = await engine.export.start({ sequence: p.sequences[0]!.id, sources: { [p.media[0]!.id]: blob }, container: "webm", videoCodec: "vp9", videoBitrate: 20_000_000, hardware: "prefer-software", creationTime: 1_700_000_000_000 });
    const res = await job.result;
    const file = await res.file();
    const b64 = async (b: Uint8Array): Promise<string> => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
    if (dump) (window as unknown as { __file: string }).__file = await b64(new Uint8Array(await file.arrayBuffer()));
    const h = await engine.media.open(file, { gpu: false, audioRate: 48_000 });
    const n = h.info.video!.packets;
    const decoded: { rgba: Uint8Array; width: number; height: number }[] = [];
    let lastPts = 0;
    for (let i = 0; i < n; i++) {
      const f = await h.videoFrame(i);
      if (f.kind !== "cpu") throw new Error("expected a CPU frame");
      lastPts = f.ptsTicks;
      decoded.push({ rgba: f.rgba.slice(), width: f.width, height: f.height });
      f.release();
    }
    await h.close();

    // Area-average to 36 x 64 (both pictures through the same function), RGB only.
    const W = 36, H = 64;
    const small = (rgba: ArrayLike<number>, w: number, hgt: number): Float64Array => {
      const out = new Float64Array(W * H * 3), cnt = new Float64Array(W * H);
      for (let y = 0; y < hgt; y++) {
        const oy = Math.min(H - 1, Math.floor((y * H) / hgt));
        for (let x = 0; x < w; x++) {
          const o = oy * W + Math.min(W - 1, Math.floor((x * W) / w));
          const i = (y * w + x) * 4;
          for (let c = 0; c < 3; c++) out[o * 3 + c] = out[o * 3 + c]! + rgba[i + c]!;
          cnt[o] = cnt[o]! + 1;
        }
      }
      for (let o = 0; o < W * H; o++) for (let c = 0; c < 3; c++) out[o * 3 + c] = out[o * 3 + c]! / cnt[o]!;
      return out;
    };
    const mad = (a: Float64Array, b: Float64Array): number => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!); return s / a.length; };
    // The in-page decoder (`engine.media`) hands VideoDecoder no colour space, so this full-range file (colour range `pc`, BT.709: ffprobe says so, and
    // ffmpeg's decode of the same frames equals the preview within 2 codes) is read as limited range and stretched by 255/219, clipping at 0 and 255.
    // Apply the same stretch to the preview before comparing, so the comparison is about the export and not about that decoder. A decoder that reads
    // the range right makes `stretch` the identity: delete it then (noted in the PR as a follow-up).
    const stretch = (rgba: ArrayLike<number>): Uint8Array => { const o = new Uint8Array(rgba.length); for (let i = 0; i < o.length; i++) o[i] = i % 4 === 3 ? rgba[i]! : Math.min(255, Math.max(0, Math.round(((rgba[i]! - 16) * 255) / 219))); return o; };
    const prev = shots.map((s: Px) => small(stretch(s.data), s.width, s.height));
    const exp = decoded.map((d) => small(d.rgba, d.width, d.height));
    const at = frames.map((f: number) => exp[f]!);
    const band = (a: Float64Array): number => { let m = 0; for (let x = 0; x < W; x++) for (let y = 1; y < 6; y++) m = Math.max(m, a[(y * W + x) * 3]!, a[(y * W + x) * 3 + 1]!, a[(y * W + x) * 3 + 2]!); return m; };
    const out: Result = {
      stats: { frames: res.stats.frames, durationSeconds: res.stats.durationSeconds },
      videoPackets: n,
      lastPtsTicks: lastPts,
      frameTicks: TICKS / 30,
      size: [decoded[0]!.width, decoded[0]!.height],
      same: prev.map((p, i) => mad(p, at[i]!)),
      other: prev.map((p, i) => frames.map((_: number, j: number) => (i === j ? -1 : mad(p, at[j]!)))),
      topBand: Math.min(...at.map(band)),
      previewTopBand: Math.min(...prev.map(band)),
    };
    if (dump) {
      const png = async (rgba: ArrayLike<number>, w: number, hgt: number): Promise<string> => {
        const c = new OffscreenCanvas(w, hgt);
        c.getContext("2d")!.putImageData(new ImageData(Uint8ClampedArray.from(rgba), w, hgt), 0, 0);
        return b64(new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer()));
      };
      out.dump = [];
      for (const [i, f] of frames.entries()) out.dump.push({ preview: await png(shots[i]!.data, shots[i]!.width, shots[i]!.height), export: await png(decoded[f]!.rgba, decoded[f]!.width, decoded[f]!.height) });
    }
    await res.remove();
    return out;
  }, { shots, bytes, frames: FRAMES, TICKS, dump: !!DUMP });
  if (DUMP) {
    for (const [i, d] of (r.dump ?? []).entries()) {
      writeFileSync(`${DUMP}/preview-${FRAMES[i]}.png`, Buffer.from(d.preview, "base64"));
      writeFileSync(`${DUMP}/export-${FRAMES[i]}.png`, Buffer.from(d.export, "base64"));
    }
    writeFileSync(`${DUMP}/export.webm`, Buffer.from(await page.evaluate(() => (window as unknown as { __file: string }).__file), "base64"));
  }
  delete r.dump;
  console.log("export parity:", JSON.stringify(r));

  // The length is exact: 15 frames at 30 fps = 0.5 s, in the plan, in the file's packets and in the last frame's time.
  expect(r.stats).toEqual({ frames: 15, durationSeconds: 0.5 });
  expect(r.videoPackets).toBe(15);
  expect(Math.abs(r.lastPtsTicks - 14 * r.frameTicks)).toBeLessThanOrEqual(TICKS / 1000); // WebM stamps whole milliseconds
  expect(r.size).toEqual([360, 640]);
  // Same picture: the export at each timestamp is the preview at that timestamp ...
  for (const [i, d] of r.same.entries()) expect(d, `frame ${FRAMES[i]}: mean difference preview vs export`).toBeLessThan(6);
  // ... and clearly not the preview at another one (the overlay moved, the picture changed), so the check can tell frames apart.
  for (const [i, row] of r.other.entries()) for (const [j, d] of row.entries()) if (i !== j) expect(d, `preview ${FRAMES[i]} vs export ${FRAMES[j]}`).toBeGreaterThan(2 * r.same[i]! + 2);
  // The blurred background is in the file, not just on screen.
  expect(r.topBand).toBeGreaterThan(20);
  expect(r.previewTopBand).toBeGreaterThan(20);
  expect(errors).toEqual([]);
});
