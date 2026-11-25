import { expect, test } from "@playwright/test";

/** Command palette (M2-041): Ctrl/Cmd+K or the visible button / app-menu row, type to find, Enter runs; recent first; works at 320 px. */
test("Ctrl+K opens the palette, typing finds a command, Enter runs it, the next open lists it first", async ({ page }) => {
  await page.goto("/?sample");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect(page.locator("#tl-summary")).toContainText("Untitled project: 2 tracks");
  await page.getByTestId("timeline-canvas").focus();
  await page.keyboard.press("Control+k");
  const input = page.getByTestId("palette-input");
  await expect(input).toBeFocused();
  await input.fill("ripple trim");
  await expect(page.getByTestId("pal-tool.ripple")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect(page.getByTestId("tl-tool")).toHaveAttribute("data-tool", "ripple");
  await page.keyboard.press("Control+k");
  await expect(page.locator('[data-testid="palette"] [role="option"]').first()).toHaveAttribute("data-testid", "pal-tool.ripple"); // recent first
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("palette")).toHaveCount(0);
});

test("the palette opens from the app menu and fits the screen at 320 px, input and rows 44 px high", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/?sample");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByTestId("menu-palette").click();
  const dlg = (await page.getByTestId("palette").boundingBox())!;
  expect(dlg.x).toBeGreaterThanOrEqual(0);
  expect(dlg.x + dlg.width).toBeLessThanOrEqual(320);
  expect((await page.getByTestId("palette-input").boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
  expect((await page.locator('[data-testid="palette"] [role="option"]').first().boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test("the visible top-bar button opens it (wide screens)", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "the button is hidden on phones; the app menu row covers them");
  await page.goto("/?sample");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await page.getByTestId("palette-open").click();
  await expect(page.getByTestId("palette-input")).toBeFocused();
});
