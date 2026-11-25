import { expect, test } from "@playwright/test";

/** Edit tools (TL-04, M2-045): the tool picker in the one toolbar row (touch has no modifier keys), ripple delete, and Escape back to Select. */
test("the tool picker names the tool, tints when it is not Select, and Esc on the timeline returns to Select", async ({ page }) => {
  await page.goto("/?sample");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  const picker = page.getByTestId("tl-tool");
  await expect(picker).toHaveText(/Select/);
  await expect(picker).toHaveAttribute("data-tool", "select");
  await picker.click();
  for (const k of ["select", "ripple", "roll", "slip", "slide"]) {
    const b = (await page.getByTestId(`tl-tool-${k}`).boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(43.5);
    expect(b.x + b.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  }
  await page.getByTestId("tl-tool-slip").click();
  await expect(picker).toHaveAttribute("data-tool", "slip");
  await expect(picker).toHaveClass(/on/); // tinted: nobody is stuck in a tool without noticing
  await picker.click();
  await expect(page.getByTestId("tl-tool-slip")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape"); // closes the menu
  await expect(page.getByTestId("tl-tool-menu")).toHaveCount(0);
  await page.getByTestId("timeline-canvas").focus();
  await page.keyboard.press("Escape"); // back to Select
  await expect(picker).toHaveAttribute("data-tool", "select");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("ripple delete (More menu) removes the selected clip and undo brings it back", async ({ page }) => {
  await page.goto("/?sample");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  const list = page.getByTestId("tl-clip-list").locator("li");
  const n = await list.count();
  await page.getByTestId("timeline-canvas").focus();
  await page.keyboard.press("Enter"); // pick the clip at the playhead
  await page.getByTestId("tl-more").click();
  await page.getByTestId("tl-ripple-delete-menu").click();
  await expect(list).toHaveCount(n - 1);
  await page.keyboard.press("Control+z");
  await expect(list).toHaveCount(n);
});
