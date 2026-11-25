import { expect, test } from "@playwright/test";
import { gutterShift } from "./timeline-geometry";

/** Drag to reorder (M2): dragging a clip past its neighbour's middle swaps them as one undo step; a short drag only slides, and a guide shows where it lands. */
test("mouse: dragging the second clip over the first reorders them; one undo puts them back", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "mouse drag; the touch pick-up is covered by the unit tests");
  await page.goto("/?sample");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  const canvas = page.getByTestId("timeline-canvas");
  const first = page.getByTestId("tl-clip-list").locator("li").first();
  const before = await first.textContent();
  // Sample at 40 px/s: gutter 48, ruler 30, lane 52. Clip 0 spans x 48..168, clip 1 x 218..478 on the first video track.
  const box = (await canvas.boundingBox())!;
  const y = box.y + 30 + 26;
  const dg = await gutterShift(page);
  await page.mouse.move(box.x + dg + 348, y);
  await page.mouse.down();
  await page.mouse.move(box.x + dg + 330, y, { steps: 3 }); // a short slide: no reorder yet
  await page.mouse.move(box.x + dg + 190, y, { steps: 12 }); // past the middle of clip 0
  await page.mouse.up();
  await expect(first).not.toHaveText(before!);
  await page.keyboard.press("Control+z");
  await expect(first).toHaveText(before!);
});

test("mouse: a drag that stays short of the neighbour's middle does not reorder", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "mouse drag");
  await page.goto("/?sample");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  const first = page.getByTestId("tl-clip-list").locator("li").first();
  const before = await first.textContent();
  const box = (await page.getByTestId("timeline-canvas").boundingBox())!;
  const y = box.y + 30 + 26;
  const dg = await gutterShift(page);
  await page.mouse.move(box.x + dg + 348, y);
  await page.mouse.down();
  await page.mouse.move(box.x + dg + 300, y, { steps: 6 });
  await page.mouse.up();
  await expect(first).toHaveText(before!);
});
