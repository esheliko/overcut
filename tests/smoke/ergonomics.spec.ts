import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { gutterShift } from "./timeline-geometry";

/** M2 UX round 12 (ergonomics): drag-scrub on the number itself in Details, arrow-key nudge of the picture on the preview. Desktop (mouse + keyboard). */
const FLASH = resolve("crates/media/tests/fixtures/flash_click.mp4");
const UNDO = /^Undo( (?!recovery).+)?$/;

async function selectedClip(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect(page.getByTestId("preview-import")).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId("media-input").setInputFiles(FLASH);
  await expect(page.locator("#tl-summary")).toContainText("1 clip");
  await expect(page.locator(".canvas")).toHaveAttribute("data-loaded", "true");
  const box = (await page.getByTestId("timeline-canvas").boundingBox())!;
  await page.mouse.click(box.x + (await gutterShift(page)) + 68, box.y + 56);
  await expect(page.getByTestId("insp-position_x")).toBeVisible();
}

test("Details: dragging the number scrubs it (Shift x10, Alt x0.1), Escape cancels, one drag is one undo step, a tap still types", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "mouse drag");
  await selectedClip(page);
  const x = page.getByTestId("insp-position_x");
  const b = (await x.boundingBox())!;
  const [cx, cy] = [b.x + b.width / 2, b.y + b.height / 2];
  await expect(x).toHaveCSS("cursor", "ew-resize");

  // 40 px = 10 steps of 1 %.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 40, cy, { steps: 6 });
  await page.mouse.up();
  await expect(x).toHaveValue("10");
  await expect(x).not.toBeFocused(); // a drag does not open the field for typing
  // Shift = x10, Alt = x0.1.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.keyboard.down("Shift");
  await page.mouse.move(cx + 8, cy, { steps: 4 });
  await page.keyboard.up("Shift");
  await page.mouse.up();
  await expect(x).toHaveValue("30"); // 10 + (8 / 4) * 1 * 10
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.keyboard.down("Alt");
  await page.mouse.move(cx + 8, cy, { steps: 4 });
  await page.keyboard.up("Alt");
  await page.mouse.up();
  await expect(x).toHaveValue("30.2");

  // One drag = one undo step: undo goes back to the value before that drag, not to 0.
  await page.getByRole("button", { name: UNDO }).click();
  await expect(x).toHaveValue("30");
  await page.getByRole("button", { name: UNDO }).click();
  await expect(x).toHaveValue("10");

  // Escape during the drag puts the old value back.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 40, cy, { steps: 6 });
  await expect(x).toHaveValue("20");
  await page.keyboard.press("Escape");
  await expect(x).toHaveValue("10");
  await page.mouse.move(cx + 80, cy, { steps: 4 });
  await page.mouse.up();
  await expect(x).toHaveValue("10");

  // A tap focuses the field with its text selected: type a value.
  await page.mouse.click(cx, cy);
  await expect(x).toBeFocused();
  await expect(x).toHaveCSS("cursor", "text");
  await page.keyboard.type("5");
  await expect(x).toHaveValue("5");
  // Arrow keys step by the field's step; Shift x10.
  await page.keyboard.press("ArrowUp");
  await expect(x).toHaveValue("6");
  await page.keyboard.press("Shift+ArrowUp");
  await expect(x).toHaveValue("16");
});

test("preview: arrow keys nudge the selected picture 1 px (Shift 10 px), a burst is one undo step, the playhead stays", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "keyboard");
  await selectedClip(page);
  const x = page.getByTestId("insp-position_x");
  const y = page.getByTestId("insp-position_y");
  const body = page.getByTestId("transform-body");
  await expect(body).toBeVisible();
  const head = await page.getByTestId("timecode").textContent();
  await body.focus();
  await expect(body).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  await expect.poll(async () => Number(await x.inputValue())).toBeGreaterThan(0);
  await expect.poll(async () => Number(await y.inputValue())).toBeGreaterThan(Number(await x.inputValue()));
  expect(await page.getByTestId("timecode").textContent()).toBe(head); // arrows did not step the playhead
  // One burst = one undo step.
  await page.getByRole("button", { name: UNDO }).click();
  await expect(x).toHaveValue("0");
  await expect(y).toHaveValue("0");
});

test("an edit leaves a brief cue on the timeline (off under reduced motion), tooltips name the tool and its key, the tool cursor shows", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "keyboard");
  await selectedClip(page);
  const canvas = page.getByTestId("timeline-canvas");
  await canvas.focus();
  await page.keyboard.press("Alt+Shift+ArrowRight");
  await page.keyboard.press("s");
  await expect(canvas).toHaveAttribute("data-cue", "split");
  await expect(canvas).not.toHaveAttribute("data-cue", /.+/, { timeout: 2000 }); // it ends by itself within a third of a second
  await expect(page.getByTestId("tl-tool")).toHaveAttribute("aria-label", "Edit tool: Select. Change tool");
  await expect(page.getByTestId("tl-tool").locator("xpath=..").locator(".tb-tip")).toContainText("V"); // the tooltip names the key as a keycap
  await page.keyboard.press("y");
  await expect(page.getByTestId("tl-tool")).toHaveAttribute("aria-label", /Slip\. Change tool/);
  await expect(page.getByTestId("tl-tool").locator("xpath=..").locator(".tb-tip")).toContainText("Y");
  const b = (await canvas.boundingBox())!;
  await page.mouse.move(b.x + (await gutterShift(page)) + 68, b.y + 56, { steps: 3 });
  expect(await canvas.evaluate((el) => (el as HTMLElement).style.cursor)).toContain("data:image/svg+xml");
  await page.keyboard.press("Escape");
  // `,` and `.` nudge the selected clip and leave the playhead where it is (they step the playhead only with nothing selected).
  const tc = await page.getByTestId("timecode").textContent();
  await page.keyboard.press("Period");
  expect(await page.getByTestId("timecode").textContent()).toBe(tc);
});

test("reduced motion: no commit cue", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "keyboard");
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await selectedClip(page);
  const canvas = page.getByTestId("timeline-canvas");
  await canvas.focus();
  await page.keyboard.press("Alt+Shift+ArrowRight");
  await page.keyboard.press("s");
  await expect(page.locator("#tl-summary")).toContainText("2 clips");
  await expect(canvas).not.toHaveAttribute("data-cue", /.+/);
  await ctx.close();
});

test("Export opens at once once the engine is idle: no 300 ms Suspense wait", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "timing");
  await selectedClip(page);
  await page.waitForTimeout(1500); // the dialog's code is fetched when the browser is idle
  const ms = await page.evaluate(async () => {
    const t0 = performance.now();
    (document.querySelector('[data-testid="export-open"]') as HTMLButtonElement).click();
    while (!document.querySelector('[data-testid="export-dialog"]')) { await new Promise((r) => requestAnimationFrame(r)); if (performance.now() - t0 > 2000) break; }
    return performance.now() - t0;
  });
  expect(ms).toBeLessThan(150); // 318 ms before (React holds a re-suspended reveal back for 300 ms)
});
