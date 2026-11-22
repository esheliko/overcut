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
  const canvas = page.locator(".canvas");
  const wide = (await canvas.boundingBox())!;
  await page.getByLabel("Aspect ratio").selectOption("9:16");
  await expect.poll(async () => (await canvas.boundingBox())!.height > (await canvas.boundingBox())!.width).toBe(true);
  expect(wide.width).toBeGreaterThan(wide.height);
});

test("device check: reachable from the menu, shows capabilities, runs the test, fits the screen, makes no outside requests", async ({ page }) => {
  const outside: string[] = [];
  const origin = new URL(page.url() === "about:blank" ? "http://localhost" : page.url()).origin;
  page.on("request", (r) => { const u = new URL(r.url()); if (/^https?:$/.test(u.protocol) && u.hostname !== new URL(test.info().project.use.baseURL ?? origin).hostname) outside.push(r.url()); });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/");
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("menuitem", { name: "About / Diagnostics" }).click();
  await expect(page.getByTestId("diagnostics")).toBeVisible();
  await expect(page.getByRole("heading", { name: "What this device supports" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Video formats" })).toBeVisible({ timeout: 30_000 });

  const run = page.getByTestId("run-test");
  expect((await run.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  await run.click();
  // headless CI often has no GPU or hardware codecs: every test must still END with a readable answer, never hang or crash
  await expect(page.getByTestId("copy")).toBeVisible({ timeout: 240_000 });
  await expect(page.getByTestId("results").locator("li")).toHaveCount(4);
  const report = JSON.parse(await page.getByTestId("report").inputValue());
  expect(report.overcut_device_report).toBe(1);
  expect(Object.keys(report.tests)).toEqual(["decode", "seek", "gpuUpload", "fillRate"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
  expect(outside).toEqual([]);
});
