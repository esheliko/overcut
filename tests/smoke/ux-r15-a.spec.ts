import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

/** UX round 15, lane A: timeline editing and operating. Mouse paths are desktop only. */
const media = resolve("crates/media/tests/fixtures", "h264_aac.mp4");

async function withClip(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await page.getByTestId("media-input").setInputFiles(media);
  await expect(page.locator("#tl-summary")).toContainText("2 tracks, 1 clip", { timeout: 30_000 });
}

test("Link and Unlink: a picture and its sound unlink, then link again with one click (toolbar and Ctrl+L)", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "the toolbar editing buttons are the desktop and tablet bar");
  await withClip(page);
  await page.getByTestId("timeline-canvas").focus();
  await page.keyboard.press("Enter"); // the clip at the playhead (and its linked sound)
  await expect(page.getByTestId("tl-unlink-btn")).toBeVisible();
  await page.getByTestId("tl-unlink-btn").click();
  await expect(page.getByTestId("tl-link-btn")).toBeVisible();
  await expect(page.getByTestId("tl-link-btn")).toBeEnabled(); // the picture and the sound are both still selected: they can be linked again
  await page.getByTestId("timeline-canvas").focus();
  await page.keyboard.press("Control+l");
  await expect(page.getByTestId("tl-unlink-btn")).toBeVisible();
});

test("the editor keys work when focus is not on the timeline (a click on the preview, the page body)", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "keyboard path");
  await withClip(page);
  await page.getByTestId("panel-preview").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("Control+a");
  await expect(page.getByTestId("tl-selected")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("tl-selected")).toHaveCount(0);
});

test("the + Video and + Audio buttons under the track column add a track; magnetic main track is on by default", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "the compact track column has no add buttons");
  await withClip(page);
  await expect(page.getByTestId("tl-magnetic")).toHaveAttribute("aria-pressed", "true");
  const box = (await page.getByTestId("timeline-canvas").boundingBox())!;
  // two rows (V1, A1): the buttons sit under the last row, 10 px below it; the first one is "+ Video"
  await page.mouse.click(box.x + 10 + 30, box.y + 30 + 2 * 60 + 10 + 22);
  await expect(page.locator("#tl-summary")).toContainText("3 tracks");
});

test("dropping a media card under the last track makes a new track for it", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "HTML5 drag and drop is a mouse path");
  await withClip(page);
  await page.getByTestId("bin-item").first().dragTo(page.getByTestId("timeline-canvas"), { targetPosition: { x: 520, y: 30 + 2 * 60 + 40 } });
  await expect(page.locator("#tl-summary")).toContainText("4 tracks", { timeout: 15_000 }); // a new video track for the picture and a new A2 for its sound (A1 is busy at that time)
  await expect(page.locator("#tl-summary")).toContainText("2 clips");
});

test("the command palette finds Import, Link, snapping and the add-track commands", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "keyboard path");
  await withClip(page);
  for (const [query, id] of [["import", "media.import"], ["link", "edit.link"], ["snapping", "view.snap"], ["add a video", "track.addVideo"], ["magnetic", "view.magnetic"]] as const) {
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill(query);
    await expect(page.getByTestId(`pal-${id}`)).toBeVisible();
    await page.keyboard.press("Escape");
  }
});
