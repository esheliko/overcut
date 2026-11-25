import { expect, test } from "@playwright/test";
import { gutterShift } from "./timeline-geometry";

// TL-02 / TL-06: duplicate, copy / paste, numeric trim and the history panel, all through the toolbar (touch friendly) on phone and desktop.
test("duplicate, copy and paste, numeric timing and the history panel go through the engine", async ({ page }, info) => {
  const phone = info.project.name === "phone";
  await page.goto("/?sample");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  const summary = page.locator("#tl-summary");
  const live = page.locator('[data-announcer="polite"]');
  const canvas = page.getByTestId("timeline-canvas");
  await expect(summary).toContainText("14 clips");
  // The clip tools live in the More menu; a disabled row says why instead of being a silent dead button.
  const pick = async (id: string) => { await page.getByTestId("tl-more").click(); await page.getByTestId(id).click(); };
  await page.getByTestId("tl-more").click();
  for (const id of ["tl-duplicate", "tl-copy", "tl-cut", "tl-timing", "tl-paste"]) await expect(page.getByTestId(id)).toHaveAttribute("aria-disabled", "true"); // nothing selected / nothing copied
  await expect(page.getByTestId("tl-more-menu")).toContainText("Select a clip first");
  await expect(page.getByTestId("tl-history")).not.toHaveAttribute("aria-disabled", "true");
  for (const id of ["tl-duplicate", "tl-copy", "tl-cut", "tl-paste", "tl-timing", "tl-history"]) { // 44 px on touch, inside the viewport
    const b = (await page.getByTestId(id).boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    if (phone) { expect(b.width).toBeGreaterThanOrEqual(44); expect(b.height).toBeGreaterThanOrEqual(44); }
  }
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("tl-more-menu")).toHaveCount(0);

  const box = (await canvas.boundingBox())!;
  const dg = await gutterShift(page);
  const at = async (x: number, y: number) => (phone ? page.touchscreen.tap(box.x + dg + x, box.y + y) : page.mouse.click(box.x + dg + x, box.y + y));
  await at(108, 30 + 26); // select the first clip

  await pick("tl-duplicate");
  await expect(summary).toContainText("15 clips");
  await expect(live).toContainText("Duplicated 1 clip");
  await expect(page.getByTestId("tl-selected")).toHaveText("1 selected"); // the copy is selected

  await pick("tl-copy");
  await expect(live).toContainText("Copied 1 clip");
  await page.getByTestId("tl-more").click();
  await expect(page.getByTestId("tl-paste")).not.toHaveAttribute("aria-disabled", "true");
  await page.getByTestId("tl-paste").click();
  await expect(summary).toContainText("16 clips");
  await expect(live).toContainText("Pasted 1 clip");

  // Numeric timing: the pasted clip is selected; set its length to 1 second.
  await pick("tl-timing");
  const dialog = page.getByTestId("timing-dialog");
  await expect(dialog).toBeVisible();
  await page.getByTestId("timing-duration").fill("nonsense");
  await page.getByTestId("timing-set-duration").click();
  await expect(page.getByTestId("timing-error")).toContainText("not a time");
  await page.getByTestId("timing-duration").fill("00:01:00");
  await page.getByTestId("timing-set-duration").click();
  await expect(live).toContainText("Set length of");
  await expect(page.getByTestId("timing-duration")).toHaveValue("00:01:00");
  await expect(page.getByTestId("timing-end")).not.toHaveValue("");
  await page.getByTestId("timing-start").fill("59:00:00"); // a start after the clip's end is out of range
  await page.getByTestId("timing-set-start").click();
  await expect(page.getByTestId("timing-error")).toContainText("Out of range");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // History: every step is listed with its name; tapping one goes there.
  await pick("tl-history");
  const list = page.getByTestId("history-list");
  await expect(list.getByRole("button")).toHaveText([/Original project/, /Duplicate of 1 clip/, /Paste of 1 clip/, /Timing of /]);
  await expect(list.locator('[aria-current="step"]')).toContainText("Timing of");
  await list.getByRole("button", { name: /Duplicate of 1 clip/ }).click();
  await expect(summary).toContainText("15 clips");
  await expect(list.locator('[aria-current="step"]')).toContainText("Duplicate of 1 clip");
  await expect(list.getByRole("button", { name: /Paste of 1 clip/ })).toContainText("undone");
  await list.getByRole("button", { name: /Paste of 1 clip/ }).click(); // forward again
  await expect(summary).toContainText("16 clips");
  await list.getByRole("button", { name: /Original project/ }).click();
  await expect(summary).toContainText("14 clips");
  await page.screenshot({ path: test.info().outputPath("history.png") });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByTestId("history-dialog")).toHaveCount(0);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  if (phone) return;
  // Keyboard on desktop: Ctrl+C / Ctrl+V / Ctrl+D with the canvas focused.
  await canvas.focus();
  await page.keyboard.press("Enter"); // picks the clip at the playhead
  await page.keyboard.press("Control+d");
  await expect(summary).toContainText("15 clips");
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  await expect(summary).toContainText("16 clips");
  await page.keyboard.press("Control+x");
  await expect(summary).toContainText("15 clips");
});
