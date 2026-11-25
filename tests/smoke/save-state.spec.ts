import { expect, test } from "@playwright/test";

/** F1 (saved state): the top bar says "Saved on this device" once the project is open, in words (not colour alone). Desktop shows it in the top bar; phone shows it in the ⋯ menu. */
test("the top bar says the project is saved on this device once it is open", async ({ page }) => {
  await page.goto("/?e2e");
  const state = page.getByTestId("save-state");
  await expect(state).toContainText("Saved on this device", { timeout: 30_000 });
  await expect(state).toHaveAttribute("data-state", "saved");
});

/** The save chip is a dot below ~900 px of editor width (its words would cut mid-word), and words with room to spare. The text stays in the page for screen readers. */
for (const width of [820, 844]) {
  test.describe(`save chip at ${width} px`, () => {
    test.use({ viewport: { width, height: 900 } });
    test(`shows the dot only, not a cut-off "Saved on…"`, async ({ page }) => {
      await page.goto("/?e2e");
      const state = page.getByTestId("save-state");
      await expect(state).toContainText("Saved on this device", { timeout: 30_000 });
      const text = state.locator(".chip-text");
      expect((await text.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);
    });
  });
}

test.describe("save chip at 1280 px", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test("shows the words in full, not cut off", async ({ page }) => {
    await page.goto("/?e2e");
    const state = page.getByTestId("save-state");
    await expect(state).toContainText("Saved on this device", { timeout: 30_000 });
    const text = state.locator(".chip-text");
    await expect(text).toBeVisible();
    const cut = await text.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(cut).toBe(false);
  });
});
