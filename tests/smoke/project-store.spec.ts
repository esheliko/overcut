import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * M1-024: bin, timeline and preview share ONE project. Import -> bin + timeline + preview show it -> trim -> play 1 s -> undo the trim:
 * every panel is back in step, without a restart of the player. Needs a build with the engine.
 */
const FLASH = resolve("crates/media/tests/fixtures/flash_click.mp4"); // 3 s, 30 fps, picture + sound
type Hook = { player: { endFrame: number; frame: number; isPlaying: boolean }; media(): unknown[] };
const hook = (page: Page) => page.evaluate(() => { const h = (window as unknown as { __overcutPreview: Hook }).__overcutPreview; return { end: h.player.endFrame, frame: h.player.frame, media: h.media().length }; });

test("import, trim, play 1 s, undo the trim: bin, timeline and preview stay consistent", async ({ page }, info) => {
  const phone = info.project.name === "phone";
  await page.goto("/");
  await expect(page.getByTestId("engine")).toContainText(/\(wasm\)/, { timeout: 30_000 });
  const summary = page.locator("#tl-summary");
  const total = page.getByTestId("timecode");
  await expect(page.getByTestId("preview-import")).toBeEnabled({ timeout: 20_000 }); // empty project: the preview offers the bin's import too
  if (phone) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click();

  // Import: appears in the bin and on the timeline, and the preview plays that same project (no separate "open a clip").
  await page.getByTestId("media-input").setInputFiles(FLASH);
  await expect(page.getByTestId("bin-item")).toHaveCount(1);
  await expect(summary).toContainText("2 tracks, 2 clips");
  await expect(summary).toContainText("3 seconds");
  await expect(page.locator(".canvas")).toHaveAttribute("data-loaded", "true");
  await expect(total).toContainText("/ 00:00:03:00");
  await expect.poll(async () => (await hook(page)).media, { timeout: 20_000 }).toBeGreaterThan(0);
  expect((await hook(page)).end).toBe(90);
  if (phone) await page.getByRole("button", { name: "Close panel" }).click();

  // Trim both clips to 1 s: playhead at 1 s (ruler), trim the end to the playhead.
  const box = (await page.getByTestId("timeline-canvas").boundingBox())!;
  const tap = (x: number, y: number) => (phone ? page.touchscreen.tap(box.x + x, box.y + y) : page.mouse.click(box.x + x, box.y + y));
  await tap(88, 10); // 48 px gutter + 40 px/s = 1.000 s
  await expect(page.getByRole("slider", { name: "Playhead position" })).toHaveAttribute("aria-valuenow", "30");
  await tap(68, 30 + 26); // the picture clip (a trim needs exactly one clip selected)
  await page.keyboard.press("BracketRight");
  await tap(68, 30 + 52 + 26); // the sound clip
  await page.keyboard.press("BracketRight");
  await expect(total).toContainText("/ 00:00:01:00"); // the player's length followed the edit
  await expect(summary).toContainText("1 second of media");
  await expect.poll(async () => (await hook(page)).end).toBe(30);

  // Play from the start for about a second.
  await page.keyboard.press("Home");
  await page.keyboard.press("Space");
  await expect.poll(async () => (await hook(page)).frame, { timeout: 5000 }).toBeGreaterThan(5);
  await page.waitForTimeout(1100);
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible(); // reached the end and stopped

  // Undo both trims from the timeline: the bin still has its one card, the timeline and the player are 3 s again.
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(total).toContainText("/ 00:00:03:00");
  await expect.poll(async () => (await hook(page)).end).toBe(90);
  await expect(summary).toContainText("2 tracks, 2 clips");
  await expect(summary).toContainText("3 seconds");
  await expect(page.getByTestId("bin-item")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

  // Undo the import itself: the bin card, the clips and the preview all go (empty project shows the import target again).
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(summary).toContainText("0 clips");
  await expect(page.locator(".canvas")).toHaveAttribute("data-loaded", "false");
  await expect(page.getByTestId("preview-import")).toBeVisible();
  const openBin = async () => { if (phone) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click(); };
  await openBin();
  await expect(page.getByTestId("bin-item")).toHaveCount(0);
  if (phone) await page.getByRole("button", { name: "Close panel" }).click();
  // ...and redo brings the card back whole.
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(summary).toContainText("2 clips");
  await openBin();
  await expect(page.getByTestId("bin-item")).toHaveCount(1);
  await expect(page.getByTestId("bin-item").first()).toContainText("flash_click.mp4");
  await expect(page.getByTestId("bin-item").first().locator("img")).toHaveCount(1); // the poster came back too
});
