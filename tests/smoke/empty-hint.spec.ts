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
