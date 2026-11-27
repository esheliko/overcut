import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { gutterShift } from "./timeline-geometry";

/** Edit tools (TL-04, M2-045): the tool picker in the one toolbar row (touch has no modifier keys), ripple delete, and Escape back to Select. */
test("the tool picker names the tool, tints when it is not Select, and Esc on the timeline returns to Select", async ({ page }) => {
  await page.goto("/?sample");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  const picker = page.getByTestId("tl-tool");
  await expect(picker).toHaveText(/Select/);
  await expect(picker).toHaveAttribute("data-tool", "select");
  await picker.click();
  for (const k of ["select", "ripple", "roll", "slip", "slide"]) {
    const b = (await page.getByTestId(`tl-tool-${k}`).boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(test.info().project.name === "phone" ? 43.5 : 31.5); // 32 px desktop density with a mouse (V-11)
    expect(b.x + b.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  }
  await page.getByTestId("tl-tool-slip").click();
  await expect(picker).toHaveAttribute("data-tool", "slip");
  await expect(picker).toHaveClass(/on/); // tinted: nobody is stuck in a tool without noticing
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
  await expect(page.locator("#tl-summary")).toContainText("2 clips");
  await expect(page.locator(".canvas")).toHaveAttribute("data-loaded", "true");
  const canvas = page.getByTestId("timeline-canvas");
  const box = (await canvas.boundingBox())!;
  const pps = Number(await canvas.getAttribute("data-pps"));
  const gutter = 48 + (await gutterShift(page)), ruler = 30, lane = 52;
  await page.mouse.click(box.x + gutter + 0.5 * pps, box.y + ruler / 2); // playhead in the middle of the 1 s clip
  await page.getByRole("button", { name: "Split at playhead" }).click();
  await expect(page.locator("#tl-summary")).toContainText("4 clips");
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
