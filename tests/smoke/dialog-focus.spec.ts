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
