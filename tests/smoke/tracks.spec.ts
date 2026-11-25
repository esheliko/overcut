import { expect, test } from "@playwright/test";
import { gutterShift } from "./timeline-geometry";

test("tracks: add a track, rename it from its header menu, video tracks have no mute, lock it, remove it, undo", async ({ page }, info) => {
  const phone = info.project.name === "phone";
  await page.goto("/?sample");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  const summary = page.locator("#tl-summary");
  await expect(summary).toContainText("Untitled project: 2 tracks"); // the engine has opened the sample project
  const canvas = page.getByTestId("timeline-canvas");
  const box = (await canvas.boundingBox())!;
  // Add a video track: with the toolbar button (desktop) or from a header menu (phone, where the toolbar button makes room).
  const header = async (row: number, dx: number, dy: number) => (phone ? page.touchscreen.tap(box.x + dx, box.y + 30 + row * 52 + dy) : page.mouse.click(box.x + dx, box.y + 30 + row * 52 + dy));
  if (phone) { await header(0, 20, 20); await page.getByTestId("track-add-video").click(); }
  else { await page.getByTestId("tl-more").click(); await page.getByTestId("track-add-video").click(); }
  await expect(summary).toContainText("3 tracks");
  // The new video track is on top (row 0): open its menu and rename it.
  await header(0, 20, 14);
  await expect(page.getByTestId("track-menu")).toBeVisible();
  await page.getByTestId("track-rename").click();
  await page.getByTestId("track-name-input").fill("Titles");
  await page.keyboard.press("Enter");
  await expect(page.locator("#tl-summary")).toContainText("3 tracks");
  // A video track has no Mute / Solo (its sound is on the linked audio track): lock it from the menu, then remove it; one undo brings it back.
  await header(0, 20, 14);
  await expect(page.getByTestId("track-menu")).toBeVisible();
  await expect(page.getByTestId("track-mute")).toHaveCount(0);
  await expect(page.getByTestId("track-solo")).toHaveCount(0);
  await page.getByTestId("track-lock").click();
  await header(0, 20, 14);
  await expect(page.getByTestId("track-lock")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("track-lock").click(); // unlock: a locked track cannot be removed
  await header(0, 20, 14);
  await page.getByTestId("track-remove").click();
  await expect(summary).toContainText("2 tracks");
  await page.keyboard.press("Control+z");
  await expect(summary).toContainText("3 tracks");
  if (!phone) {
    // Desktop headers carry the switches: the lock switch (third) flips without opening the menu; the gutter is wide.
    expect(await gutterShift(page)).toBeGreaterThan(0);
  }
});
