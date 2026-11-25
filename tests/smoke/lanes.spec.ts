import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { gutterShift } from "./timeline-geometry";

/** Multi-track (M2): a clip can be put on another track by dragging it, by keyboard, and by dropping a media card on the lane. Mouse paths: desktop only. */
const media = resolve("crates/media/tests/fixtures", "h264_aac.mp4");

async function withSecondVideoTrack(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await page.getByTestId("media-input").setInputFiles(media);
  await expect(page.locator("#tl-summary")).toContainText("2 tracks, 2 clips", { timeout: 30_000 });
  await page.getByTestId("tl-add-track").click();
  await page.getByTestId("track-add-video").click();
  await expect(page.locator("#tl-summary")).toContainText("3 tracks");
}
const onV2 = (page: Page) => page.getByTestId("tl-clip-list").locator("li", { hasText: "V2" });

test("dragging a clip up onto the new V2 lane puts its picture there (its sound stays on A1); one undo puts it back", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "mouse drag");
  await withSecondVideoTrack(page);
  await expect(onV2(page)).toHaveCount(0);
  const box = (await page.getByTestId("timeline-canvas").boundingBox())!;
  const dg = await gutterShift(page);
  // V2 is the top row (0), V1 row 1, A1 row 2; the imported picture starts at 0:00 on V1.
  const x = box.x + dg + 48 + 40;
  await page.mouse.move(x, box.y + 30 + 52 + 26);
  await page.mouse.down();
  await page.mouse.move(x + 10, box.y + 30 + 52 + 10, { steps: 4 });
  await page.mouse.move(x + 10, box.y + 30 + 26, { steps: 6 });
  await page.mouse.up();
  await expect(onV2(page)).toHaveCount(1);
  await expect(page.getByTestId("tl-clip-list").locator("li", { hasText: "A1" })).toHaveCount(1); // the sound did not move
  await page.keyboard.press("Control+z");
  await expect(onV2(page)).toHaveCount(0);
});

test("keyboard: Alt+Up moves the selected clip to the track above, Alt+Down back", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "adding the track needs the desktop toolbar");
  await withSecondVideoTrack(page);
  await page.getByTestId("timeline-canvas").focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Alt+ArrowUp");
  await expect(onV2(page)).toHaveCount(1);
  await page.keyboard.press("Alt+ArrowDown");
  await expect(onV2(page)).toHaveCount(0);
});

test("dropping a media card on the V2 lane lands on V2 at the pointer", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "HTML5 drag and drop is a mouse path");
  await withSecondVideoTrack(page);
  await page.getByTestId("bin-item").first().dragTo(page.getByTestId("timeline-canvas"), { targetPosition: { x: 420, y: 30 + 26 } });
  await expect(page.locator("#tl-summary")).toContainText("4 clips");
  await expect(onV2(page)).toHaveCount(1);
});
