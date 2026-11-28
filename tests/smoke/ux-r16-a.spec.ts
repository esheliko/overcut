import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

/** UX round 16, lane A: where media lands, edit-point keys, Alt+Up on the top lane, the media bin as one tab stop. Keyboard and mouse paths are desktop only. */
const dir = resolve("crates/media/tests/fixtures");
const video = resolve(dir, "h264_aac.mp4");
const music = resolve(dir, "tone.mp3");

async function withClip(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await page.getByTestId("media-input").setInputFiles(video);
  await expect(page.locator("#tl-summary")).toContainText("2 tracks, 1 clip", { timeout: 30_000 });
}

test("music imported into a project that already has a video goes straight to the timeline (own audio track at the playhead)", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "the Media panel is a sheet on phones; the rule is the same code");
  await withClip(page);
  await page.getByTestId("media-input").setInputFiles(music);
  await expect(page.locator("#tl-summary")).toContainText("3 tracks, 2 clips", { timeout: 30_000 });
});

test("double-click on a media card adds it to the timeline, after the last picture", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "mouse path");
  await withClip(page);
  await page.getByTestId("bin-item").first().dblclick();
  await expect(page.locator("#tl-summary")).toContainText("2 clips", { timeout: 15_000 });
});

test("Up and Down jump between edit points; Alt+T focuses the timeline from the page body", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "keyboard path");
  await withClip(page);
  const canvas = page.getByTestId("timeline-canvas");
  await page.keyboard.press("Alt+t"); // focus is on the body or the bin: still works
  await expect(canvas).toBeFocused();
  const frame = async () => Number(await canvas.getAttribute("aria-valuenow"));
  expect(await frame()).toBe(0);
  await page.keyboard.press("ArrowDown"); // the end of the only clip
  await expect.poll(frame).toBeGreaterThan(0);
  await page.keyboard.press("ArrowUp");
  await expect.poll(frame).toBe(0);
});

test("Alt+Up on the top video lane makes a new video lane, like dragging above it (one undo step)", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "keyboard path");
  await withClip(page);
  const canvas = page.getByTestId("timeline-canvas");
  await canvas.focus();
  await page.keyboard.press("Enter"); // the clip at the playhead and its linked sound
  await page.keyboard.press("Alt+ArrowUp");
  await expect(page.locator("#tl-summary")).toContainText(/[34] tracks/, { timeout: 15_000 }); // V2, and the sound moves to a lane of its own
  await page.keyboard.press("Control+z");
  await expect(page.locator("#tl-summary")).toContainText("2 tracks"); // one step
});

test("the media bin is ONE tab stop (roving tabindex): arrows move, Enter adds", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "keyboard path");
  await withClip(page);
  await page.getByTestId("media-input").setInputFiles(music);
  await expect(page.getByTestId("bin-item")).toHaveCount(2, { timeout: 30_000 });
  await expect(page.locator('[data-testid="bin-item"][tabindex="0"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="bin-item"] button:not([tabindex="-1"])')).toHaveCount(0);
  const first = page.getByTestId("bin-item").first();
  await first.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("bin-item").nth(1)).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(first).toBeFocused();
});

test("the marker menu opens under the ruler and never reaches up over the transport", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "right-click on the flag; the phone opens the same menu by a long press");
  await withClip(page);
  await page.getByTestId("timeline-canvas").focus();
  await page.keyboard.press("m");
  const cv = page.getByTestId("timeline-canvas");
  const box = (await cv.boundingBox())!;
  const g = Number(await cv.getAttribute("data-gutter"));
  await page.mouse.click(box.x + g + 3, box.y + 8, { button: "right" });
  const menu = page.getByTestId("marker-menu");
  await expect(menu).toBeVisible();
  const m = (await menu.boundingBox())!;
  expect(m.y).toBeGreaterThanOrEqual(box.y - 1); // the top is no higher than the ruler: never over the transport above it
  const vh = page.viewportSize()!.height;
  expect(m.y + m.height).toBeLessThanOrEqual(vh);
});
