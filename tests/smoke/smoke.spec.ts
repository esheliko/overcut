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

test("theme: follows the system, the toggle overrides it, the choice is remembered, and the page never scrolls sideways", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "light");
  const toggle = page.getByTestId("theme-toggle");
  // system -> dark -> light -> high-contrast -> system
  await toggle.click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await toggle.click();
  await toggle.click();
  await expect(html).toHaveAttribute("data-theme", "high-contrast");
  await expect(page.locator("[data-announcer=polite]")).toContainText("High contrast");
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "high-contrast");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("language and direction: the page declares lang and dir, and a right-to-left locale mirrors without overflow", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await page.evaluate(() => localStorage.setItem("overcut.locale", "en-XB"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en-XB");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  if ((page.viewportSize()?.width ?? 0) >= 720) {
    // the tool rail moves to the right edge; the preview is on its left
    const rail = (await page.getByRole("navigation").first().boundingBox())!;
    const stage = (await page.getByTestId("panel-preview").boundingBox())!;
    expect(rail.x).toBeGreaterThan(stage.x);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

test("timeline editing: select, split, delete, undo and redo go through the engine", async ({ page }, info) => {
  const phone = info.project.name === "phone";
  await page.goto("/");
  await expect(page.getByTestId("engine")).toContainText(/Engine .+ \(wasm\)/, { timeout: 30_000 });
  const summary = page.locator("#tl-summary");
  const live = page.locator('[data-announcer="polite"]');
  const canvas = page.getByTestId("timeline-canvas");
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  const redo = page.getByRole("button", { name: "Redo", exact: true });
  await expect(summary).toContainText("2 tracks, 14 clips");
  await expect(undo).toBeDisabled();
  await expect(page.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();

  // Sample layout at the default zoom (40 px/s): gutter 48 px, ruler 30 px, lane 52 px; the first video clip spans x 48..168.
  const box = (await canvas.boundingBox())!;
  const at = async (x: number, y: number) => (phone ? page.touchscreen.tap(box.x + x, box.y + y) : page.mouse.click(box.x + x, box.y + y));
  await at(108, 30 + 26); // select the first clip
  await expect(page.getByTestId("tl-selected")).toHaveText("1 selected");
  await expect(live).toContainText("Clip 1");
  await at(108, 10); // ruler: put the playhead inside it (1.5 s)
  await expect(page.getByRole("slider", { name: "Playhead position" })).toHaveAttribute("aria-valuenow", "45");

  await page.getByRole("button", { name: "Split at playhead" }).click();
  await expect(summary).toContainText("2 tracks, 15 clips");
  await expect(live).toContainText("Split 1 clip");
  await expect(undo).toBeEnabled();

  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(summary).toContainText("14 clips");
  await expect(live).toContainText("Deleted 1 clip");
  await expect(page.getByTestId("tl-selected")).toHaveCount(0);

  await undo.click();
  await expect(summary).toContainText("15 clips");
  await undo.click();
  await expect(summary).toContainText("14 clips");
  await expect(undo).toBeDisabled();
  await expect(redo).toBeEnabled();
  await redo.click();
  await expect(summary).toContainText("15 clips");
  await undo.click();
  await expect(summary).toContainText("14 clips");

  if (phone) return; // pointer drags and the keyboard are exercised on desktop; touch rules are covered by the unit tests
  // Drag the clip 1 s later (one undo step), trim its end by 1 s with the handle, then undo both.
  await page.mouse.move(box.x + 108, box.y + 56);
  await page.mouse.down();
  await page.mouse.move(box.x + 130, box.y + 56, { steps: 4 });
  await page.mouse.move(box.x + 148, box.y + 56, { steps: 4 });
  await page.mouse.up();
  await expect(live).toContainText("Moved");
  await expect(undo).toBeEnabled();
  await page.mouse.move(box.x + 206, box.y + 56); // its end handle (clip now spans 88..208)
  await page.mouse.down();
  await page.mouse.move(box.x + 166, box.y + 56, { steps: 6 });
  await page.mouse.up();
  await expect(live).toContainText("Trimmed end");
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await expect(undo).toBeDisabled();
  // Keyboard: Enter picks the clip at the playhead, arrows walk the selection, comma nudges a frame, Delete removes, Ctrl+Z restores.
  await canvas.focus();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("tl-selected")).toHaveText("1 selected");
  await page.keyboard.press("ArrowRight");
  await expect(live).toContainText("Clip 1");
  await page.keyboard.press("Period");
  await expect(live).toContainText("1 frame later");
  await page.keyboard.press("Delete");
  await expect(summary).toContainText("13 clips");
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await expect(summary).toContainText("14 clips");
  await expect(undo).toBeDisabled();
});
