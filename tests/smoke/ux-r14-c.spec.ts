import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { gutterShift } from "./timeline-geometry";

/** UX r14 lane C: Details sections (slider + number, one undo per drag, per-section reset), the media bin's grid / list view and "On timeline" pill, the export dialog's preview frame and merged presets. */
const FLASH = resolve("crates/media/tests/fixtures/flash_click.mp4");
const UNDO = /^Undo( (?!recovery).+)?$/;

test("details sections: slider + number, a drag is one undo step, per-section reset, collapse", async ({ page }, info) => {
  const phone = info.project.name === "phone";
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect(page.getByTestId("preview-import")).toBeEnabled({ timeout: 20_000 });
  const tools = page.getByRole("navigation", { name: "Tools" });
  if (phone) await tools.getByRole("button", { name: "Media" }).click();
  await page.getByTestId("media-input").setInputFiles(FLASH);
  await expect(page.locator("#tl-summary")).toContainText("1 clip");
  await expect(page.locator(".canvas")).toHaveAttribute("data-loaded", "true");

  // Nothing selected: the project summary, never an empty column.
  if (!phone) await expect(page.getByTestId("insp-project-info")).toBeVisible();

  const box = (await page.getByTestId("timeline-canvas").boundingBox())!;
  const dg = await gutterShift(page);
  if (phone) await page.touchscreen.tap(box.x + dg + 68, box.y + 56);
  else await page.mouse.click(box.x + dg + 68, box.y + 56);
  if (phone) await tools.getByRole("button", { name: "Edit" }).click();

  const opacity = page.getByTestId("insp-opacity");
  const slider = page.getByTestId("insp-slider-opacity");
  await expect(opacity).toHaveValue("100");
  await expect(slider).toBeVisible();
  // The section's reset appears only once something differs.
  await expect(page.getByTestId("insp-secreset-opacity")).toBeDisabled();

  if (phone) {
    await slider.fill("60");
  } else {
    // A real pointer drag along the slider: many input events, one undo step.
    await slider.scrollIntoViewIfNeeded();
    const b = (await slider.boundingBox())!;
    await page.mouse.move(b.x + b.width - 4, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width * 0.5, b.y + b.height / 2, { steps: 12 });
    await page.mouse.move(b.x + b.width * 0.25, b.y + b.height / 2, { steps: 12 });
    await page.mouse.up();
  }
  await expect(opacity).not.toHaveValue("100");
  await expect(page.getByTestId("insp-secreset-opacity")).toBeEnabled();

  // One undo returns the whole drag.
  if (phone) await page.getByRole("button", { name: "Close panel" }).click();
  await page.getByRole("button", { name: UNDO }).click();
  if (phone) await tools.getByRole("button", { name: "Edit" }).click();
  await expect(opacity).toHaveValue("100");

  // Typing in the number moves the slider; the section reset puts both back.
  await opacity.fill("40");
  await expect(slider).toHaveValue("40");
  await page.getByTestId("insp-secreset-opacity").click();
  await expect(opacity).toHaveValue("100");

  // Sections collapse and the choice is kept.
  const transform = page.getByTestId("insp-sec-transform").getByRole("button", { name: "Transform" });
  await expect(transform).toHaveAttribute("aria-expanded", "true");
  await transform.click();
  await expect(transform).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("insp-position_x")).toHaveCount(0);
  await transform.click();
  await expect(page.getByTestId("insp-position_x")).toBeVisible();
});

test("media bin: grid and list view, the On timeline pill", async ({ page }, info) => {
  const phone = info.project.name === "phone";
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  const tools = page.getByRole("navigation", { name: "Tools" });
  if (phone) await tools.getByRole("button", { name: "Media" }).click();
  // The empty state names the formats it takes.
  await expect(page.getByTestId("import-empty")).toContainText("MP4");
  await page.getByTestId("media-input").setInputFiles(FLASH);
  await expect(page.locator("#tl-summary")).toContainText("1 clip");
  if (phone) await tools.getByRole("button", { name: "Media" }).click();
  await expect(page.getByTestId("bin-item")).toHaveCount(1);
  await expect(page.getByTestId("bin-on-timeline")).toBeVisible();
  await expect(page.getByTestId("bin-on-timeline")).toContainText("On the timeline");
  const toggle = page.getByTestId("bin-view-toggle"); // pressed = list
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  const gridH = (await page.getByTestId("bin-item").boundingBox())!.height;
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".bin-list[data-view='list']")).toBeVisible();
  const listH = (await page.getByTestId("bin-item").boundingBox())!.height;
  expect(listH).toBeLessThan(gridH);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await toggle.click();
  await expect(page.locator(".bin-list[data-view='grid']")).toBeVisible();
});

test("export dialog: preview frame, prominent size, merged presets, Export always visible", async ({ page }, info) => {
  const phone = info.project.name === "phone";
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  if (phone) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click();
  await page.getByTestId("media-input").setInputFiles(FLASH);
  await expect(page.locator("#tl-summary")).toContainText("1 clip");
  await expect(page.locator(".canvas")).toHaveAttribute("data-loaded", "true");
  await page.getByTestId("export-open").click();
  await expect(page.getByTestId("export-frame")).toBeVisible();
  await expect(page.getByTestId("export-estimate")).toContainText(/About .* (MB|KB)/);
  // Presets that give the same file are one tile; the tile names the others, and every preset is still reachable.
  const tiles = await page.locator(".export-chip-choice").count();
  expect(tiles).toBeGreaterThan(1);
  const same = page.getByTestId("export-same-original");
  if (tiles < 8) await expect(same).toBeVisible();
  // The primary button is on screen without scrolling.
  const go = page.getByTestId("export-go");
  await expect(go).toBeInViewport({ ratio: 1 });
});
