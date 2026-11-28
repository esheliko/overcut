import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * r16 F: media survives a reload where the browser keeps no file handle (Safari, Firefox, phones). `setInputFiles` is exactly that path: a plain
 * File with no handle. The import keeps a copy in the origin-private file system; after a reload the card is ready with its poster, no relink asked.
 */
const file = (n: string) => resolve("crates/media/tests/fixtures", n);

async function open(page: Page) {
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  if ((page.viewportSize()?.width ?? 0) < 720) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click();
}

async function showBin(page: Page) {
  if ((page.viewportSize()?.width ?? 0) >= 720) return;
  const panel = page.getByTestId("panel-tool");
  await expect(panel).toHaveAttribute("data-open", /true|false/);
  if ((await panel.getAttribute("data-open")) === "false") await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click();
}

test("an imported file and its poster are still there after a reload, with no relink", async ({ page }) => {
  await page.goto("/");
  await open(page);
  await page.getByTestId("media-input").setInputFiles(file("h264_aac.mp4"));
  const card = page.getByTestId("bin-item").first();
  await expect(card.locator("img")).toHaveCount(1);
  await expect(page.locator("#tl-summary")).toContainText("1 clip");
  await showBin(page); // on a phone the sheet closes itself after an import onto the timeline
  const storage = page.getByTestId("bin-storage");
  await expect(storage).toContainText("kept on this device", { timeout: 20_000 });

  await page.reload();
  await open(page);
  const again = page.getByTestId("bin-item").first();
  await expect(again).toHaveAttribute("data-status", "ready", { timeout: 20_000 });
  await expect(again.locator("img")).toHaveCount(1); // the poster comes from the poster cache
  await expect(page.getByTestId("bin-needs-permission")).toHaveCount(0);
  await expect(page.getByTestId("offline-note")).toHaveCount(0); // no "choose the files again" note, no relink
  await expect(again.getByRole("button", { name: /relink|choose/i })).toHaveCount(0);

  // The clip is playable: the preview can read the file from the kept copy.
  const read = await page.evaluate(async () => {
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle("overcut-media");
    let n = 0;
    // @ts-expect-error async iteration of a directory handle
    for await (const h of d.values()) if (!h.name.endsWith(".json")) n = (await h.getFile()).size;
    return n;
  });
  expect(read).toBeGreaterThan(1000);

  // "Remove unused media copies" keeps what the project uses.
  await page.getByTestId("bin-free-copies").click();
  await expect(page.getByTestId("bin-storage")).toContainText("No unused copies to remove.");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("the poster shows after a reload even when the copy is gone (poster cache alone)", async ({ page }) => {
  await page.goto("/");
  await open(page);
  await page.getByTestId("media-input").setInputFiles(file("h264_aac.mp4"));
  await expect(page.locator("#tl-summary")).toContainText("1 clip");
  await showBin(page);
  await expect(page.getByTestId("bin-storage")).toContainText("kept on this device", { timeout: 20_000 });
  await page.evaluate(async () => { await (await navigator.storage.getDirectory()).removeEntry("overcut-media", { recursive: true }); });
  await page.reload();
  await open(page);
  const card = page.getByTestId("bin-item").first();
  await expect(card.locator("img")).toHaveCount(1, { timeout: 20_000 }); // picture first,
  await expect(card).toHaveAttribute("data-status", "offline"); // then the honest "choose the file again"
});
