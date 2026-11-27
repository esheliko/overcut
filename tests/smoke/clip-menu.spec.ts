import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

/** M2 UX T-03: right-click (or the context-menu key) on a clip opens its menu; its rows run the usual commands. Needs a build with the engine. */
const FIX = resolve("crates/media/tests/fixtures");

test("right-click a clip: menu with Split, Duplicate, Delete, Speed; the context-menu key opens it for the selection; Delete runs", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 720, "mouse flow");
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await page.getByTestId("media-input").setInputFiles(resolve(FIX, "h264_aac.mp4"));
  await expect(page.locator("#tl-summary")).toContainText("1 clip");
  const cv = page.getByTestId("timeline-canvas");
  const box = (await cv.boundingBox())!;
  const g = Number(await cv.getAttribute("data-gutter"));
  await page.mouse.click(box.x + g + 120, box.y + 56, { button: "right" });
  const menu = page.getByTestId("tl-clip-menu");
  await expect(menu).toBeVisible();
  for (const id of ["split", "duplicate", "delete", "rippleDelete", "unlink", "speed-0.5", "speed-2"]) await expect(menu.getByTestId(`tl-clip-${id}`)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await cv.focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  await menu.getByTestId("tl-clip-delete").click();
  await expect(page.locator("#tl-summary")).toContainText("0 clips");
});
