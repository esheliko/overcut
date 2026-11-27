import { expect, test, type Page } from "@playwright/test";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** PM-01 canvas settings, PM-07 save / open `.overcut`, and New project (docs/features/canvas.md, docs/features/project-file.md). Needs a build with the engine. */
const FLASH = resolve("crates/media/tests/fixtures/flash_click.mp4"); // 3 s, 30 fps, picture + sound

/** Chromium's native file pickers cannot be driven by a test: remove them so the app takes its download / file-input path (the one Firefox and Safari use). */
const ready = async (page: Page) => {
  await page.addInitScript(() => { delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker; delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker; });
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect(page.getByTestId("preview-import")).toBeEnabled({ timeout: 20_000 });
};
const menu = async (page: Page, item: string) => {
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("menuitem", { name: item }).click();
};
const isTall = async (page: Page) => { const b = (await page.locator(".canvas").boundingBox())!; return b.height > b.width; };

test("canvas settings are a project edit (undo), survive an import, and new project / save / open round-trip them", async ({ page }, info) => {
  test.setTimeout(120_000);
  const phone = info.project.name === "phone";
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page);

  // 1. Canvas: 9:16 at 25 fps. The preview changes shape; Undo names the change and takes it back.
  const open = page.getByTestId("canvas-open");
  await open.click();
  const dialog = page.getByTestId("canvas-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("canvas-result")).toContainText("Set by your first clip");
  await page.getByTestId("canvas-shape").selectOption("9:16");
  await page.getByTestId("canvas-fps").selectOption("25");
  await expect(page.getByTestId("canvas-result")).toHaveText("Result: 1080 × 1920 at 25 fps");
  if (phone) expect((await page.getByTestId("canvas-apply").boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.getByTestId("canvas-apply").click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => isTall(page)).toBe(true);
  await expect(open).toHaveAccessibleName(/^Canvas: 9:16 · 1080 × 1920 · 25 fps/);
  const undo = page.getByRole("button", { name: "Undo canvas change" });
  await undo.click();
  await expect.poll(() => isTall(page)).toBe(false);
  await expect(open).toHaveAccessibleName(/^Canvas: 16:9/);
  await page.getByRole("button", { name: "Redo canvas change" }).click();
  await expect.poll(() => isTall(page)).toBe(true);

  // 2. First import with a chosen canvas: the clip does not overwrite it.
  if (phone) await page.getByRole("navigation", { name: "Tools" }).getByRole("button").first().click();
  await page.getByTestId("media-input").setInputFiles(FLASH);
  await expect(page.locator("#tl-summary")).toContainText("1 clip");
  await expect(open).toHaveAccessibleName(/^Canvas: 9:16 · 1080 × 1920 · 25 fps/);
  expect(await isTall(page)).toBe(true);
  // With a picture in the project "match first clip" is no longer offered as a new choice.
  await open.click();
  await expect(page.getByTestId("canvas-dialog").getByRole("option", { name: "Match first clip" }).first()).toBeDisabled();
  await page.getByTestId("canvas-cancel").click();

  // 3. Save project as .overcut (download path): a zip with the project in it.
  const saved = page.waitForEvent("download");
  await menu(page, "Save project as…");
  const file = await saved;
  expect(file.suggestedFilename()).toBe("Untitled project.overcut");
  const path = await file.path();
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
  expect(bytes.includes(Buffer.from("project.json"))).toBe(true);
  await expect(page.locator(".toast")).toContainText("Saved Untitled project.overcut");

  // 4. New project asks first (there is unsaved work... saving just now counts as saved, so edit once more), then starts empty with the default canvas.
  await page.getByRole("button", { name: /^Undo/ }).click();
  await menu(page, "New project…");
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await expect(page.getByTestId("confirm-ok")).toHaveClass(/confirm-danger/); // F2: the destructive button looks destructive
  await page.getByTestId("confirm-cancel").click();
  await expect(page.locator("#tl-summary")).not.toContainText("1 clip"); // still the project with the undone import
  await menu(page, "New project…");
  await page.getByTestId("confirm-ok").click();
  await expect(page.locator("#tl-summary")).toContainText("0 clips");
  await expect(open).toHaveAccessibleName(/^Canvas: 16:9/);
  await expect.poll(() => isTall(page)).toBe(false);

  // 5. Open the saved file: nothing unsaved, so no question; the project, canvas and clips are back, the media (same name and size) reconnects by itself.
  const chooser = page.waitForEvent("filechooser");
  await menu(page, "Open project…");
  await (await chooser).setFiles(path);
  await expect(page.locator("#tl-summary")).toContainText("1 clip");
  await expect(open).toHaveAccessibleName(/^Canvas: 9:16 · 1080 × 1920 · 25 fps/);
  await expect.poll(() => isTall(page)).toBe(true);
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);

  // 6. A file that is not a project is refused and changes nothing.
  const junk = join(mkdtempSync(join(tmpdir(), "overcut-")), "junk.overcut");
  writeFileSync(junk, "this is not a zip");
  const chooser2 = page.waitForEvent("filechooser");
  await menu(page, "Open project…");
  await (await chooser2).setFiles(junk);
  await expect(page.getByTestId("failure-note")).toContainText("could not be opened"); // R12: a failure stays until dismissed (it was a 4 s toast)
  await expect(page.locator("#tl-summary")).toContainText("1 clip");

  // 7. A new window has none of the files: opening the project shows them as not on this device, and Locate files reconnects them by name and size.
  await page.reload();
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect(page.locator("#tl-summary")).toContainText("1 clip", { timeout: 20_000 }); // autosave brought the project back
  const chooser3 = page.waitForEvent("filechooser");
  await menu(page, "Open project…");
  await (await chooser3).setFiles(path);
  await expect(page.getByTestId("offline-note")).toBeVisible();
  const chooser4 = page.waitForEvent("filechooser");
  await page.getByTestId("locate-files").click();
  await (await chooser4).setFiles(FLASH);
  await expect(page.locator(".toast")).toContainText("Reconnected 1 of 1");
  await expect(page.getByTestId("offline-note")).toHaveCount(0);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});
