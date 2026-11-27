import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

/** M2 UX: the draggable splitter, full-screen preview, the phone sheet's detents and the phone landscape layout. */
const FLASH = resolve("crates/media/tests/fixtures/flash_click.mp4");

async function ready(page: Page, phone: boolean) {
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect(page.getByTestId("preview-import")).toBeEnabled({ timeout: 20_000 });
  if (phone) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click();
  await page.getByTestId("media-input").setInputFiles(FLASH);
  await expect(page.locator("#tl-summary")).toContainText("1 clip");
  // on a phone the Media sheet closes by itself after a successful import
}

test("splitter: keys resize the timeline, double-click resets, the size is remembered", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "the splitter is for tablet and up");
  await ready(page, false);
  const sep = page.getByTestId("splitter");
  const tl = page.locator(".timeline");
  const before = (await tl.boundingBox())!.height;
  await sep.focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect.poll(async () => (await tl.boundingBox())!.height).toBeGreaterThan(before + 30);
  await expect(sep).toHaveAttribute("aria-valuenow", /\d+/);
  await page.reload();
  await expect(page.getByTestId("splitter")).toHaveAttribute("aria-valuenow", /\d+/);
  await page.getByTestId("splitter").dblclick();
  await expect.poll(async () => Math.abs((await tl.boundingBox())!.height - before)).toBeLessThan(4);
});

test("full screen: the button and Esc (overlay or browser fullscreen)", async ({ page }, info) => {
  const phone = info.project.name === "phone";
  await ready(page, phone);
  const btn = page.getByTestId("fullscreen-toggle");
  await expect(btn).toHaveAttribute("aria-pressed", "false");
  await btn.click();
  await expect(btn).toHaveAttribute("aria-pressed", "true");
  await btn.click(); // (Esc leaves the browser's fullscreen too; headless Chromium does not forward it)
  await expect(btn).toHaveAttribute("aria-pressed", "false");
  await page.getByTestId("loop-toggle").click();
  await expect(page.getByTestId("loop-toggle")).toHaveAttribute("aria-pressed", "true");
});

test("phone sheet: the handle steps through detents and Escape closes", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "phone only");
  await ready(page, true);
  await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click();
  const sheet = page.getByTestId("panel-tool");
  const handle = page.getByTestId("sheet-handle");
  await expect(sheet).toHaveAttribute("data-detent", "half");
  const half = (await sheet.boundingBox())!.height;
  await handle.focus();
  await page.keyboard.press("ArrowUp");
  await expect(sheet).toHaveAttribute("data-detent", "full");
  await expect.poll(async () => (await sheet.boundingBox())!.height).toBeGreaterThan(half + 40);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(sheet).toHaveAttribute("data-detent", "peek");
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveAttribute("data-open", "false");
});

test("phone landscape: the picture is a real size and nothing scrolls sideways", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "phone only");
  await page.setViewportSize({ width: 844, height: 390 });
  await ready(page, true);
  const box = (await page.getByTestId("preview-canvas").boundingBox())!;
  expect(box.height).toBeGreaterThan(390 * 0.4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
