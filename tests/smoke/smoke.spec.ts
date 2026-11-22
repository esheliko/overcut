import { expect, test } from "@playwright/test";

test("the app loads and the WebAssembly engine answers", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByTestId("engine")).toContainText(/Engine .+ v\d+\.\d+\.\d+ \(wasm\)/, { timeout: 30_000 });
  expect(errors).toEqual([]);
});

test("no horizontal scrolling at any width (works on every screen)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("engine")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("the page is cross-origin isolated (needed for threaded WebAssembly)", async ({ page }) => {
  await page.goto("/");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
});

test("the editor shell adapts: tabs on a phone, all four areas on larger screens", async ({ page }, info) => {
  await page.goto("/");
  const phone = (page.viewportSize()?.width ?? 0) < 720;
  const panels = ["media", "preview", "timeline", "inspector"];
  if (phone) {
    await expect(page.getByRole("tablist")).toBeVisible();
    await expect(page.getByTestId("panel-preview")).toBeVisible();
    await expect(page.getByTestId("panel-timeline")).toBeHidden();
    await page.getByRole("tab", { name: "Timeline" }).click();
    await expect(page.getByTestId("panel-timeline")).toBeVisible();
    await expect(page.getByTestId("panel-preview")).toBeHidden();
    const box = await page.getByRole("tab", { name: "Timeline" }).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44); // touch target
  } else {
    await expect(page.getByRole("tablist")).toBeHidden();
    for (const p of panels) await expect(page.getByTestId(`panel-${p}`)).toBeVisible();
  }
  expect(info.project.name).toMatch(/desktop|phone/);
});
