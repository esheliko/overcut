import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

/** UX-03: the shortcut dialog lists every command, a remapped key is used for real and survives a reload, a clash asks first. Needs a build with the engine. */
const FLASH = resolve("crates/media/tests/fixtures/flash_click.mp4");

test("remap split to Q: Q splits, S no longer does, the choice survives a reload; a clash asks before taking a key", async ({ page }, info) => {
  const phone = info.project.name === "phone";
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect(page.getByTestId("preview-import")).toBeEnabled({ timeout: 20_000 });
  if (phone) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click();
  await page.getByTestId("media-input").setInputFiles(FLASH);
  await expect(page.locator("#tl-summary")).toContainText("2 clips");

  const open = async () => {
    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("menuitem", { name: "Keyboard shortcuts…" }).click();
    await expect(page.getByTestId("shortcuts-dialog")).toBeVisible();
  };
  await open();
  const dialog = page.getByTestId("shortcuts-dialog");
  const split = page.getByTestId("sc-edit.split");
  await expect(split).toContainText("S");
  const change = page.getByTestId("sc-change-edit.split");
  expect((await change.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // Ctrl+Z belongs to Undo: pressing it asks, Cancel keeps things as they were.
  await change.click();
  await page.keyboard.press("Control+z");
  await expect(page.getByTestId("shortcuts-clash")).toContainText("already used by Undo");
  await page.getByTestId("shortcuts-clash").getByRole("button", { name: "Cancel" }).click();
  await expect(split).toContainText("S");

  await change.click();
  await page.keyboard.press("q");
  await expect(split).toContainText("Q");
  await dialog.getByRole("button", { name: "Done" }).click();

  const edit = async (k: string) => {
    await page.getByRole("slider", { name: "Playhead position" }).focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await page.keyboard.press(k);
  };
  await edit("s");
  await expect(page.locator("#tl-summary")).toContainText("2 clips");
  await edit("q");
  // The picture and its sound are linked: one split cuts both, so 2 clips become 4 (this said 3 before linked clips landed on m2).
  await expect(page.locator("#tl-summary")).toContainText("4 clips");

  await page.reload();
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await open();
  await expect(page.getByTestId("sc-edit.split")).toContainText("Q");
  await page.getByTestId("shortcuts-preset").selectOption("premiere");
  await expect(page.getByTestId("sc-edit.split")).toContainText("Ctrl+K");
  await page.getByTestId("shortcuts-preset").selectOption("default");
  await expect(page.getByTestId("sc-edit.split")).toContainText("S");
});
