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
  await expect(page.getByTestId("panel-tool").getByText("notes.txt is not a video, audio or image file")).toBeVisible();
  await expect(page.locator(".bin-error").getByText(/broken\.mp4 could not be imported \(MP4\)/)).toBeVisible();
  await expect(page.locator("[data-announcer=polite]")).toContainText("could not be imported"); // the refusal is what a screen reader hears, not a count of files imported
  await expect(page.getByText(/MP4 or MOV with H\.264/).first()).toBeVisible();
  await expect(summary(page)).toContainText("0 clips"); // nothing was added
  await page.getByRole("button", { name: "Dismiss notes.txt" }).click();
  await expect(items).toHaveCount(1);
});

test("an audio-only .webm (a voice recording) imports as audio; a format nobody reads says so as a sentence, and the refusal is what is announced", async ({ page }) => {
  await ready(page);
  await page.getByTestId("media-input").setInputFiles([
    { name: "voice.webm", mimeType: "video/webm", buffer: readFileSync(file("audio_only.webm")) }, // browsers type every .webm as video/webm
    { name: "clip.wav", mimeType: "audio/wav", buffer: Buffer.from("RIFF\0\0\0\0WAVEfmt ") },
  ]);
  await expect(summary(page)).toContainText("1 clip", { timeout: 20_000 });
  await expect(page.getByTestId("bin-item").filter({ hasText: "voice.webm" })).toContainText("OPUS");
  await expect(page.locator("[data-announcer=polite]")).toContainText(/clip\.wav could not be imported \(WAV\)\. This is not a video or audio format OverCut can read\. /); // announced, as a sentence, not buried under "1 file imported"
  await expect(page.locator("[data-announcer=polite]")).not.toContainText("file imported");
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

test("phone: a refusal in a batch that also imported stays visible after the Media sheet closes, until dismissed", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 720, "the bin stays on screen beside the timeline on wider screens");
  await ready(page);
  await page.getByTestId("media-input").setInputFiles([
    { name: "clip.mp4", mimeType: "video/mp4", buffer: readFileSync(file("h264_aac.mp4")) },
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") },
  ]);
  await expect(summary(page)).toContainText("2 clips", { timeout: 30_000 });
  const note = page.getByTestId("refusal-note");
  await expect(note).toBeVisible();
  await expect(note).toContainText("notes.txt is not a video, audio or image file");
  const close = note.getByRole("button", { name: "Dismiss" });
  expect((await close.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await close.click();
  await expect(note).toHaveCount(0);
});

test("phone: the media itself is on screen as soon as the Media sheet opens (header and filters stay short)", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 720, "phone layout only");
  await page.goto("/?sample");
  await expect(page.locator("#tl-summary")).toContainText("2 tracks, 14 clips");
  await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click();
  const sheet = (await page.locator(".library[data-open='true']").boundingBox())!;
  const first = (await page.getByTestId("bin-item").first().boundingBox())!;
  expect(first.y + first.height).toBeLessThanOrEqual(sheet.y + sheet.height); // a whole card, not cut off
  expect(first.y - sheet.y).toBeLessThan(300); // the header, search, import and filters take less than that above it
});

test("the kind, sort and tag controls sit behind one 44 px \"Filter and sort\" button; closed by default, marked On when a filter is set, nothing overflows at 320 px", async ({ page }) => {
  await ready(page);
  await page.getByTestId("media-input").setInputFiles([{ name: "h264_aac.mp4", mimeType: "video/mp4", buffer: readFileSync(file("h264_aac.mp4")) }, { name: "vp9_opus.webm", mimeType: "video/webm", buffer: readFileSync(file("vp9_opus.webm")) }]);
  await expect(page.getByTestId("bin-item")).toHaveCount(2);
  await expect(page.locator('[data-testid=bin-item][data-status="ready"]')).toHaveCount(2, { timeout: 20_000 }); // the phone sheet closes again when the import settles
  const toggle = page.getByTestId("bin-filter-toggle");
  // the phone sheet closes itself after an import: reopen it only when its controls are hidden (a click on a sheet that is still open would close it)
  if ((page.viewportSize()?.width ?? 0) < 720) {
    await expect(async () => {
      if (!(await toggle.isVisible())) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click();
      await expect(toggle).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
  }
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("bin-kind-audio")).toHaveCount(0);
  expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await toggle.click();
  await expect(page.getByTestId("bin-kind-audio")).toBeVisible();
  await expect(page.getByTestId("bin-filter-on")).toHaveCount(0);
  await page.getByTestId("bin-kind-audio").click();
  await expect(page.getByTestId("bin-filter-on")).toHaveText("On");
  await page.getByTestId("bin-kind-all").click();
  await expect(page.getByTestId("bin-filter-on")).toHaveCount(0);
  for (const id of ["bin-kind-video", "bin-kind-all", "bin-sort"]) expect((await page.getByTestId(id).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("a clip already on the timeline has no \"+\" (no duplicate on a second click); the tag button says Tags; one Import control once media is in the bin", async ({ page }) => {
  await ready(page);
  await page.getByTestId("media-input").setInputFiles(file("h264_aac.mp4")); // the first import is added to the timeline
  await expect(summary(page)).toContainText("2 clips");
  if ((page.viewportSize()?.width ?? 0) < 720) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click();
  const first = page.getByTestId("bin-item").filter({ hasText: "h264_aac.mp4" });
  await expect(first.getByTestId("bin-on-timeline")).toHaveText("On the timeline");
  await expect(first.getByRole("button", { name: /Add .* to the timeline/ })).toHaveCount(0);
  await expect(first.getByTestId("bin-tag-edit")).toContainText("Tags");
  await expect(page.getByTestId("preview-import")).toHaveCount(0); // the Media panel has the one Import
  await page.getByTestId("media-input").setInputFiles(file("vp9_opus.webm"));
  await expect(page.getByTestId("bin-item")).toHaveCount(2);
  if ((page.viewportSize()?.width ?? 0) < 720) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click();
  const second = page.getByTestId("bin-item").filter({ hasText: "vp9_opus.webm" });
  await expect(second.getByRole("button", { name: "Add vp9_opus.webm to the timeline" })).toBeVisible();
  await expect(second.getByTestId("bin-on-timeline")).toHaveCount(0);
  await second.getByRole("button", { name: "Add vp9_opus.webm to the timeline" }).click();
  await expect(summary(page)).toContainText("4 clips");
  await expect(page.getByRole("button", { name: /Add vp9_opus\.webm/ })).toHaveCount(0);
});

test("tablet portrait (820x1180): the Media panel is full width above the preview; a name and its meta are whole, meta on one line", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 720, "tablet layout only");
  await page.setViewportSize({ width: 820, height: 1180 });
  await ready(page);
  await page.getByTestId("media-input").setInputFiles([file("h264_aac.mp4"), file("vp9_opus.webm")]);
  await expect(page.getByTestId("bin-item")).toHaveCount(2);
  const lib = (await page.locator(".library").boundingBox())!;
  const stage = (await page.locator(".stage").boundingBox())!;
  expect(lib.width).toBeGreaterThanOrEqual(600); // not the 240 px column that cut names and wrapped the meta one token per line
  expect(stage.y).toBeGreaterThan(lib.y); // the preview sits under the Media panel
  const card = page.getByTestId("bin-item").filter({ hasText: "vp9_opus.webm" });
  expect(await card.locator("strong").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true); // the name is not cut
  const meta = (await card.locator(".bin-text > span").filter({ hasText: "·" }).first().boundingBox())!; // the meta line
  expect(meta.height).toBeLessThan(24); // one line
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
