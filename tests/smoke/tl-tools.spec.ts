import { expect, test } from "@playwright/test";

/** Edit tools (TL-04, M2-045): a visible tool toggle (touch has no modifier keys) and ripple delete, at phone and desktop widths. */
test("the tool toggle is visible, switches the tool, and the page never scrolls sideways", async ({ page }) => {
  await page.goto("/?sample");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  const tools = page.getByTestId("tl-tools");
  await expect(tools).toBeVisible();
  await expect(page.getByTestId("tl-tool-select")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("tl-tool-slip").click();
  await expect(page.getByTestId("tl-tool-slip")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("tl-tool-select")).toHaveAttribute("aria-checked", "false");
  for (const k of ["select", "ripple", "roll", "slip", "slide"]) {
    const b = (await page.getByTestId(`tl-tool-${k}`).boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(43.5);
    expect(b.width).toBeGreaterThanOrEqual(43.5);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("ripple delete removes the selected clip and undo brings it back", async ({ page }) => {
  await page.goto("/?sample");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  const list = page.getByTestId("tl-clip-list").locator("li");
  const n = await list.count();
  await page.getByTestId("timeline-canvas").focus();
  await page.keyboard.press("Enter"); // pick the clip at the playhead
  await expect(page.getByTestId("tl-ripple-delete")).toBeEnabled(); // enabled once a clip is selected (the "selected" label is hidden on phones)
  await page.getByTestId("tl-ripple-delete").click();
  await expect(list).toHaveCount(n - 1);
  await page.keyboard.press("Control+z");
  await expect(list).toHaveCount(n);
});
