import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * M1-033: the preview plays a real clip. Headless Chromium (software decode, SwiftShader GL, a fake audio sink): the numbers are
 * REPORTED, not representative of a device; the asserts are loose correctness bounds. A/V offset is measured against the audio clock
 * (the click in the fixture and the flash frame sit at the same instant, 1.000 s): it shows video is not drifting from the master
 * clock, it is not an acoustic loopback measurement.
 */
const FIX = resolve("crates/media/tests/fixtures");
const TICKS = 705_600_000;

async function openClip(page: Page, name: string) {
  await page.goto("/");
  await expect(page.getByTestId("engine")).toContainText(/\(wasm\)/, { timeout: 30_000 });
  await expect(page.getByTestId("preview-import")).toBeEnabled({ timeout: 20_000 }); // empty project: the preview offers the same import as the bin
  await page.getByTestId("preview-input").setInputFiles(`${FIX}/${name}`);
  await expect(page.locator(".canvas")).toHaveAttribute("data-loaded", "true", { timeout: 20_000 });
  // The decoder for the imported file is open (the player plays the shared project, there is no separate "open a clip").
  await expect.poll(() => page.evaluate(async () => (await (window as unknown as { __overcutPreview?: { media(): Promise<unknown[]> } }).__overcutPreview?.media())?.length ?? 0), { timeout: 20_000 }).toBeGreaterThan(0);
}

test("a portrait phone clip shows upright (display rotation applied) and the preview takes its aspect", async ({ page }) => {
  await openClip(page, "rotated90.mp4"); // coded 160x120, display rotation 90 -> 120x160
  await expect.poll(async () => { const b = (await page.locator(".canvas").boundingBox())!; return b.height > b.width; }).toBe(true);
  await expect(page.getByTestId("timecode")).toContainText("00:00:00:00");
  // Frame 0 is on the canvas (not black) and the canvas is not stretched: backing aspect equals the display aspect.
  await expect.poll(async () => { const b = (await page.getByTestId("preview-canvas").boundingBox())!; return Math.abs(b.width / b.height - 0.75); }).toBeLessThan(0.02); // layout transition done
  await page.waitForTimeout(150);
  // The canvas belongs to the preview Worker: its backing size and pixels are asked of the Worker.
  const px = await page.evaluate(async () => {
    const h = (window as unknown as { __overcutPreview: { gpu(): Promise<{ canvas: { width: number; height: number } }>; probe(x: number, y: number): Promise<number[]> } }).__overcutPreview;
    const { canvas } = await h.gpu();
    return { aspect: canvas.width / canvas.height, mid: await h.probe(canvas.width >> 1, canvas.height >> 1) };
  });
  expect(Math.abs(px.aspect - 120 / 160)).toBeLessThan(0.02);
  expect(Math.max(...px.mid)).toBeGreaterThan(20);
});

test("play 2 s, pause, frame-step; numbers reported", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "playback numbers do not depend on the viewport");
  test.setTimeout(90_000);
  await openClip(page, "flash_click.mp4");
  type Hook = { player: { isPlaying: boolean; frame: number; seek(f: number): void }; stats(): Promise<{ presented: number; dropped: number; stalls: number; maxLateMs: number; late: number[]; scrubMs: number[]; times: number[]; marks: [number, number][] }>; probe(x: number, y: number): Promise<number[]>; gpu(): Promise<{ info: { backend: string; accum: string }; canvas: { width: number; height: number } }> };
  const t0 = Date.now();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await page.waitForTimeout(2000);
  await page.keyboard.press("Space");
  const wall = (Date.now() - t0) / 1000;
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  const r = await page.evaluate(async () => {
    const h = (window as unknown as { __overcutPreview: Hook }).__overcutPreview;
    const s = await h.stats();
    const mark = s.marks.find((m) => m[0] >= 30); // the white frame, or the first one drawn after it if the machine was busy and dropped it
    const t = s.times;
    const span = t.length > 1 ? t[t.length - 1]! - t[0]! : 0;
    const late = [...s.late].sort((a, b) => a - b);
    return { presented: s.presented, dropped: s.dropped, stalls: s.stalls, maxLateMs: s.maxLateMs, p95LateMs: late[Math.floor(late.length * 0.95)] ?? 0, fps: span ? (t.length - 1) / span : 0, flash: mark ? mark[1] - (mark[0] - 30) * (705_600_000 / 30) : null, frame: h.player.frame };
  });
  const offsetMs = r.flash === null ? null : (r.flash - TICKS) / (TICKS / 1000);
  expect(await page.getByTestId("preview-problem").allTextContents()).toEqual([]);
  console.log("preview playback (headless, software decode and GL, fake audio sink; 320x180):", JSON.stringify({ ...r, wallS: wall, avOffsetMs: offsetMs }));
  expect(r.presented).toBeGreaterThan(30);
  expect(r.flash, "the white frame at 1.000 s was drawn").not.toBeNull();
  // ... and it is the white frame: frame 30 on the canvas is white, frame 29 is not (pixels read back from the Worker's canvas).
  const white = async (f: number) => page.evaluate(async (f) => {
    const h = (window as unknown as { __overcutPreview: Hook }).__overcutPreview;
    h.player.seek(f);
    for (let i = 0; i < 40; i++) {
      await new Promise((res) => setTimeout(res, 50));
      const { canvas } = await h.gpu();
      const px = await h.probe(canvas.width >> 1, canvas.height >> 1);
      if (h.player.frame === f && !h.player.isPlaying) return px[0]!;
    }
    return -1;
  }, f);
  expect(await white(30)).toBeGreaterThan(200);
  expect(await white(29)).toBeLessThan(200);
  expect(Math.abs(offsetMs!)).toBeLessThan(150);
  expect(r.frame).toBeGreaterThan(45); // ~2 s at 30 fps, minus start-up
  // Frame step moves exactly one frame, forward and back.
  const tc = page.getByTestId("timecode");
  const before = await page.evaluate(() => (window as unknown as { __overcutPreview: Hook }).__overcutPreview.player.frame);
  await page.keyboard.press(".");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __overcutPreview: Hook }).__overcutPreview.player.frame)).toBe(before + 1);
  await page.keyboard.press(",");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __overcutPreview: Hook }).__overcutPreview.player.frame)).toBe(before);
  await page.keyboard.press("Home");
  await expect(tc).toContainText("00:00:00:00");
  // Scrub latency: 40 random seeks.
  const scrub = await page.evaluate(async () => {
    const h = (window as unknown as { __overcutPreview: Hook }).__overcutPreview;
    const n0 = (await h.stats()).scrubMs.length;
    for (let i = 0; i < 40; i++) { h.player.seek((i * 37) % 85); await new Promise((r) => setTimeout(r, 40)); }
    await new Promise((r) => setTimeout(r, 300));
    const a = (await h.stats()).scrubMs.slice(n0).sort((x, y) => x - y);
    return { n: a.length, p50: a[a.length >> 1] ?? 0, p95: a[Math.floor(a.length * 0.95)] ?? 0 };
  });
  console.log("scrub latency ms (headless, 320x180, GOP 30):", JSON.stringify(scrub));
  expect(scrub.n).toBeGreaterThan(10);
});

test("JKL shuttle: L doubles the speed, K stops", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "keyboard behaviour");
  await openClip(page, "flash_click.mp4");
  await page.keyboard.press("l");
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await page.keyboard.press("l");
  await expect(page.locator(".rate-badge")).toHaveText("2×");
  await page.keyboard.press("k");
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  const open = await page.evaluate(async () => (await (window as unknown as { __overcutPreview: { media(): Promise<{ open: number }[]> } }).__overcutPreview.media())[0]!.open);
  expect(open).toBeLessThanOrEqual(2); // no leaked VideoFrames after stopping (at most the frame on the compositor path)
});

type Parity = { width: number; height: number; layers: number; previewVsReadback: number; previewVsCanvasCapture: number; lit: boolean; error?: string };
type RenderHook = { parity(frame: number): Promise<Parity>; gpu(): Promise<{ info: { backend: string; accum: string; adapter: string }; alloc: { textures: number; buffers: number; bind_groups: number } }>; stats(): Promise<{ scrubMs: number[] }>; player: { seek(f: number): void; frame: number } };

// M1-023: one compositor. The frame the preview presents on its canvas and the frame the exporter hands the encoder (GPU readback, and the canvas
// snapshot mode) come from the same Rust compositor and must be the same pixels. Golden tolerance of the render crate: 3/255 per channel.
// [frame, the picture is bright enough to see]
for (const [clip, frames] of [["rotated90.mp4", [[0, true], [20, true]]], ["flash_click.mp4", [[29, false], [30, true], [45, false]]]] as const) {
  test(`preview and export render the same pixels (${clip})`, async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "pixel parity does not depend on the viewport");
    await openClip(page, clip);
    for (const [f, lit] of frames) {
      const r = await page.evaluate((f) => (window as unknown as { __overcutPreview: RenderHook }).__overcutPreview.parity(f), f);
      expect(r.error, `parity(${f})`).toBeUndefined();
      console.log(`parity ${clip} frame ${f}:`, JSON.stringify(r));
      expect(r.layers).toBe(1);
      if (lit) expect(r.lit, "the compositor drew the picture").toBe(true);
      expect(r.previewVsReadback).toBeLessThanOrEqual(3);
      expect(r.previewVsCanvasCapture).toBeLessThanOrEqual(3);
    }
  });
}

test("the compositor reports its backend and allocates nothing while scrubbing", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "backend and allocation do not depend on the viewport");
  await openClip(page, "flash_click.mp4");
  const hook = () => page.evaluate(async () => (window as unknown as { __overcutPreview: RenderHook }).__overcutPreview.gpu());
  const first = await hook();
  expect(["webgpu", "webgl2"]).toContain(first.info.backend);
  console.log("compositor:", JSON.stringify(first.info));
  await page.waitForTimeout(1000); // the stage layout settles (each canvas resize rebuilds the targets, once)
  const before = (await hook()).alloc;
  await page.evaluate(async () => {
    const h = (window as unknown as { __overcutPreview: RenderHook }).__overcutPreview;
    for (let i = 0; i < 30; i++) { h.player.seek((i * 7) % 80); await new Promise((r) => setTimeout(r, 40)); }
    await new Promise((r) => setTimeout(r, 300));
  });
  expect((await hook()).alloc, "no GPU object is created per frame").toEqual(before);
});

test("the upload path is chosen by a micro-benchmark, and a frame step after a scrub is served from the decode-ahead cache", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "scrub timing does not depend on the viewport");
  test.setTimeout(90_000);
  await openClip(page, "flash_click.mp4");
  type Hook = { player: { seek(f: number): void }; stats(): Promise<{ scrubMs: number[]; firstUpdateMs: number[]; cacheHits: number; cached: number }>; gpu(): Promise<{ info: { backend: string }; upload?: { path: string; source: string; ms: Record<string, number> } }> };
  const stats = () => page.evaluate(() => (window as unknown as { __overcutPreview: Hook }).__overcutPreview.stats());
  await page.evaluate(() => (window as unknown as { __overcutPreview: Hook }).__overcutPreview.player.seek(20));
  await expect.poll(async () => (await stats()).scrubMs.length, { timeout: 20_000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await stats()).cached, { timeout: 20_000 }).toBeGreaterThanOrEqual(3); // decode-ahead around frame 20
  await page.evaluate(() => (window as unknown as { __overcutPreview: Hook }).__overcutPreview.player.seek(21));
  await expect.poll(async () => (await stats()).cacheHits, { timeout: 10_000 }).toBeGreaterThan(0);
  const s = await stats();
  expect(s.firstUpdateMs.length).toBe(s.scrubMs.length); // every scrub has both numbers
  const g = await page.evaluate(() => (window as unknown as { __overcutPreview: Hook }).__overcutPreview.gpu());
  expect(["frame", "cpu"]).toContain(g.upload?.path);
  if (g.upload?.source === "measured") {
    const stored = await page.evaluate(() => localStorage.getItem("overcut.uploadPath"));
    expect(stored).toContain(g.upload.path);
  }
  console.log(`[upload] ${g.info.backend}: ${JSON.stringify(g.upload)}; scrub first update ${s.firstUpdateMs.map((x) => x.toFixed(1)).join("/")} ms, exact ${s.scrubMs.map((x) => x.toFixed(1)).join("/")} ms`);
});
