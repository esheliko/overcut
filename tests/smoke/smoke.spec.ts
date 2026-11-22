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

test("the editor shell adapts: tool bar and sheet on a phone, tool panel always open on larger screens", async ({ page }, info) => {
  await page.goto("/");
  const phone = (page.viewportSize()?.width ?? 0) < 720;
  await expect(page.getByTestId("panel-preview")).toBeVisible();
  await expect(page.getByTestId("panel-timeline")).toBeVisible();
  const tools = page.getByRole("navigation", { name: "Tools" });
  await expect(tools).toBeVisible();
  const box = await tools.getByRole("button", { name: "Media" }).boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44); // touch target
  if (phone) {
    await expect(page.getByTestId("panel-tool")).toBeHidden();
    await tools.getByRole("button", { name: "Media" }).click();
    await expect(page.getByTestId("panel-tool")).toBeVisible();
    await page.getByRole("button", { name: "Close panel" }).click();
    await expect(page.getByTestId("panel-tool")).toBeHidden();
  } else {
    await expect(page.getByTestId("panel-tool")).toBeVisible();
    await tools.getByRole("button", { name: "Effects" }).click();
    await expect(page.getByTestId("panel-tool").getByRole("heading", { name: "Effects" })).toBeVisible();
  }
  expect(info.project.name).toMatch(/desktop|phone/);
});

test("transport and timeline: play advances the playhead, the aspect ratio changes the preview", async ({ page }) => {
  await page.goto("/");
  const playhead = page.getByRole("slider", { name: "Playhead position" });
  await expect(playhead).toHaveAttribute("aria-valuenow", "0");
  await playhead.focus();
  await page.keyboard.press("ArrowRight");
  await expect(playhead).toHaveAttribute("aria-valuenow", "1");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => Number(await playhead.getAttribute("aria-valuenow"))).toBeGreaterThan(5);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  // Canvas timeline: summary for assistive tech, painted pixels (not blank), keyboard zoom keeps working.
  await expect(page.locator("#tl-summary")).toContainText("2 tracks, 14 clips");
  const painted = () => page.getByTestId("timeline-canvas").evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    const seen = new Set<number>();
    for (let i = 0; i < d.length; i += 4 * 97) seen.add((d[i]! << 16) | (d[i + 1]! << 8) | d[i + 2]!);
    return seen.size;
  });
  await expect.poll(painted).toBeGreaterThan(4);
  await playhead.focus();
  await page.keyboard.press("+");
  await page.keyboard.press("PageDown");
  await expect.poll(painted).toBeGreaterThan(4);
  const canvas = page.locator(".canvas");
  const wide = (await canvas.boundingBox())!;
  await page.getByLabel("Aspect ratio").selectOption("9:16");
  await expect.poll(async () => (await canvas.boundingBox())!.height > (await canvas.boundingBox())!.width).toBe(true);
  expect(wide.width).toBeGreaterThan(wide.height);
});
