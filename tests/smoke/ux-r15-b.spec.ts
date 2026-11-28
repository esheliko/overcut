import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { gutterShift } from "./timeline-geometry";

/** UX r15 lane B: one import rule, the overlay picker, short error cards, honest format chips, the phone shell (strip order, Back, ratio tiles) and the portrait tablet. */
const FLASH = resolve("crates/media/tests/fixtures/flash_click.mp4"); // 3 s, picture + sound
const RED = resolve("crates/media/tests/fixtures/still_red.png");
const BLUE = resolve("crates/media/tests/fixtures/still_blue_portrait.jpg");

const boot = async (page: Page, url = "/") => {
  await page.goto(url);
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect(page.getByTestId("preview-import").or(page.getByTestId("import-empty")).or(page.getByTestId("import-more")).first()).toBeEnabled({ timeout: 20_000 });
};
const clips = async (page: Page) => Number(/(\d+) clip/.exec((await page.locator("#tl-summary").textContent()) ?? "")?.[1] ?? 0);

test("one import rule: the first import lands on the timeline, later ones in the bin with a toast whose action adds them", async ({ page }, info) => {
  const phone = info.project.name === "phone";
  await boot(page);
  await page.getByTestId("media-input").setInputFiles(FLASH); // empty timeline: bin AND timeline
  await expect.poll(() => clips(page)).toBeGreaterThan(0);
  const before = await clips(page);
  if (phone) await expect(page.getByTestId("panel-tool")).toBeHidden(); // it landed on the timeline: the sheet gets out of the way so the result is seen
  if (phone) await page.getByTestId("strip-media").click();
  await page.getByTestId("media-input").setInputFiles(RED); // non-empty timeline: bin only
  const toast = page.getByTestId("toast");
  await expect(toast).toContainText("Added to Media");
  expect(await clips(page)).toBe(before);
  if (phone) await expect(page.getByTestId("panel-tool")).toBeVisible(); // the sheet stays: an import into the bin never closes into nothing
  // The toast sits above the timeline (never on the picture or over a lane) and offers the one tap that places it.
  const [tb, tl] = await Promise.all([toast.boundingBox(), page.locator(".timeline").first().boundingBox()]);
  expect(tb && tl && tb.y + tb.height <= tl.y + 1).toBe(true);
  await page.getByTestId("toast-action").click();
  await expect.poll(() => clips(page)).toBeGreaterThan(before);
});

test("Add as overlay asks which media (a picker), never picks one silently", async ({ page }, info) => {
  const phone = info.project.name === "phone";
  await boot(page);
  await page.getByTestId("media-input").setInputFiles([FLASH, RED, BLUE]);
  await expect.poll(() => clips(page)).toBe(3); // the video (its sound is linked) and the two stills
  const before = await clips(page);
  if (phone) await page.getByTestId("strip-overlay").click(); else await page.getByTestId("tl-overlay-btn").click();
  const picker = page.getByTestId("overlay-picker");
  await expect(picker).toBeVisible();
  expect(await clips(page)).toBe(before); // opening it changes nothing
  await expect(page.getByTestId("overlay-choice")).toHaveCount(3);
  await page.getByTestId("overlay-choice").first().click();
  await expect(picker).toBeHidden();
  await expect.poll(() => clips(page)).toBeGreaterThan(before);
});

test("a file that cannot be read gets a two-line card with Details, and the format chips list only what imports", async ({ page }, info) => {
  const phone = info.project.name === "phone";
  await boot(page);
  await expect(page.locator(".drop-formats")).not.toContainText(/MP3|WAV/);
  await expect(page.locator(".drop-formats")).toContainText("M4A");
  await page.getByTestId("media-input").setInputFiles({ name: "fake.mp4", mimeType: "video/mp4", buffer: Buffer.from("this is not an mp4 at all") });
  const lineCount = (loc: ReturnType<Page["locator"]>) => loc.evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
  if (phone) {
    // The Media sheet is closed on a phone: the refusal says it in two lines, above the tool strip, and leaves by itself.
    const note = page.getByTestId("refusal-note");
    await expect(note).toBeVisible({ timeout: 20_000 });
    await expect(note).toContainText(/Can't (read|import) fake\.mp4/);
    expect(await lineCount(note.locator("li"))).toBeLessThanOrEqual(2);
    const [nb, sb] = await Promise.all([note.boundingBox(), page.getByTestId("tool-strip").boundingBox()]);
    expect(nb && sb && nb.y + nb.height <= sb.y + 1).toBe(true);
    return;
  }
  const card = page.getByTestId("bin-error");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.locator(".bin-error-text")).toContainText(/Can't (read|import) fake\.mp4/);
  expect(await lineCount(card.locator(".bin-error-text"))).toBeLessThanOrEqual(2);
  await card.locator("summary").click();
  await expect(card.locator("details")).toHaveAttribute("open", "");
});

test("phone: the clip strip leads with Split and Delete, Back deselects instead of leaving the app, ratio is one tap", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "the bottom tool strip is the phone's");
  await boot(page, "/?sample");
  const strip = page.getByTestId("tool-strip");
  await expect(page.locator("#tl-summary")).toContainText("14 clips");
  const canvas = page.getByTestId("timeline-canvas");
  const box = (await canvas.boundingBox())!;
  await page.touchscreen.tap(box.x + (await gutterShift(page)) + 108, box.y + 56);
  await expect(strip).toHaveAttribute("data-mode", "clip");
  const ids = await strip.locator("button").evaluateAll((bs) => bs.map((b) => b.getAttribute("data-testid")));
  expect(ids.slice(0, 3)).toEqual(["strip-back", "strip-split", "strip-delete"]);
  const del = await page.getByTestId("strip-delete").boundingBox();
  expect(del && del.x + del.width <= 390).toBe(true); // Delete is on screen without a swipe
  const back = await page.getByTestId("strip-back").boundingBox();
  expect(back && back.width <= 56 && back.height >= 44).toBe(true); // compact chevron, not a full slot
  // System Back: deselect first, and the app is still there.
  await page.goBack();
  await expect(strip).toHaveAttribute("data-mode", "global");
  expect(page.url()).toContain("localhost");
  // Edit highlights Edit, Speed highlights Speed.
  await page.touchscreen.tap(box.x + (await gutterShift(page)) + 108, box.y + 56);
  await page.getByTestId("strip-speed").click();
  await expect(page.getByTestId("strip-speed")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("strip-edit")).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Close panel" }).click();
  await page.getByTestId("strip-back").click();
  // Ratio in one tap.
  await page.getByTestId("strip-canvas").click();
  await page.getByTestId("canvas-ratio-9x16").click();
  await expect(page.getByTestId("canvas-open")).toHaveAccessibleName(/9:16/);
});

test("the editor is an app: no page scroll, no pull-to-refresh, an install icon", async ({ page }) => {
  await boot(page);
  const m = await page.evaluate(() => ({ over: getComputedStyle(document.documentElement).overscrollBehaviorY, h: document.documentElement.scrollHeight - innerHeight, w: document.documentElement.scrollWidth - innerWidth }));
  expect(m.over).toBe("none");
  expect(m.h).toBeLessThanOrEqual(0);
  expect(m.w).toBeLessThanOrEqual(0);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", "/icon-180.png");
  expect((await page.request.get("/icon-180.png")).ok()).toBe(true);
});

test("portrait tablet 768x1024: the empty Media drop zone fits its panel, the panels do not overlap, no page overflow", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "a tablet viewport is set below");
  await page.setViewportSize({ width: 768, height: 1024 });
  await boot(page);
  const lib = (await page.getByTestId("panel-tool").boundingBox())!;
  const drop = (await page.getByTestId("import-empty").boundingBox())!;
  const stage = (await page.getByTestId("panel-preview").boundingBox())!;
  expect(drop.y + drop.height).toBeLessThanOrEqual(lib.y + lib.height + 1); // the drop zone is not cut off
  expect(lib.y + lib.height).toBeLessThanOrEqual(stage.y + 1); // Media does not sit over the preview
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  // The timeline toolbar does not clip its zoom controls: the Fit button is fully inside the window.
  const fit = (await page.getByRole("button", { name: "Fit timeline to the window" }).boundingBox())!;
  expect(fit.x + fit.width).toBeLessThanOrEqual(768);
});
