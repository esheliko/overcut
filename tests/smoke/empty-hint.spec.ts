import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

/** An empty timeline says what to do and why Export is off; the hint goes away with the first clip and never causes sideways scrolling. */
test("empty timeline shows the start hint, hides it once a clip is in", async ({ page }, info) => {
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect(page.getByTestId("preview-import")).toBeEnabled({ timeout: 20_000 });
  const hint = page.getByTestId("tl-empty");
  await expect(hint).toBeVisible();
  await expect(hint).toContainText("Export turns on");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/claude-0/-home-user-overcut/d1542f7e-6dcf-52b8-b7c1-efef7b6b1a0e/scratchpad/empty-" + info.project.name + ".png" });
  if (info.project.name === "phone") await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click();
  await page.getByTestId("media-input").setInputFiles(resolve("crates/media/tests/fixtures/flash_click.mp4"));
  await expect(page.locator("#tl-summary")).toContainText("2 clips");
  await expect(hint).toHaveCount(0);
});

test("tablet top bar: the saved status is shown whole, or as its dot with the words kept for screen readers, never cut to 'Saved o…'", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "tablet width");
  const text = page.locator('[data-testid="save-state"] .chip-text');
  const whole = () => text.evaluate((el) => el.scrollWidth <= el.clientWidth);
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect(text).toBeVisible();
  expect(await whole()).toBe(true);
  await page.setViewportSize({ width: 820, height: 1180 }); // narrower than ~900 px of editor: the chip keeps only its dot (M1), the text stays for screen readers
  await expect(page.getByTestId("save-state")).toBeVisible();
  await expect(text).toHaveText(/\S/);
  expect((await text.boundingBox())!.width).toBeLessThanOrEqual(1);
});
