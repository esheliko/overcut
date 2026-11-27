import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { gutterShift } from "./timeline-geometry";

/** M1-044 automated proxy for the activation test (docs/ACTIVATION-TEST.md): the whole first-time journey (import, trim off the start, export, save)
 *  driven the way a newcomer would, through visible labelled controls only. It counts the clicks/taps (fewer is better) and bounds the wall time.
 *  A person's 90 s is not measured here; this catches a journey that grew steps, dead ends or slowness. Needs a build with the engine. */
const CLIP = resolve("crates/media/tests/fixtures/flash_click.mp4"); // 3 s, 30 fps, picture + sound
const MAX_CLICKS = 9; // 8 on desktop (import, ruler, Split, select, Delete, Export, Export, Save) + the Media tab on a phone
const BUDGET_MS = 60_000;

test("first-time journey: import, cut the start off, export, save", async ({ page }, info) => {
  test.setTimeout(120_000);
  const phone = info.project.name === "phone";
  let clicks = 0;
  const hit = async (act: () => Promise<unknown>) => { clicks++; await act(); };
  const button = (name: string | RegExp) => page.getByRole("button", { name });
  const nav = page.getByRole("navigation", { name: "Tools" });
  // Headless Chromium has no native open/save dialogs: without the handle pickers the app uses the plain file input (a file chooser) and a download, the paths we can drive.
  await page.addInitScript(() => { const w = window as unknown as Record<string, unknown>; delete w.showSaveFilePicker; delete w.showOpenFilePicker; });
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  const started = Date.now(); // the clock starts when the app is ready: engine download is the network's, not the journey's

  // 1. Import: on a phone the Media sheet is a tab, on desktop it is already open.
  if (phone) await hit(() => nav.getByRole("button", { name: "Media" }).click());
  const chooser = page.waitForEvent("filechooser");
  await hit(() => button(/^Import media$/).first().click());
  await (await chooser).setFiles(CLIP);
  await expect(page.locator("#tl-summary")).toContainText("1 clip", { timeout: 30_000 });

  // 2. Trim: put the playhead 1 s in (click the ruler), Split, then select the first part and Delete it: the picture and its sound are linked, so ONE select and ONE Delete cover both.
  const canvas = page.getByTestId("timeline-canvas");
  const box = (await canvas.boundingBox())!;
  // The timeline fits itself to the new clips right after an import (a frame or two later): read the zoom once it has settled.
  let pps = 0;
  await expect.poll(async () => { const a = Number(await canvas.getAttribute("data-pps")); await page.waitForTimeout(150); const b = Number(await canvas.getAttribute("data-pps")); pps = b; return a === b && b > 0; }).toBe(true);
  const gutter = 48 + (await gutterShift(page)), ruler = 30, lane = 52;
  const at = (sec: number, row: number) => ({ x: box.x + gutter + sec * pps, y: box.y + ruler + lane * (row + 0.5) });
  const pointer = async (p: { x: number; y: number }) => (phone ? page.touchscreen.tap(p.x, p.y) : page.mouse.click(p.x, p.y));
  await hit(() => pointer({ x: box.x + gutter + 1 * pps, y: box.y + ruler / 2 }));
  await hit(() => button("Split at playhead").click());
  await expect(page.locator("#tl-summary")).toContainText("2 clips");
  await hit(() => pointer(at(0.5, 0)));
  await expect(page.getByTestId("tl-selected")).toHaveText("1 clip + linked audio"); // one click is one clip; its sound came along
  await hit(() => button("Delete").and(page.locator('[title^="Delete"]')).click());
  await expect(page.locator("#tl-summary")).toContainText("1 clip");
  await expect(page.locator("#tl-summary")).toContainText("2 seconds"); // 3 s minus the 1 s cut off the front, and no empty stretch left in front

  // 3. Export with the defaults, then save.
  await hit(() => page.getByTestId("export-open").click());
  await hit(() => page.getByTestId("export-dialog").getByRole("button", { name: /^Export$/ }).click());
  const done = page.getByTestId("export-done");
  await expect(done).toBeVisible({ timeout: 60_000 });
  await expect(done).toContainText("0:02");
  const download = page.waitForEvent("download");
  await hit(() => button("Save").click());
  expect((await download).suggestedFilename()).toMatch(/\.(mp4|webm)$/);

  const ms = Date.now() - started;
  info.annotations.push({ type: "journey", description: `${clicks} clicks/taps, ${(ms / 1000).toFixed(1)} s scripted` });
  console.log(`activation journey (${info.project.name}): ${clicks} clicks/taps, ${(ms / 1000).toFixed(1)} s scripted`);
  expect(clicks).toBeLessThanOrEqual(MAX_CLICKS);
  expect(ms).toBeLessThan(BUDGET_MS);
});
