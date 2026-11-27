import { expect, test } from "@playwright/test";

// r14 lane A: dark is the default on a first run, even when the system asks for light; an explicit choice still wins.
test.describe("first-run theme", () => {
  test.use({ colorScheme: "light" });
  test("opens dark on a first run and keeps an explicit light choice", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.evaluate(() => localStorage.setItem("overcut.theme", "light"));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.evaluate(() => localStorage.setItem("overcut.theme", "system"));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light"); // "follow the system" is a stored choice
  });
});

// The panels are flush: no gap or rounded card between the preview and the timeline on a wide screen.
test("the shell panels are flush (1 px dividers, no cards)", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 720, "the flush grid is the tablet and desktop layout");
  await page.goto("/");
  const stage = (await page.getByTestId("panel-preview").boundingBox())!;
  const tl = (await page.getByTestId("panel-timeline").boundingBox())!;
  expect(tl.y - (stage.y + stage.height)).toBeLessThanOrEqual(1);
  const radius = await page.getByTestId("panel-timeline").evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
  expect(radius).toBe("0px");
});
