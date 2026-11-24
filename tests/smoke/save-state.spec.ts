import { expect, test } from "@playwright/test";

/** F1 (saved state): the top bar says "Saved on this device" once the project is open, in words (not colour alone). Desktop shows it in the top bar; phone shows it in the ⋯ menu. */
test("the top bar says the project is saved on this device once it is open", async ({ page }) => {
  await page.goto("/?e2e");
  const state = page.getByTestId("save-state");
  await expect(state).toContainText("Saved on this device", { timeout: 30_000 });
  await expect(state).toHaveAttribute("data-state", "saved");
});
