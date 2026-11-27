import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { gutterShift } from "./timeline-geometry";

/** Multi-track (M2): a clip can be put on another track by dragging it, by keyboard, and by dropping a media card on the lane. Mouse paths: desktop only. */
const media = resolve("crates/media/tests/fixtures", "h264_aac.mp4");

async function withSecondVideoTrack(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await page.getByTestId("media-input").setInputFiles(media);
  await expect(page.locator("#tl-summary")).toContainText("2 tracks, 1 clip", { timeout: 30_000 });
  await page.getByTestId("tl-more").click();
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
  await expect(page.locator("#tl-summary")).toContainText("2 clips");
  await expect(onV2(page)).toHaveCount(1);
});

test("two selected pictures change lane together: both on V2, their sounds stay on A1, one undo puts both back", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "mouse drag");
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await page.getByTestId("media-input").setInputFiles(media);
  await expect(page.locator("#tl-summary")).toContainText("2 tracks, 1 clip", { timeout: 30_000 });
  // Split the picture and its sound in the middle: two pictures on V1, two sounds on A1.
  await page.getByTestId("timeline-canvas").focus();
  for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("s");
  await expect(page.locator("#tl-summary")).toContainText("2 clips");
  await page.getByTestId("tl-more").click();
  await page.getByTestId("track-add-video").click();
  await expect(page.locator("#tl-summary")).toContainText("3 tracks");
  await expect(onV2(page)).toHaveCount(0);
  const canvas = page.getByTestId("timeline-canvas");
  await canvas.focus();
  await page.keyboard.press("Control+a");
  const box = (await canvas.boundingBox())!;
  const dg = await gutterShift(page);
  const x = box.x + dg + 48 + 40;
  await page.mouse.move(x, box.y + 30 + 52 + 26);
  await page.mouse.down();
  await page.mouse.move(x + 10, box.y + 30 + 52 + 10, { steps: 4 });
  await page.mouse.move(x + 10, box.y + 30 + 26, { steps: 6 });
  await page.mouse.up();
  await expect(onV2(page)).toHaveCount(2);
  await expect(page.getByTestId("tl-clip-list").locator("li", { hasText: "A1" })).toHaveCount(2);
  await page.keyboard.press("Control+z");
  await expect(onV2(page)).toHaveCount(0);
});

test("a lane change that also moves in time lands where dropped; the sound that would clash goes to a new A2; one undo", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "mouse drag");
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await page.getByTestId("media-input").setInputFiles(media);
  await expect(page.locator("#tl-summary")).toContainText("2 tracks, 1 clip", { timeout: 30_000 });
  const canvas = page.getByTestId("timeline-canvas");
  await canvas.focus();
  for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("s");
  await expect(page.locator("#tl-summary")).toContainText("2 clips");
  await page.getByTestId("tl-more").click();
  await page.getByTestId("track-add-video").click();
  await expect(page.locator("#tl-summary")).toContainText("3 tracks");
  const box = (await canvas.boundingBox())!;
  const dg = await gutterShift(page);
  // Pick up the right half on V1 near its far end, carry it up to V2 and back in time over the first half's range on A1.
  const x = box.x + dg + 48 + 300;
  await page.mouse.click(x, box.y + 30 + 52 + 26);
  await page.mouse.move(x, box.y + 30 + 52 + 26);
  await page.mouse.down();
  await page.mouse.move(x - 40, box.y + 30 + 52 + 10, { steps: 4 });
  await page.mouse.move(x - 120, box.y + 30 + 26, { steps: 6 });
  await page.mouse.up();
  await expect(onV2(page)).toHaveCount(1);
  await expect(page.locator("#tl-summary")).toContainText("4 tracks"); // its sound went to a new A2
  await page.keyboard.press("Control+z");
  await expect(onV2(page)).toHaveCount(0);
  await expect(page.locator("#tl-summary")).toContainText("3 tracks");
});
