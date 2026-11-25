import { expect, test } from "@playwright/test";
import { gutterShift } from "./timeline-geometry";
const UNDO = /^Undo( (?!recovery).+)?$/, REDO = /^Redo( .+)?$/; // the label names the step ("Undo import of clip.mp4")

test("the app loads and the WebAssembly engine answers", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  expect(errors).toEqual([]);
});

test("no horizontal scrolling at any width (works on every screen)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("engine")).toBeAttached();
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
    await expect(page.getByTestId("panel-tool").getByRole("heading", { name: "Media" })).toBeVisible();
  }
  expect(info.project.name).toMatch(/desktop|phone/);
  // M1 shows only tools that work: no Audio, Text, Captions, Effects... promises.
  await expect(tools.getByRole("button")).toHaveCount(1);
});

test("transport and timeline: play advances the playhead, the canvas timeline paints", async ({ page }) => {
  await page.goto("/?sample");
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
});

test("canvas: an empty project's preview takes the chosen shape from the canvas settings", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("canvas-open")).toBeEnabled({ timeout: 30_000 });
  const canvas = page.locator(".canvas");
  const wide = (await canvas.boundingBox())!;
  await page.getByTestId("canvas-open").click();
  await page.getByTestId("canvas-shape").selectOption("9:16");
  await page.getByTestId("canvas-apply").click();
  await expect.poll(async () => (await canvas.boundingBox())!.height > (await canvas.boundingBox())!.width).toBe(true);
  expect(wide.width).toBeGreaterThan(wide.height);
});

test("device check: reachable from the menu, shows capabilities, runs the test, fits the screen, makes no outside requests", async ({ page }) => {
  test.setTimeout(480_000);
  const outside: string[] = [];
  const origin = new URL(page.url() === "about:blank" ? "http://localhost" : page.url()).origin;
  page.on("request", (r) => { const u = new URL(r.url()); if (/^https?:$/.test(u.protocol) && u.hostname !== new URL(test.info().project.use.baseURL ?? origin).hostname) outside.push(r.url()); });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/");
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("menuitem", { name: "About OverCut" }).click();
  await expect(page.getByTestId("diagnostics")).toBeVisible();
  await expect(page.getByRole("heading", { name: "What this device supports" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Video", exact: true })).toBeVisible({ timeout: 30_000 });

  const run = page.getByTestId("run-test");
  expect((await run.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  await run.click();
  // headless CI often has no GPU or hardware codecs: every test must still END with a readable answer, never hang or crash
  await expect(page.getByTestId("copy")).toBeVisible({ timeout: 420_000 });
  await expect(page.getByTestId("results").locator("li")).toHaveCount(6);
  const report = JSON.parse(await page.getByTestId("report").inputValue());
  expect(report.overcut_device_report).toBe(1);
  expect(Object.keys(report.tests)).toEqual(["decode", "seek", "gpuUpload", "fillRate", "playback", "exportSpeed"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
  expect(outside).toEqual([]);
});

test("theme: follows the system, the toggle overrides it, the choice is remembered, and the page never scrolls sideways", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "light");
  const toggle = page.getByTestId("theme-toggle");
  // Below 480 px the toggle lives in the "..." menu (it stays open while the toggle is used).
  if (!(await toggle.isVisible())) await page.getByRole("button", { name: "Menu" }).click();
  // F3: the toggle opens a small menu (System, Dark, Light, High contrast). Esc closes it and gives focus back to the toggle.
  if (await toggle.isVisible()) {
    await toggle.click();
    await expect(page.getByTestId("theme-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("theme-menu")).toHaveCount(0);
    await expect(toggle).toBeFocused();
    await toggle.click();
  }
  await page.getByRole("menuitemradio", { name: "Dark" }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  if (await toggle.isVisible()) await toggle.click();
  await page.getByRole("menuitemradio", { name: "High contrast" }).click();
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
});

test("timeline editing: select, split, delete, undo and redo go through the engine", async ({ page }, info) => {
  const phone = info.project.name === "phone";
  await page.goto("/?sample");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  const summary = page.locator("#tl-summary");
  const live = page.locator('[data-announcer="polite"]');
  const canvas = page.getByTestId("timeline-canvas");
  const undo = page.getByRole("button", { name: UNDO });
  const redo = page.getByRole("button", { name: REDO });
  await expect(summary).toContainText("2 tracks, 14 clips");
  await expect(undo).toBeDisabled();
  await expect(page.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();

  // Sample layout at the default zoom (40 px/s): gutter 48 px, ruler 30 px, lane 52 px; the first video clip spans x 48..168.
  const box = (await canvas.boundingBox())!;
  const dg = await gutterShift(page);
  const at = async (x: number, y: number) => (phone ? page.touchscreen.tap(box.x + dg + x, box.y + y) : page.mouse.click(box.x + dg + x, box.y + y));
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
  await page.mouse.move(box.x + dg + 108, box.y + 56);
  await page.mouse.down();
  await page.mouse.move(box.x + dg + 130, box.y + 56, { steps: 4 });
  await page.mouse.move(box.x + dg + 148, box.y + 56, { steps: 4 });
  await page.mouse.up();
  await expect(live).toContainText("Moved");
  await expect(undo).toBeEnabled();
  await page.mouse.move(box.x + dg + 206, box.y + 56); // its end handle (clip now spans 88..208)
  await page.mouse.down();
  await page.mouse.move(box.x + dg + 166, box.y + 56, { steps: 6 });
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

test("the timeline toolbar is ONE row that fits at 320 and 390 px: undo, redo, split, delete, tool picker and More inside the viewport, 44 px on touch", async ({ page }, info) => {
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    await expect(page.getByTestId("tl-more")).toBeVisible();
    const rows = new Set<number>();
    for (const b of [page.getByRole("button", { name: /^Undo/ }), page.getByRole("button", { name: /^Redo/ }), page.getByRole("button", { name: "Split at playhead" }), page.getByRole("button", { name: /^Delete/ }), page.getByTestId("tl-tool"), page.getByTestId("tl-more")]) {
      await expect(b).toBeVisible();
      const box = (await b.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      rows.add(Math.round((box.y + box.height / 2) / 10)); // centres on one line (desktop and touch targets differ in height)
      if (info.project.name === "phone") { expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44); } // desktop pointers use a 36 px target
    }
    expect(rows.size).toBe(1); // one row
    if (width >= 360) await expect(page.getByTestId("tl-fit")).toBeVisible(); // zoom: pinch, Fit here, +/- in the More menu
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  }
});

test("top bar on a small phone: project name truncates but stays editable, Export visible, targets >= 44 px, theme and status in the menu", async ({ page }, info) => {
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 700 });
    await page.goto("/");
    await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
    const name = page.getByLabel("Project name");
    const exp = page.getByTestId("export-open");
    await expect(exp).toBeVisible();
    for (const box of [await name.boundingBox(), await exp.boundingBox(), await page.getByRole("button", { name: "Menu" }).boundingBox()]) expect(box!.height).toBeGreaterThanOrEqual(info.project.name === "phone" ? 43.5 : 35.5); // desktop pointers use a 36 px target
    const [n, e] = [(await name.boundingBox())!, (await exp.boundingBox())!];
    expect(n.x + n.width).toBeLessThanOrEqual(e.x + 0.5); // the name never runs under Export
    expect(n.width).toBeGreaterThan(80);
    await name.fill("A very long project name that cannot possibly fit in the bar");
    await expect(name).toHaveValue("A very long project name that cannot possibly fit in the bar");
    await page.getByRole("button", { name: "Menu" }).click();
    await expect(page.getByRole("menuitemradio", { name: "High contrast" })).toBeVisible(); // F3: the phone menu lists the theme choices
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  }
});

// M1-030: one deliberate layout per form-factor profile (docs/features/editor-layouts.md). The test sets its own viewport, so it runs once.
const PROFILES = [
  { name: "phone-portrait", w: 390, h: 844, inspector: false, docked: false },
  { name: "phone-portrait", w: 320, h: 568, inspector: false, docked: false },
  { name: "phone-landscape", w: 844, h: 390, inspector: false, docked: false },
  { name: "tablet", w: 820, h: 1180, inspector: false, docked: true },
  { name: "tablet", w: 1024, h: 768, inspector: false, docked: true },
  { name: "desktop", w: 1280, h: 800, inspector: false, docked: true },
  { name: "ultrawide", w: 3440, h: 1440, inspector: false, docked: true },
] as const;
for (const p of PROFILES) {
  test(`layout profile ${p.name} at ${p.w}x${p.h}: panels arranged, no overlap, no horizontal scroll, 44 px touch targets`, async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "sets its own viewport");
    await page.setViewportSize({ width: p.w, height: p.h });
    await page.goto("/");
    await expect(page.getByTestId("editor")).toHaveAttribute("data-profile", p.name);
    const box = async (id: string) => (await page.getByTestId(id).boundingBox())!;
    const preview = await box("panel-preview");
    const timeline = await box("panel-timeline");
    const tools = (await page.getByRole("navigation", { name: "Tools" }).boundingBox())!;
    for (const b of [preview, timeline, tools]) {
      expect(b.width).toBeGreaterThan(40);
      expect(b.height).toBeGreaterThan(40);
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(p.w + 0.5);
      expect(b.y + b.height).toBeLessThanOrEqual(p.h + 0.5);
    }
    const overlap = (a: typeof preview, b: typeof preview) => a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;
    expect(overlap(preview, timeline)).toBe(false);
    expect(overlap(preview, tools)).toBe(false);
    expect(overlap(timeline, tools)).toBe(false);
    expect(preview.height).toBeGreaterThan(p.h * 0.2); // the preview is never squeezed out
    expect(timeline.height).toBeGreaterThan(100);
    expect(await page.getByTestId("panel-inspector").count()).toBe(p.inspector ? 1 : 0);
    if (p.docked) await expect(page.getByTestId("panel-tool")).toBeVisible();
    else await expect(page.getByTestId("panel-tool")).toBeHidden();
    if (p.name === "phone-landscape") { // tools rail on the left, tool panel opens as a side drawer over the preview
      expect(tools.x + tools.width).toBeLessThanOrEqual(preview.x + 1);
      await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click();
      await expect.poll(async () => (await box("panel-tool")).x).toBeGreaterThanOrEqual(tools.x + tools.width - 1); // after the slide-in
      const drawer = await box("panel-tool");
      expect(drawer.y + drawer.height).toBeLessThanOrEqual(p.h + 0.5);
      expect(drawer.width).toBeLessThanOrEqual(p.w * 0.53);
      await page.getByRole("button", { name: "Close panel" }).first().click();
    }
    for (const b of await page.getByRole("navigation", { name: "Tools" }).getByRole("button").all()) {
      const r = (await b.boundingBox())!;
      if (r.x + r.width <= p.w && r.y + r.height <= p.h) expect(Math.min(r.width, r.height)).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });
}

test("holding Shift after selecting a clip does not outline the whole timeline; Shift+click still toggles the clip", async ({ page }) => {
  await page.goto("/?sample");
  await expect(page.locator("#tl-summary")).toContainText("2 tracks, 14 clips");
  const box = (await page.getByTestId("timeline-canvas").boundingBox())!;
  const dg = await gutterShift(page);
  const stageFrame = () => page.evaluate(() => getComputedStyle(document.querySelector(".tl-stage")!, "::after").boxShadow);
  await page.mouse.click(box.x + dg + 108, box.y + 26 + 26); // the first clip, as in the editing test
  await expect(page.getByTestId("tl-selected")).toHaveText("1 selected");
  await page.keyboard.down("Shift");
  expect(await stageFrame()).toBe("none"); // the keyboard focus frame must not appear for a bare modifier
  await page.mouse.click(box.x + dg + 108, box.y + 26 + 26);
  await page.keyboard.up("Shift");
  await expect(page.getByTestId("tl-selected")).toHaveCount(0); // Shift+click on a selected clip still toggles it off
});
