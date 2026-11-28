import { expect, test } from "@playwright/test";

/** Round 11 (timeline feel): touch comfort. */
test("touch: the timeline zoom slider is a 44 px target (coarse pointer)", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "needs a coarse pointer");
  await page.setViewportSize({ width: 820, height: 1180 }); // tablet width: the slider is in the bar there, not in More
  await page.goto("/?sample");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  const box = await page.getByRole("slider", { name: "Timeline zoom" }).boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
});
