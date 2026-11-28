import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

/** UX r16 lane E: the feel of the timeline canvas: back to the playhead, a held frame step, the zoom a project opens at. Needs a build and a preview server (scripts/smoke.mjs). */
const FLASH = resolve("crates/media/tests/fixtures/flash_click.mp4");

async function ready(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect(page.getByTestId("preview-import")).toBeEnabled({ timeout: 20_000 });
}
async function importClip(page: Page, phone: boolean) {
  if (phone) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click();
  await page.getByTestId("media-input").setInputFiles(FLASH);
  await expect(page.locator(".canvas")).toHaveAttribute("data-loaded", "true", { timeout: 30_000 });
  if (phone) await page.getByRole("button", { name: "Close panel" }).click({ timeout: 3000 }).catch(() => undefined);
}
const pps = async (page: Page) => Number(await page.getByTestId("timeline-canvas").getAttribute("data-pps"));
const frameOf = async (page: Page) => Number(await page.getByTestId("timeline-canvas").getAttribute("aria-valuenow"));

test("the playhead out of sight gets a chip that scrolls back to it (PHONE-5)", async ({ page }) => {
  await ready(page);
  await importClip(page, false);
  const canvas = page.getByTestId("timeline-canvas");
  const chip = page.getByTestId("tl-to-playhead");
  await expect(chip).toBeHidden();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 120);
  await page.mouse.wheel(0, 0);
  for (let i = 0; i < 4; i++) { await canvas.focus(); await page.keyboard.press("+"); } // zoom in far, then scroll right: the playhead (frame 0) is left of the headers
  await page.mouse.wheel(4000, 0);
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("data-side", "left");
  await chip.click();
  await expect(chip).toBeHidden();
});

test("holding the next-frame button repeats after 400 ms and speeds up (PHONE-9)", async ({ page }) => {
  await ready(page);
  await importClip(page, false);
  const next = page.getByTestId("step-forward");
  const f0 = await frameOf(page);
  await next.click();
  await expect.poll(() => frameOf(page)).toBe(f0 + 1); // one click: one frame, never two
  const b = (await next.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1300);
  await page.mouse.up();
  const f1 = await frameOf(page);
  expect(f1 - (f0 + 1)).toBeGreaterThan(4);
  await page.waitForTimeout(400);
  expect(await frameOf(page)).toBe(f1); // letting go stops it
});

test("a project opens fitted, and at the zoom the person chose in it after a reload (PHONE-17)", async ({ page }) => {
  await ready(page);
  await importClip(page, false);
  const fitted = await pps(page);
  expect(fitted).not.toBeCloseTo(40, 0);
  await page.getByTestId("timeline-canvas").focus();
  for (let i = 0; i < 6 && (await pps(page)) < fitted * 1.4; i++) { await page.keyboard.press("+"); await page.waitForTimeout(150); } // a clip that is still being probed can re-fit once: press until it holds
  const chosen = await pps(page);
  expect(chosen).toBeGreaterThan(fitted * 1.4);
  await page.waitForTimeout(700); // the zoom is saved after a short pause
  await page.reload();
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect(page.getByTestId("timeline-canvas")).toBeVisible();
  await expect.poll(() => pps(page), { timeout: 15_000 }).toBeCloseTo(chosen, -1);
});
