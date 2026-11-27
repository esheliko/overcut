import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { gutterShift } from "./timeline-geometry";

/** M2-008: the Speed tab: a preset changes the selected clip (and its linked sound) in one undo step; the field takes a typed value; the note says pitch is kept. */
const FLASH = resolve("crates/media/tests/fixtures/flash_click.mp4");
const UNDO = /^Undo( (?!recovery).+)?$/;

test("speed: presets and the field change the selected clip, undo reverts", async ({ page }, info) => {
  const phone = info.project.name === "phone";
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect(page.getByTestId("preview-import")).toBeEnabled({ timeout: 20_000 });
  if (phone) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click();
  await page.getByTestId("media-input").setInputFiles(FLASH);
  await expect(page.locator("#tl-summary")).toContainText("1 clip");
  await expect(page.locator(".canvas")).toHaveAttribute("data-loaded", "true");
  const box = (await page.getByTestId("timeline-canvas").boundingBox())!;
  const dg = await gutterShift(page);
  if (phone) await page.touchscreen.tap(box.x + dg + 68, box.y + 56);
  else await page.mouse.click(box.x + dg + 68, box.y + 56);
  if (phone) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Edit" }).click();
  await page.getByRole("tab", { name: "Speed" }).click();

  const field = page.getByTestId("speed-field");
  await expect(field).toHaveValue("1");
  await expect(page.getByTestId("speed-preset-1")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("speed-preset-2").click();
  await expect(page.getByTestId("speed-preset-2")).toHaveAttribute("aria-pressed", "true");
  await expect(field).toHaveValue("2");
  await expect(page.locator('.visually-hidden[role="status"]')).toContainText(/Speed 2×: .* to 0:0[0-9]\.\d\d/); // the status line reads the new span
  await expect(page.getByTestId("speed-message")).toHaveText("");
  // The pitch note is part of the panel's flow (it once floated off to the bottom of the window): it sits inside the viewport, under the "move later clips" row.
  const [pitch, ripple, vp] = await Promise.all([page.getByTestId("speed-pitch").boundingBox(), page.getByTestId("speed-ripple").boundingBox(), page.evaluate(() => window.innerHeight)]);
  expect(pitch!.y).toBeGreaterThan(ripple!.y);
  expect(pitch!.y + pitch!.height).toBeLessThanOrEqual(vp);
  if (process.env.SPEED_SHOT) await page.screenshot({ path: `${process.env.SPEED_SHOT}-${info.project.name}.png` });

  await field.fill("1.25");
  await field.blur();
  await expect(page.getByTestId("speed-preset-2")).toHaveAttribute("aria-pressed", "false");
  await expect(field).toHaveValue("1.25");
  await field.fill("9");
  await field.blur();
  await expect(page.getByTestId("speed-message")).toContainText("between");

  if (phone) await page.getByRole("button", { name: "Close panel" }).click();
  await page.getByRole("button", { name: UNDO }).click();
  if (phone) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Edit" }).click();
  if (phone) await page.getByRole("tab", { name: "Speed" }).click();
  await expect(page.getByTestId("speed-preset-2")).toHaveAttribute("aria-pressed", "true");
});
