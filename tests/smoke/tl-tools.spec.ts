import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { gutterShift } from "./timeline-geometry";

/** Edit tools (TL-04, M2-045): the tool picker in the one toolbar row (touch has no modifier keys), ripple delete, and Escape back to Select. */
test("the tool picker names the tool, tints when it is not Select, and Esc on the timeline returns to Select", async ({ page }) => {
  await page.goto("/?sample");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  const picker = page.getByTestId("tl-tool");
  await expect(picker).toHaveAttribute("aria-label", /Select/); // an icon button now: the name is the label
  await expect(picker).toHaveAttribute("data-tool", "select");
  await picker.click();
  for (const k of ["select", "ripple", "roll", "slip", "slide"]) {
    const b = (await page.getByTestId(`tl-tool-${k}`).boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(test.info().project.name === "phone" ? 43.5 : 31.5); // 32 px desktop density with a mouse (V-11)
    expect(b.x + b.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  }
  await page.getByTestId("tl-tool-slip").click();
  await expect(picker).toHaveAttribute("data-tool", "slip");
  await expect(picker).toHaveAttribute("aria-pressed", "true"); // tinted: nobody is stuck in a tool without noticing
  await picker.click();
  await expect(page.getByTestId("tl-tool-slip")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape"); // closes the menu
  await expect(page.getByTestId("tl-tool-menu")).toHaveCount(0);
  await page.getByTestId("timeline-canvas").focus();
  await page.keyboard.press("Escape"); // back to Select
  await expect(picker).toHaveAttribute("data-tool", "select");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("ripple delete (More menu) removes the selected clip and undo brings it back", async ({ page }) => {
  await page.goto("/?sample");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  const list = page.getByTestId("tl-clip-list").locator("li");
  await expect(list).not.toHaveCount(0); // the sample project has opened (while it opens the timeline is empty)
  const n = await list.count();
  await page.getByTestId("timeline-canvas").focus();
  await page.keyboard.press("Enter"); // pick the clip at the playhead
  await page.getByTestId("tl-more").click();
  await page.getByTestId("tl-ripple-delete-menu").click();
  await expect(list).toHaveCount(n - 1);
  await page.keyboard.press("Control+z");
  await expect(list).toHaveCount(n);
});

/** Round 7/8: an Alt+drag slip on a split half used to do nothing and say nothing. Dragging the way the footage has run out now says so. */
test("Alt+drag slip on the right half of a split says there is no footage that way", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "Alt+drag needs a mouse");
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect(page.getByTestId("preview-import")).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId("media-input").setInputFiles(resolve("crates/media/tests/fixtures/flash_click.mp4"));
  await expect(page.locator("#tl-summary")).toContainText("1 clip");
  await expect(page.locator(".canvas")).toHaveAttribute("data-loaded", "true");
  const canvas = page.getByTestId("timeline-canvas");
  const box = (await canvas.boundingBox())!;
  const pps = Number(await canvas.getAttribute("data-pps"));
  const gutter = 48 + (await gutterShift(page)), ruler = 30, lane = 60;
  await page.mouse.click(box.x + gutter + 0.5 * pps, box.y + ruler / 2); // playhead in the middle of the 1 s clip
  await page.getByRole("button", { name: "Split at playhead" }).click();
  await expect(page.locator("#tl-summary")).toContainText("2 clips");
  const y = box.y + ruler + lane * 0.5;
  const x = box.x + gutter + 0.75 * pps; // inside the right half
  await page.keyboard.down("Alt");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 20, y, { steps: 4 }); // left = later footage; the right half of a split has none after it
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await expect(page.getByRole("status").filter({ hasText: /footage/ }).first()).toBeVisible();
});

test("tablet width: with a linked clip selected the toolbar tools, the selection pill and the zoom do not overlap", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "the pill is hidden on a phone; this is the 820 px layout");
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await page.getByTestId("media-input").setInputFiles(resolve("crates/media/tests/fixtures/flash_click.mp4"));
  await expect(page.locator("#tl-summary")).toContainText("1 clip", { timeout: 20_000 });
  await page.waitForTimeout(500); // the view fits the new clip
  const box = (await page.getByTestId("timeline-canvas").boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.5, box.y + 40);
  const pill = page.getByTestId("tl-selected");
  await expect(pill).toBeVisible();
  const [more, sel, zoomIn] = await Promise.all([page.getByTestId("tl-more").boundingBox(), pill.boundingBox(), page.getByRole("button", { name: "Zoom in" }).boundingBox()]);
  expect(more!.x + more!.width).toBeLessThanOrEqual(sel!.x + 1);
  expect(sel!.x + sel!.width).toBeLessThanOrEqual(zoomIn!.x + 1);
});

test("Add as overlay on a new track selects the new clip, so it can be sized at once", async ({ page }, info) => {
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await page.getByTestId("media-input").setInputFiles(resolve("crates/media/tests/fixtures/flash_click.mp4"));
  await expect(page.locator("#tl-summary")).toContainText("1 clip", { timeout: 20_000 });
  await expect(page.getByTestId("tl-selected")).toHaveCount(0);
  if (info.project.name === "phone") { await page.getByTestId("tl-more").click(); await page.getByTestId("tl-add-overlay").click(); }
  else await page.getByTestId("tl-overlay-btn").click(); // r15: a wide bar has the Overlay button, so More does not repeat it
  await page.getByTestId("overlay-choice").first().click(); // UX r15: "Add as overlay" asks which media (a picker) instead of picking one itself
  await expect(page.locator("#tl-summary")).toContainText("2 clips", { timeout: 20_000 });
  await expect(page.getByTestId("tl-selected")).toHaveText(/1 clip \+ linked audio/);
});

test("phone: the loop button and the time chip fade away while the on-canvas handles are up, and come back on deselect", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "the chips sit on the picture only on a phone");
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await page.getByTestId("media-input").setInputFiles(resolve("crates/media/tests/fixtures/flash_click.mp4"));
  await expect(page.locator("#tl-summary")).toContainText("1 clip", { timeout: 20_000 });
  const loop = page.getByTestId("loop-toggle"), tc = page.getByTestId("timecode");
  await page.getByTestId("tl-more").click();
  await page.getByTestId("tl-add-overlay").click(); // the new overlay is selected; on a phone its handles show while the Edit sheet is open
  await page.getByTestId("overlay-choice").first().click(); // UX r15: chosen in the overlay picker
  await expect(page.locator(".canvas.framed")).toBeVisible(); // r16 PHONE-1: the handles show for a selected clip with no sheet open
  await expect(loop).toBeHidden();
  await expect(tc).toBeHidden();
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="loop-toggle"]')!).pointerEvents)).toBe("none");
  // Deselect (the tool strip's Back): the handles go, the chips return.
  await page.getByTestId("strip-back").click();
  await expect(page.locator(".canvas.framed")).toHaveCount(0);
  await expect(loop).toBeVisible();
  await expect(tc).toBeVisible();
});
