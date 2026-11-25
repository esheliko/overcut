import { expect, test } from "@playwright/test";

/** The theme button sits in the top actions, before the ⋯ menu, on desktop; on a phone it lives in the ⋯ menu. The menu opens on screen. */
test.describe("theme button at 1280 px", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test("sits in the top actions, not beside the logo, and its menu stays on screen", async ({ page }) => {
    await page.goto("/?e2e");
    const toggle = page.getByTestId("theme-toggle");
    await expect(toggle).toBeVisible({ timeout: 30_000 });
    expect(await toggle.evaluate((el) => !!el.closest(".top-actions"))).toBe(true);
    expect(await toggle.evaluate((el) => !!el.closest(".brand"))).toBe(false);
    await toggle.click();
    const menu = page.getByTestId("theme-menu");
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(1280);
  });
});

test.describe("theme button at 390 px", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("is not in the top bar; it is in the ⋯ menu", async ({ page }) => {
    await page.goto("/?e2e");
    await expect(page.getByTestId("save-state")).toBeAttached({ timeout: 30_000 });
    expect(await page.locator('.top-actions [data-testid="theme-toggle"]').count()).toBe(0);
  });
});
