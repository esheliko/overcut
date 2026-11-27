import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { gutterShift } from "./timeline-geometry";

/**
 * M2 transform inspector: select the picture clip, edit position / rotation in the Details panel (a docked panel on desktop, the tool sheet on a
 * phone), see the value stick, undo it, reset. On desktop also drag the picture on the preview: one drag is one undo step.
 */
const FLASH = resolve("crates/media/tests/fixtures/flash_click.mp4");
const UNDO = /^Undo( (?!recovery).+)?$/;

test("inspector: fields edit the selected clip's transform, undo reverts, reset restores", async ({ page }, info) => {
  const phone = info.project.name === "phone";
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect(page.getByTestId("preview-import")).toBeEnabled({ timeout: 20_000 });
  if (phone) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click();
  await page.getByTestId("media-input").setInputFiles(FLASH);
  await expect(page.locator("#tl-summary")).toContainText("1 clip");
  await expect(page.locator(".canvas")).toHaveAttribute("data-loaded", "true");

  // Select the picture clip (its linked sound goes with it).
  const box = (await page.getByTestId("timeline-canvas").boundingBox())!;
  const dg = await gutterShift(page);
  if (phone) await page.touchscreen.tap(box.x + dg + 68, box.y + 56);
  else await page.mouse.click(box.x + dg + 68, box.y + 56);
  if (phone) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Edit" }).click();

  // On a phone the tool sheet covers the Undo button: close it, undo, reopen (as the project-store spec does for the Media sheet).
  const undo = async () => {
    if (phone) await page.getByRole("button", { name: "Close panel" }).click();
    await page.getByRole("button", { name: UNDO }).click();
    if (phone) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Edit" }).click();
  };
  const x = page.getByTestId("insp-position_x");
  const rot = page.getByTestId("insp-rotation");
  await expect(x).toBeVisible();
  await expect(x).toHaveValue("0");
  await x.fill("20");
  await expect(x).toHaveValue("20");
  await rot.fill("15");
  await expect(rot).toHaveValue("15");
  await expect(page.getByTestId("insp-reset")).toBeEnabled();

  // Each field edit is its own step; undo twice restores the identity, reset is disabled again.
  await undo();
  await undo();
  await expect(x).toHaveValue("0");
  await expect(rot).toHaveValue("0");
  await expect(page.getByTestId("insp-reset")).toBeDisabled();

  await x.fill("-10");
  await page.getByTestId("insp-more").click(); // crop, fit and flip sit under "Crop & flip"
  await page.getByTestId("insp-flip-h").click();
  await expect(page.getByTestId("insp-flip-h")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("insp-reset").click();
  await expect(x).toHaveValue("0");
  await expect(page.getByTestId("insp-flip-h")).toHaveAttribute("aria-pressed", "false");

  // Keyframes (M2-004): the diamond adds a key at the playhead, the easing picker appears on it, editing the field updates the key,
  // the diamond again removes it and the value stays.
  const diamond = page.getByTestId("insp-key-opacity");
  const opacity = page.getByTestId("insp-opacity");
  await expect(diamond).toHaveAttribute("aria-pressed", "false");
  expect((await diamond.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await diamond.click();
  await expect(diamond).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("insp-ease-opacity")).toHaveValue("linear");
  await opacity.fill("40");
  await expect(opacity).toHaveValue("40");
  await expect(diamond).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("insp-ease-opacity").selectOption("hold");
  await expect(page.getByTestId("insp-ease-opacity")).toHaveValue("hold");
  await diamond.click();
  await expect(diamond).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("insp-ease-opacity")).toHaveCount(0);
  await expect(opacity).toHaveValue("40");

  // Desktop: drag the picture on the preview. Many pointer moves = one undo step.
  if (!phone) {
    const body = page.getByTestId("transform-body");
    await expect(body).toBeVisible();
    const b = (await body.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(b.x + b.width / 2 + i * 10, b.y + b.height / 2 + i * 5);
    await page.mouse.up();
    await expect(x).not.toHaveValue("0");
    await expect(page.getByTestId("insp-position_y")).not.toHaveValue("0");
    await page.getByRole("button", { name: UNDO }).click();
    await expect(x).toHaveValue("0");
    await expect(page.getByTestId("insp-position_y")).toHaveValue("0");
  }
});
