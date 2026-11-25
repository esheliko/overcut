import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

/** PM-06 version snapshots and PM-03 bin filter / sort / tags / 10k items (docs/features/versions.md, media-bin.md). Needs a build with the engine. */
const MP4 = resolve("crates/media/tests/fixtures/h264_aac.mp4");
const WEBM = resolve("crates/media/tests/fixtures/vp9_opus.webm");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");

const phoneOf = (page: Page) => (page.viewportSize()?.width ?? 0) < 720;
const openBin = async (page: Page) => { if (phoneOf(page)) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click(); };
async function ready(page: Page, url = "/") {
  await page.goto(url);
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect(page.getByTestId("preview-import")).toBeEnabled({ timeout: 20_000 });
  await openBin(page);
}
const menu = async (page: Page, item: string) => {
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("menuitem", { name: item }).click();
};

test("a named snapshot can be saved, listed, restored (undo point kept) and deleted", async ({ page }) => {
  test.setTimeout(90_000);
  await ready(page);
  await page.getByTestId("media-input").setInputFiles(MP4);
  await expect(page.getByTestId("bin-item")).toHaveCount(1);

  await menu(page, "Versions…");
  const dialog = page.getByTestId("versions-dialog");
  await expect(page.getByTestId("versions-empty")).toBeVisible();
  await page.getByTestId("versions-name").fill("One clip");
  await page.getByTestId("versions-save").click();
  const rows = page.getByTestId("version-item");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("One clip");
  await expect(rows.first()).toContainText("Saved by you");
  await expect(page.getByTestId("versions-size")).toContainText("1 versions use");
  expect((await page.getByTestId("version-restore").boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect((await page.getByTestId("version-delete").boundingBox())!.width).toBeGreaterThanOrEqual(44);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // change the project, then go back to the snapshot
  await openBin(page);
  await page.getByTestId("import-more").click({ trial: true });
  await page.getByTestId("media-input").setInputFiles(WEBM);
  await expect(page.getByTestId("bin-item")).toHaveCount(2);
  await menu(page, "Versions…");
  await page.getByTestId("version-item").filter({ hasText: "One clip" }).getByTestId("version-restore").click();
  await expect(dialog).toBeHidden();
  await openBin(page);
  await expect(page.getByTestId("bin-item")).toHaveCount(1);

  // the project that was replaced is itself a version now
  await menu(page, "Versions…");
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "Before a restore" })).toHaveCount(1);
  await rows.filter({ hasText: "Before a restore" }).getByTestId("version-restore").click();
  await openBin(page);
  await expect(page.getByTestId("bin-item")).toHaveCount(2);

  await menu(page, "Versions…");
  await expect(rows.first()).toBeVisible();
  const before = await rows.count();
  await page.getByTestId("version-delete").first().click();
  await expect(rows).toHaveCount(before - 1);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("bin: type filter, sort, tags (undoable) and tag filter", async ({ page }) => {
  test.setTimeout(90_000);
  await ready(page);
  await page.getByTestId("media-input").setInputFiles([{ name: basename(MP4), mimeType: "video/mp4", buffer: readFileSync(MP4) }, { name: basename(WEBM), mimeType: "video/webm", buffer: readFileSync(WEBM) }, { name: "dot.png", mimeType: "image/png", buffer: PNG }]);
  const items = page.getByTestId("bin-item");
  await expect(page.getByTestId("bin-count")).toHaveText("3 of 3 shown");
  await openBin(page); // the phone's sheet closes itself after an import
  await page.getByTestId("bin-filter-toggle").click(); // the kind, sort and tag controls sit behind "Filter and sort"

  await page.getByTestId("bin-kind-image").click();
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText("dot.png");
  await page.getByTestId("bin-kind-audio").click();
  await expect(items).toHaveCount(0);
  await expect(page.getByText("No media matches these filters.")).toBeVisible();
  await page.getByTestId("bin-kind-video").click();
  await expect(items).toHaveCount(2);

  await page.getByTestId("bin-sort").selectOption("name");
  await expect(items.first()).toContainText("h264_aac.mp4");
  await expect(items.last()).toContainText("vp9_opus.webm");
  await page.getByTestId("bin-kind-all").click();

  // tag one item: it shows on the card, the tag filter appears, Undo removes it
  await items.filter({ hasText: "dot.png" }).getByTestId("bin-tag-edit").click();
  await page.getByTestId("tag-input").fill("  B-roll ");
  await page.getByTestId("tag-add").click();
  await expect(page.getByTestId("tags-dialog")).toContainText("B-roll");
  await page.keyboard.press("Escape");
  await expect(items.filter({ hasText: "dot.png" }).getByTestId("bin-tags")).toHaveText("#B-roll");
  await page.getByTestId("bin-tag-filter").selectOption("B-roll");
  await expect(items).toHaveCount(1);
  await expect(page.getByTestId("bin-count")).toHaveText("1 of 3 shown");
  expect((await page.getByTestId("bin-kind-all").boundingBox())!.height).toBeGreaterThanOrEqual(44);

  await openBin(page); // phone: closes the sheet that covers the toolbar
  await page.getByRole("button", { name: "Undo" }).first().click();
  await openBin(page);
  await expect(page.getByTestId("bin-tag-filter")).toHaveCount(0);
  await expect(items).toHaveCount(3);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("a bin of 10,000 items renders a window of rows and filters quickly", async ({ page }) => {
  test.setTimeout(120_000);
  await ready(page, "/?e2e");
  await page.waitForFunction(() => !!(window as unknown as { __overcut?: unknown }).__overcut);
  const N = 10_000;
  await page.evaluate(async (n) => {
    const s = (window as unknown as { __overcut: { session: { editing: { apply(o: unknown[]): Promise<unknown> }; whenDurable(): Promise<void> } } }).__overcut.session;
    const kinds = ["video", "audio", "image"];
    const ops = Array.from({ length: n }, (_, i) => ({ op: "add_media", media: { id: `a${i.toString(16).padStart(31, "0")}`, kind: kinds[i % 3], name: `clip-${i}.mp4`, uri: `file:clip-${i}.mp4:1`, hash: null, duration: i % 3 === 2 ? null : (i % 500 + 1) * 705_600_000 } }));
    await s.editing.apply(ops);
    await s.whenDurable();
  }, N);
  await page.goto("/"); // the project, 10k media in it, opens again from storage
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await openBin(page);
  const items = page.getByTestId("bin-item");
  await expect(page.getByTestId("bin-count")).toContainText(/of 1000\d shown/, { timeout: 30_000 });
  expect(await items.count()).toBeLessThan(120);
  expect(await items.count()).toBeGreaterThan(5);

  const t0 = Date.now();
  await page.getByTestId("bin-filter-toggle").click();
  await page.getByTestId("bin-kind-audio").click();
  await expect(page.getByTestId("bin-count")).toContainText(/^33\d\d of 1000\d shown/);
  const filterMs = Date.now() - t0;
  console.log(`10k bin: filter by type to a re-rendered window in ${filterMs} ms, ${await items.count()} rows in the DOM (container, not representative)`);
  expect(filterMs).toBeLessThan(3000);
  expect(await items.count()).toBeLessThan(120);

  await page.getByTestId("bin-kind-all").click();
  await page.getByTestId("bin-sort").selectOption("name");
  await page.locator(".panel-body").evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(items.last()).toContainText("e2e.mp4");
  expect(await items.count()).toBeLessThan(120);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
