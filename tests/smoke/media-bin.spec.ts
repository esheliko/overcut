import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** M1-032: import into the media bin, first-import auto-add, add from the bin, friendly errors, drop and paste. Needs a build with the engine. */
const FIX = resolve("crates/media/tests/fixtures");
const file = (n: string) => resolve(FIX, n);

async function ready(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  if ((page.viewportSize()?.width ?? 0) < 720) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click();
}
const summary = (page: Page) => page.locator("#tl-summary");

test("empty project shows one big import target; the first import lands on the timeline with no questions", async ({ page }) => {
  await ready(page);
  const target = page.getByTestId("import-empty");
  await expect(target).toBeVisible();
  expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(160);
  await expect(summary(page)).toContainText("0 clips");
  await page.getByTestId("media-input").setInputFiles(file("h264_aac.mp4"));
  const card = page.getByTestId("bin-item").first();
  await expect(card).toContainText("h264_aac.mp4");
  await expect(card).toContainText("H.264 + AAC"); // codec
  await expect(card).toContainText("×"); // resolution
  await expect(card.locator("img")).toHaveCount(1); // poster from the first frame
  // picture + sound = two clips on two tracks, and the sample clips are gone
  await expect(summary(page)).toContainText("2 tracks, 2 clips");
  // the canvas has a text alternative: one list item per clip, named with its track and times
  const list = page.getByRole("list", { name: "Clips on the timeline" });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list).toContainText("h264_aac.mp4");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("add from the bin with the + button (44 px), keyboard reachable; a second file stays in the bin until added", async ({ page }) => {
  await ready(page);
  await page.getByTestId("media-input").setInputFiles(file("h264_aac.mp4"));
  await expect(summary(page)).toContainText("2 clips");
  if ((page.viewportSize()?.width ?? 0) < 720) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click(); // the sheet closed itself after the import
  await page.getByTestId("import-more").click({ trial: true });
  await page.getByTestId("media-input").setInputFiles(file("vp9_opus.webm"));
  await expect(page.getByTestId("bin-item")).toHaveCount(2);
  if ((page.viewportSize()?.width ?? 0) < 720) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click(); // closed again after this import
  await expect(summary(page)).toContainText("2 clips"); // only the first import auto-adds
  const add = page.getByRole("button", { name: "Add vp9_opus.webm to the timeline" });
  expect((await add.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await add.focus();
  await page.keyboard.press("Enter");
  await expect(summary(page)).toContainText("4 clips");
  await expect(page.locator("[data-announcer=polite]")).toContainText("Added to the timeline");
});

test("a file that cannot be imported says why, in plain words, and nothing is silently dropped", async ({ page }) => {
  await ready(page);
  await page.getByTestId("media-input").setInputFiles([
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") },
    { name: "broken.mp4", mimeType: "video/mp4", buffer: Buffer.from("this is not a video file at all, just text") },
  ]);
  const items = page.getByTestId("bin-item");
  await expect(items).toHaveCount(2);
  await expect(page.getByText("notes.txt is not a video, audio or image file")).toBeVisible();
  await expect(page.getByText(/broken\.mp4 could not be imported \(MP4\)/)).toBeVisible();
  await expect(page.getByText(/MP4 or MOV with H\.264/).first()).toBeVisible();
  await expect(summary(page)).toContainText("0 clips"); // nothing was added
  await page.getByRole("button", { name: "Dismiss notes.txt" }).click();
  await expect(items).toHaveCount(1);
});

test("dropping files anywhere and pasting both import", async ({ page }) => {
  await ready(page);
  const b64 = readFileSync(file("vp9_opus.webm")).toString("base64");
  const dt = (name: string) => page.evaluateHandle(({ b64, name }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const d = new DataTransfer();
    d.items.add(new File([bytes], name, { type: "video/webm" }));
    return d;
  }, { b64, name });
  const dropped = await dt("dropped.webm");
  await page.getByTestId("panel-preview").dispatchEvent("dragenter", { dataTransfer: dropped });
  await expect(page.getByTestId("drop-overlay")).toBeVisible();
  await page.getByTestId("panel-preview").dispatchEvent("drop", { dataTransfer: dropped });
  await expect(page.getByTestId("drop-overlay")).toBeHidden();
  await expect(page.getByTestId("bin-item").first()).toContainText("dropped.webm");
  await expect(summary(page)).toContainText("2 clips"); // dropped onto an empty project: on the timeline at 0
  const pasted = await dt("pasted.webm");
  await page.evaluate((d) => window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: d, bubbles: true, cancelable: true })), pasted);
  await expect(page.getByTestId("bin-item")).toHaveCount(2);
  await expect(page.getByTestId("bin-item").first()).toContainText("pasted.webm");
});

test("dragging a bin item onto the timeline adds it", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "HTML5 drag and drop is a mouse path; touch uses the + button");
  await ready(page);
  await page.getByTestId("media-input").setInputFiles([file("h264_aac.mp4"), file("vp9_opus.webm")]);
  await expect(page.getByTestId("bin-item")).toHaveCount(2);
  await expect(summary(page)).toContainText("4 clips"); // both files of the first drop go on the timeline in order
  await page.getByTestId("bin-item").first().dragTo(page.getByTestId("panel-timeline"), { targetPosition: { x: 400, y: 80 } });
  await expect(summary(page)).toContainText("6 clips");
});

test("an imported clip's waveform is real, not a placeholder (M1-013)", async ({ page }) => {
  await ready(page);
  await page.getByTestId("media-input").setInputFiles(file("h264_aac.mp4"));
  await expect(summary(page)).toContainText("2 clips");
  const canvas = page.getByTestId("timeline-canvas");
  await expect(canvas).toHaveAttribute("data-wave-tiles", /^[1-9]\d*$/, { timeout: 30_000 }); // waveform tiles rendered from the engine's peaks
  await expect(canvas).toHaveAttribute("data-thumbs", /^[1-9]\d*$/, { timeout: 30_000 }); // filmstrip frames decoded
});
