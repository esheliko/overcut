import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * Smooth scrubbing (docs/features/preview.md): a long-GOP clip (1280x720, one keyframe per 150 frames) seeks slowly; after the Worker has measured that, it builds a
 * strip of small JPEG stand-ins in the background (status chip while it works), and later scrubs show the exact frame's stand-in at once, then the exact frame.
 * Numbers are REPORTED (headless Chromium, software decode): not representative of a device.
 */
const CLIP = resolve("tests/fixtures/longgop.mp4");
const FRAMES = 300;

type Hook = {
  player: { seek(f: number): void };
  stats(): Promise<{ scrubMs: number[]; firstUpdateMs: number[]; stripStandIns: number; standIns: number; standInOff: number[] }>;
  strip(): Promise<{ enabled: boolean; bytes: number; served: number; media: { id: string; state: string; reason?: string; done: number; frames: number; measuredP95?: number }[] }>;
  probe(x: number, y: number): Promise<number[]>;
  gpu(): Promise<{ canvas: { width: number; height: number } }>;
};

async function openClip(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect(page.getByTestId("preview-import")).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId("preview-input").setInputFiles(CLIP);
  await expect(page.locator(".canvas")).toHaveAttribute("data-loaded", "true", { timeout: 20_000 });
  await expect.poll(() => page.evaluate(async () => (await (window as unknown as { __overcutPreview: { media(): Promise<unknown[]> } }).__overcutPreview.media()).length), { timeout: 20_000 }).toBeGreaterThan(0);
}

/** 40 seeded random seeks, each waiting for its exact frame: p50 / p95 of the first visible update and of the exact frame (ms). */
async function randomSeeks(page: Page) {
  return page.evaluate(async (frames) => {
    const h = (window as unknown as { __overcutPreview: Hook }).__overcutPreview;
    let seed = 12345;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    const before = await h.stats();
    const n0 = before.scrubMs.length;
    for (let i = 0; i < 40; i++) {
      const want = n0 + i + 1;
      h.player.seek(Math.floor(rnd() * (frames - 1)) + 1);
      const until = performance.now() + 10_000;
      while ((await h.stats()).scrubMs.length < want && performance.now() < until) await new Promise((r) => setTimeout(r, 4));
    }
    const s = await h.stats();
    const pct = (a: number[], p: number) => { const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * b.length))]!; };
    const first = s.firstUpdateMs.slice(before.firstUpdateMs.length);
    const exact = s.scrubMs.slice(n0);
    const off = s.standInOff.slice(before.standInOff.length);
    return { n: exact.length, off: [pct(off, 0.5), pct(off, 0.95)], first: [pct(first, 0.5), pct(first, 0.95)], exact: [pct(exact, 0.5), pct(exact, 0.95)], stripStandIns: s.stripStandIns - before.stripStandIns };
  }, FRAMES);
}

test("a long-GOP clip gets a background scrub strip, then scrubs show a stand-in at once and refine to the exact frame", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "scrub numbers do not depend on the viewport");
  test.setTimeout(180_000);
  // Start with the setting OFF (the "before" run), then turn it on in the same page.
  await page.addInitScript(() => { try { if (!sessionStorage.getItem("seen")) { localStorage.setItem("overcut.scrubPrep", "off"); sessionStorage.setItem("seen", "1"); } } catch { /* ignore */ } });
  await openClip(page);
  const before = await randomSeeks(page);
  expect((await page.evaluate(() => (window as unknown as { __overcutPreview: Hook }).__overcutPreview.strip())).media[0]?.state).not.toBe("building");
  expect(before.stripStandIns).toBe(0);

  // Record whether the status chip ever shows, with its text.
  await page.evaluate(() => {
    const w = window as unknown as { __chip: string[] };
    w.__chip = [];
    new MutationObserver(() => { const el = document.querySelector('[data-testid="scrub-prep"]'); if (el?.textContent) w.__chip.push(el.textContent); }).observe(document.body, { subtree: true, childList: true, characterData: true });
    localStorage.removeItem("overcut.scrubPrep");
    window.dispatchEvent(new Event("overcut:scrub-prep"));
  });
  await expect.poll(() => page.evaluate(async () => (await (window as unknown as { __overcutPreview: Hook }).__overcutPreview.strip()).media[0]?.state), { timeout: 120_000, intervals: [250] }).toBe("ready");
  const chip = await page.evaluate(() => (window as unknown as { __chip: string[] }).__chip);
  // r15: the progress is a quiet ring in the player bar that appears only after ~0.9 s, so a fast build may finish before it shows; when it shows, it names the progress.
  for (const c of chip) expect(c).toMatch(/^Preparing smooth scrubbing… \d+%$/);
  await expect(page.getByTestId("scrub-prep")).toHaveCount(0); // gone when done
  const built = await page.evaluate(() => (window as unknown as { __overcutPreview: Hook }).__overcutPreview.strip());
  expect(built.media[0]!.done).toBeGreaterThan(0);
  expect(built.bytes).toBeGreaterThan(0);

  const after = await randomSeeks(page);
  const line = `scrub strip, long-GOP 1280x720 (container, headless Chromium, software decode: NOT representative of a device), 40 seeded random seeks, ms p50/p95: first picture off by ${before.off.join('/')} -> ${after.off.join('/')} frames, shown after ${before.first.map((v) => v.toFixed(1)).join("/")} -> ${after.first.map((v) => v.toFixed(1)).join("/")}; exact frame ${before.exact.map((v) => v.toFixed(1)).join("/")} -> ${after.exact.map((v) => v.toFixed(1)).join("/")}; strip ${(built.bytes / 1024).toFixed(0)} KiB for ${FRAMES} frames`;
  console.log(line);
  info.annotations.push({ type: "numbers", description: line });
  expect(after.stripStandIns).toBeGreaterThanOrEqual(30); // nearly every seek showed a strip picture first (a few were cache hits)
  // The first picture is the strip's, well inside the 120 ms budget, while the exact frame still takes as long as before.
  expect(after.first[1]).toBeLessThan(120);
  expect(after.off[1]).toBeLessThanOrEqual(1); // within one frame of the one asked for (stride 2); thumbnails are as far off as their spacing
  expect(after.off[1]).toBeLessThanOrEqual(before.off[1]!);
  // And the exact frame replaced it: the canvas shows the clip (not black) once the last seek settled.
  const px = await page.evaluate(async () => { const h = (window as unknown as { __overcutPreview: Hook }).__overcutPreview; const { canvas } = await h.gpu(); return h.probe(canvas.width >> 1, canvas.height >> 1); });
  expect(Math.max(...px)).toBeGreaterThan(20);
});

test("the menu turns smooth scrubbing off and on", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await page.locator(".menu .icon-btn").first().click();
  const item = page.getByTestId("menu-scrub-prep");
  await expect(item).toHaveAttribute("aria-checked", "true");
  await item.click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("overcut.scrubPrep"))).toBe("off");
  await expect(item).toHaveAttribute("aria-checked", "false");
});
