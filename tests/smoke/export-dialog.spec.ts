import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

/** M1-035: import -> Export (the default) -> completes -> the file is saved. Phone (full-screen sheet) and desktop (modal). Needs a build with the engine. */
const FIX = resolve("crates/media/tests/fixtures");

async function ready(page: Page) {
  // No save picker in headless Chromium (it opens a native dialog nobody can answer): the download path is the one under test; the picker path is a unit test.
  await page.addInitScript(() => { delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker; });
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  if ((page.viewportSize()?.width ?? 0) < 720) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click();
  await page.getByTestId("media-input").setInputFiles(resolve(FIX, "vp9_opus.webm"));
  await expect(page.locator("#tl-summary")).toContainText("1 clip", { timeout: 30_000 });
}

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("Export is disabled until there is something to export", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect(page.getByTestId("export-open")).toBeDisabled();
});

test("one click on Export (the smart default) makes a file and saves it", async ({ page }) => {
  test.setTimeout(120_000);
  await ready(page);
  const open = page.getByTestId("export-open");
  await expect(open).toBeEnabled();
  expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(36);
  await open.click();
  const dialog = page.getByTestId("export-dialog");
  await expect(dialog).toBeVisible();
  // presets are big tappable chips; the default is the project's own size
  const chips = page.locator(".export-chip-choice");
  await expect(chips).toHaveCount(8);
  for (const c of await chips.all()) expect((await c.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByTestId("export-preset-original")).toBeChecked();
  await expect(page.getByTestId("export-estimate")).toContainText(/About .* (MB|KB)/);
  // R11: a tile's hint says what the preset does (size cap, black bars): it wraps, it is never cut off by an ellipsis.
  const cut = await page.locator(".ex-tx span").evaluateAll((els) => els.filter((e) => e.scrollHeight > e.clientHeight + 1 || getComputedStyle(e).whiteSpace === "nowrap").map((e) => e.textContent));
  expect(cut).toEqual([]);
  expect(await noOverflow(page)).toBeLessThanOrEqual(0);
  const box = (await dialog.boundingBox())!;
  if ((page.viewportSize()?.width ?? 0) < 720) expect(box.width).toBeGreaterThanOrEqual(page.viewportSize()!.width - 1); // full-screen sheet
  else expect(box.width).toBeLessThan(700); // modal

  await page.getByTestId("export-go").click();
  await expect(page.getByTestId("export-done")).toBeVisible({ timeout: 90_000 });
  expect(Number((await page.getByTestId("export-filesize").innerText()).replace(/[^\d.]/g, ""))).toBeGreaterThan(0);
  await expect(page.getByTestId("export-filename")).toHaveText(/\.(mp4|webm)$/);
  expect((await page.getByTestId("export-filename").boundingBox())!.height).toBeLessThan(30); // R11: the file name is one line, not broken mid-date
  expect(await noOverflow(page)).toBeLessThanOrEqual(0);

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-save").click()]);
  expect(download.suggestedFilename()).toMatch(/\.(mp4|webm)$/);
  const path = await download.path();
  expect(path).toBeTruthy();
  const { size } = await import("node:fs").then((fs) => fs.statSync(path!));
  expect(size).toBeGreaterThan(1000);
  await expect(page.getByTestId("export-note")).toContainText("Downloaded");
  await page.getByTestId("export-done-close").click();
  await expect(dialog).toBeHidden();
});

test("a chosen preset is remembered, and Advanced shows a live size", async ({ page }) => {
  test.setTimeout(120_000);
  await ready(page);
  await page.getByTestId("export-open").click();
  const est = page.getByTestId("export-estimate");
  await page.getByTestId("export-preset-small").check({ force: true });
  await expect(page.getByTestId("export-preset-small")).toBeChecked();
  await page.getByText("Advanced").click();
  await expect(page.getByTestId("export-quality")).toBeVisible();
  await page.getByTestId("export-quality").selectOption("low"); // the 160x120 fixture is at the minimum bitrate, so the figure cannot move here; scaling is a unit test
  await expect(est).toContainText(/About .* (MB|KB)/);
  await expect(page.getByTestId("export-preset-small")).not.toBeChecked(); // an Advanced change makes it a custom choice
  await page.getByTestId("export-preset-small").check({ force: true }); // picking the chip again resets Advanced to the preset
  await expect(page.getByTestId("export-quality")).toHaveValue("medium");
  await expect(page.getByTestId("export-go")).toBeEnabled();
  await page.getByTestId("export-go").click();
  await expect(page.getByTestId("export-done")).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("export-done-close").click();
  await page.getByTestId("export-open").click();
  await expect(page.getByTestId("export-dialog")).toHaveAttribute("data-phase", "idle");
  await expect(page.getByTestId("export-preset-small")).toBeChecked();
});

test("cancel really cancels and returns to the settings; the editor is read-only meanwhile", async ({ page }) => {
  test.setTimeout(120_000);
  await ready(page);
  // About 8 s of footage, so the export is still running when we reach for Cancel: three more copies of the clip, each added with its own "+"
  // (a clip already on the timeline has no "+", so the same card cannot be added three times).
  await page.getByTestId("media-input").setInputFiles([resolve(FIX, "vp9_opus.webm"), resolve(FIX, "vp9_opus.webm"), resolve(FIX, "vp9_opus.webm")]);
  await expect(page.locator('[data-testid=bin-item][data-status="ready"]')).toHaveCount(4, { timeout: 30_000 }); // the one that was added and the three new copies
  const add = page.getByRole("button", { name: "Add vp9_opus.webm to the timeline" });
  for (let i = 0; i < 3; i++) {
    // the phone sheet closes itself after an import and after each add: reopen it only when the next "+" is hidden
    if ((page.viewportSize()?.width ?? 0) < 720 && !(await add.first().isVisible())) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click();
    await add.first().click();
  }
  await page.getByTestId("export-open").click();
  await page.getByTestId("export-go").click();
  const dialog = page.getByTestId("export-dialog");
  await expect(page.getByTestId("export-progress")).toBeVisible();
  await expect(page.getByTestId("export-progress")).toHaveAttribute("aria-valuenow", /\d+/);
  // keep editing -> the dialog tucks into the top bar; the chip shows progress
  await page.getByTestId("export-minimize").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("export-chip")).toContainText("Exporting");
  await page.getByTestId("export-chip").click();
  await page.getByTestId("export-cancel").click();
  await expect(page.getByTestId("export-go")).toBeVisible({ timeout: 15_000 }); // back on the settings
  await expect(page.getByTestId("export-chip")).toHaveCount(0);
});

test("platform presets: picking Discord aims under its cap, labels the figure a target, and any Advanced change drops the cap", async ({ page }) => {
  await ready(page);
  await page.getByTestId("export-open").click();
  await page.getByTestId("export-preset-discord").check({ force: true });
  await expect(page.getByTestId("export-preset-discord")).toBeChecked();
  await expect(page.locator(".export-chip-choice", { has: page.getByTestId("export-preset-discord") })).toContainText("Aims under 10 MB");
  await expect(page.getByTestId("export-cap-note")).toContainText(/Aims to stay under 10 MB.*target/);
  await expect(page.getByTestId("export-estimate")).toContainText(/About .* (MB|KB)/);
  await expect(page.getByTestId("export-cap-warning")).toHaveCount(0); // a short clip fits
  // The 160x120 fixture is not 9:16, so the TikTok chip says it adds bars and shows the note when chosen.
  await page.getByTestId("export-preset-vertical").check({ force: true });
  await expect(page.getByText("placed inside this tall frame with black bars")).toBeVisible();
  await expect(page.getByTestId("export-cap-note")).toHaveCount(0);
  await page.getByTestId("export-preset-facebook").check({ force: true });
  await expect(page.getByTestId("export-preset-facebook")).toBeChecked();
  await expect(page.getByTestId("export-cap-note")).toHaveCount(0); // no size cap claimed
  await page.getByTestId("export-preset-whatsapp").check({ force: true });
  await expect(page.getByTestId("export-cap-note")).toContainText("16 MB");
  await page.getByText("Advanced").click();
  await page.getByTestId("export-quality").selectOption("low");
  await expect(page.getByTestId("export-cap-note")).toHaveCount(0); // custom: no cap claim
  expect(await noOverflow(page)).toBeLessThanOrEqual(0);
});

test("E2: on a 320x640 phone the Export button is on screen without scrolling the dialog, and nothing overflows", async ({ page }) => {
  await ready(page);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.getByTestId("export-open").click();
  const dialog = page.getByTestId("export-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("export-go")).toBeVisible();
  const go = (await page.getByTestId("export-go").boundingBox())!;
  expect(go.height).toBeGreaterThanOrEqual(44);
  expect(go.y + go.height).toBeLessThanOrEqual(640); // sticky footer: visible at rest, not below the fold
  expect(go.x).toBeGreaterThanOrEqual(0);
  expect(go.x + go.width).toBeLessThanOrEqual(320);
  expect(await noOverflow(page)).toBeLessThanOrEqual(0);
  // the settings above still scroll, and the footer stays on screen at the end of them
  await dialog.evaluate((d) => { d.scrollTop = d.scrollHeight; });
  const end = (await page.getByTestId("export-go").boundingBox())!;
  expect(end.y + end.height).toBeLessThanOrEqual(640);
  await expect(page.getByTestId("export-go")).toBeEnabled();
});
