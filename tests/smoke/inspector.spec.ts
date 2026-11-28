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
  expect((await diamond.boundingBox())!.height).toBeGreaterThanOrEqual(phone ? 44 : 28); // r15: 28 px on a mouse, 44 on touch
  await diamond.click();
  await expect(diamond).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("insp-ease-opacity")).toHaveAttribute("data-value", "linear");
  await opacity.fill("40");
  await expect(opacity).toHaveValue("40");
  await expect(diamond).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("insp-ease-opacity").click();
  await page.getByTestId("insp-ease-opacity-hold").click();
  await expect(page.getByTestId("insp-ease-opacity")).toHaveAttribute("data-value", "hold");
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

    // Snapping: a drag that ends a few pixels from the canvas centre lands on it (0 %, guide lines shown while it holds); Alt moves freely.
    const c = (await body.boundingBox())!;
    const [cx, cy] = [c.x + c.width / 2, c.y + c.height / 2];
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 80, cy + 50, { steps: 4 });
    await expect(page.getByTestId("snap-guide-x")).toHaveCount(0); // far from every line: no guide
    await page.mouse.move(cx + 3, cy + 2, { steps: 4 });
    await expect(page.getByTestId("snap-guide-x")).toBeVisible();
    await expect(page.getByTestId("snap-guide-y")).toBeVisible();
    await page.mouse.up();
    await expect(page.getByTestId("snap-guide-x")).toHaveCount(0);
    await expect(x).toHaveValue("0");
    await expect(page.getByTestId("insp-position_y")).toHaveValue("0");
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.keyboard.down("Alt");
    await page.mouse.move(cx + 80, cy + 50, { steps: 4 });
    await page.mouse.move(cx + 3, cy + 2, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up("Alt");
    await expect(x).not.toHaveValue("0");
  }
});

test("phone Edit sheet at 320 px: the mini transport keeps 44 px buttons", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "phone sheet only");
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect(page.getByTestId("preview-import")).toBeEnabled({ timeout: 20_000 });
  await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click();
  await page.getByTestId("media-input").setInputFiles(FLASH);
  await expect(page.locator(".canvas")).toHaveAttribute("data-loaded", "true");
  await page.getByRole("button", { name: "Close panel" }).click({ timeout: 3000 }).catch(() => undefined); // the Media sheet may have closed itself
  const box = (await page.getByTestId("timeline-canvas").boundingBox())!;
  const dg = await gutterShift(page);
  await page.touchscreen.tap(box.x + dg + 68, box.y + 56);
  await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Edit" }).click();
  const strip = page.getByTestId("mini-transport");
  await expect(strip).toBeVisible();
  // Measure once the sheet has settled: mid-slide its top sits on a fractional pixel and the box reads 43.99998 px.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
  for (const b of await strip.getByRole("button").all()) {
    const r = (await b.boundingBox())!;
    expect(r.width).toBeGreaterThanOrEqual(44);
    expect(r.height).toBeGreaterThanOrEqual(44);
  }
});
