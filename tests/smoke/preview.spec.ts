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
  await expect(page.getByTestId("preview-open")).toBeEnabled({ timeout: 20_000 }); // startup project is open
  await page.getByTestId("preview-file").setInputFiles(`${FIX}/${name}`);
  await expect(page.locator(".canvas")).toHaveAttribute("data-loaded", "true", { timeout: 20_000 });
}

test("a portrait phone clip shows upright (display rotation applied) and the preview takes its aspect", async ({ page }) => {
  await openClip(page, "rotated90.mp4"); // coded 160x120, display rotation 90 -> 120x160
  await expect.poll(async () => { const b = (await page.locator(".canvas").boundingBox())!; return b.height > b.width; }).toBe(true);
  await expect(page.getByTestId("timecode")).toContainText("00:00:00:00");
  // Frame 0 is on the canvas (not black) and the canvas is not stretched: backing aspect equals the display aspect.
  await expect.poll(async () => { const b = (await page.getByTestId("preview-canvas").boundingBox())!; return Math.abs(b.width / b.height - 0.75); }).toBeLessThan(0.02); // layout transition done
  await page.waitForTimeout(150);
  const px = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>("[data-testid=preview-canvas]")!;
    const h = (window as unknown as { __overcutPreview: { probe(x: number, y: number): number[] } }).__overcutPreview;
    return { aspect: c.width / c.height, mid: h.probe(c.width >> 1, c.height >> 1) };
  });
  expect(Math.abs(px.aspect - 120 / 160)).toBeLessThan(0.02);
  expect(Math.max(...px.mid)).toBeGreaterThan(20);
});

test("play 2 s, pause, frame-step; numbers reported", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "playback numbers do not depend on the viewport");
  test.setTimeout(90_000);
  await openClip(page, "flash_click.mp4");
  type Hook = { player: { isPlaying: boolean; position(): number; frame: number; seek(f: number): void }; stats(): { presented: number; dropped: number; stalls: number; maxLateMs: number; late: number[]; scrubMs: number[]; times: number[] }; probe(x: number, y: number): number[] };
  // Watch the canvas for the white frame and record the audio-clock position at that instant.
  await page.evaluate(() => {
    const h = (window as unknown as { __overcutPreview: Hook }).__overcutPreview;
    const c = document.querySelector<HTMLCanvasElement>("[data-testid=preview-canvas]")!;
    const w = window as unknown as { __flash?: number };
    const loop = () => {
      if (w.__flash !== undefined) return; // found: stop reading pixels back (a GPU stall per frame)
      if (h.player.isPlaying && h.player.position() > 0.9 * 705_600_000 && h.probe(c.width >> 1, c.height >> 1)[0]! > 200) w.__flash = h.player.position();
      requestAnimationFrame(loop);
    };
    loop();
  });
  const t0 = Date.now();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await page.waitForTimeout(2000);
  await page.keyboard.press("Space");
  const wall = (Date.now() - t0) / 1000;
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  const r = await page.evaluate(() => {
    const h = (window as unknown as { __overcutPreview: Hook }).__overcutPreview;
    const s = h.stats();
    const t = s.times;
    const span = t.length > 1 ? t[t.length - 1]! - t[0]! : 0;
    const late = [...s.late].sort((a, b) => a - b);
    return { presented: s.presented, dropped: s.dropped, stalls: s.stalls, maxLateMs: s.maxLateMs, p95LateMs: late[Math.floor(late.length * 0.95)] ?? 0, fps: span ? (t.length - 1) / span : 0, flash: (window as unknown as { __flash?: number }).__flash ?? null, frame: h.player.frame };
  });
  const offsetMs = r.flash === null ? null : (r.flash - TICKS) / (TICKS / 1000);
  expect(await page.getByTestId("preview-problem").allTextContents()).toEqual([]);
  console.log("preview playback (headless, software decode and GL, fake audio sink; 320x180):", JSON.stringify({ ...r, wallS: wall, avOffsetMs: offsetMs }));
  expect(r.presented).toBeGreaterThan(30);
  expect(r.flash, "the white frame at 1.000 s was drawn").not.toBeNull();
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
    const n0 = h.stats().scrubMs.length;
    for (let i = 0; i < 40; i++) { h.player.seek((i * 37) % 85); await new Promise((r) => setTimeout(r, 40)); }
    await new Promise((r) => setTimeout(r, 300));
    const a = h.stats().scrubMs.slice(n0).sort((x, y) => x - y);
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
  const open = await page.evaluate(() => (window as unknown as { __overcutPreview: { media(): { stats(): { open: number } }[] } }).__overcutPreview.media()[0]!.stats().open);
  expect(open).toBeLessThanOrEqual(2); // no leaked VideoFrames after stopping (at most the frame on the compositor path)
});
