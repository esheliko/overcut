import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

/** E3: Esc on a dialog returns focus to the control that opened it (Export, Tags, New project). Desktop and phone. Needs a build with the engine. */
const FIX = resolve("crates/media/tests/fixtures");

async function ready(page: Page) {
  await page.addInitScript(() => { delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker; });
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await page.getByTestId("media-input").setInputFiles(resolve(FIX, "vp9_opus.webm"));
  await expect(page.locator("#tl-summary")).toContainText("1 clip", { timeout: 30_000 });
}

test("Esc on the Export dialog puts focus back on the Export button", async ({ page }) => {
  await ready(page);
  const open = page.getByTestId("export-open");
  await open.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("export-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("export-dialog")).toBeHidden();
  await expect(open).toBeFocused();
});

test("Esc on the Tags dialog puts focus back on the Tags button of that item", async ({ page }) => {
  await ready(page);
  if ((page.viewportSize()?.width ?? 0) < 720) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click();
  const tagBtn = page.getByTestId("bin-tag-edit").first();
  await tagBtn.click();
  await expect(page.getByTestId("tags-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("tags-dialog")).toHaveCount(0);
  await expect(tagBtn).toBeFocused();
});

test("Esc on the New project confirmation puts focus back on the Menu button", async ({ page }) => {
  await ready(page);
  const menuBtn = page.getByRole("button", { name: "Menu" });
  await menuBtn.click();
  await page.getByRole("menuitem", { name: "New project…" }).click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
  await expect(menuBtn).toBeFocused();
});

/** a11y r12 (WCAG 2.4.3): a toolbar button that its own action turns off (Delete with nothing left selected, Redo at the end) must not drop focus on the page. */
test("Delete and Redo hand keyboard focus to the timeline instead of losing it", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "keyboard flow");
  await ready(page);
  const cv = page.getByTestId("timeline-canvas");
  await cv.focus();
  await page.keyboard.press("Enter"); // select the clip at the playhead
  await page.getByRole("button", { name: "Delete", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#tl-summary")).toContainText("0 clips");
  await expect(cv).toBeFocused();
  await page.getByRole("button", { name: /^Undo/ }).focus();
  await page.keyboard.press("Enter"); // undo the delete: Redo turns on
  await page.getByRole("button", { name: /^Redo/ }).focus();
  await page.keyboard.press("Enter"); // redo it: Redo turns off again
  await expect(page.locator("#tl-summary")).toContainText("0 clips");
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
});

/** a11y r12 (WCAG 2.4.3 / 2.4.11 / 4.1.2). */
test("Tab leaves the app menu (focus back on its button, the page behind it is not entered)", async ({ page }) => {
  await ready(page);
  const menuBtn = page.getByRole("button", { name: "Menu" });
  await menuBtn.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(menuBtn).toBeFocused();
});

test("phone: focus moving to a control the open tool sheet would cover closes the sheet", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "the sheet is a phone layout");
  await ready(page);
  await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click();
  await expect(page.getByTestId("panel-tool")).toHaveAttribute("data-open", "true");
  await page.getByTestId("timeline-canvas").focus();
  await expect(page.getByTestId("panel-tool")).toHaveAttribute("data-open", "false");
  await expect(page.getByTestId("timeline-canvas")).toBeFocused();
});

test("the splitter always has a value inside its range", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "the splitter is a tablet and desktop control");
  await ready(page);
  const s = page.getByTestId("splitter");
  const [min, max, now] = await Promise.all(["aria-valuemin", "aria-valuemax", "aria-valuenow"].map((a) => s.getAttribute(a).then(Number)));
  expect(Number.isFinite(now)).toBe(true);
  expect(now).toBeGreaterThanOrEqual(min!);
  expect(now).toBeLessThanOrEqual(max!);
});
