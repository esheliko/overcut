import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { gutterShift } from "./timeline-geometry";

/** M2 UX round 13 (#241, #246): speed, opacity keyframe and export have keyboard commands (palette + shortcut dialog + tooltips); the Media card offers "Add as overlay". */
const FLASH = resolve("crates/media/tests/fixtures/flash_click.mp4");

async function ready(page: Page, phone: boolean) {
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect(page.getByTestId("preview-import")).toBeEnabled({ timeout: 20_000 });
  if (phone) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click();
  await page.getByTestId("media-input").setInputFiles(FLASH);
  await expect(page.locator("#tl-summary")).toContainText("1 clip");
  await expect(page.locator(".canvas")).toHaveAttribute("data-loaded", "true");
}

test("keyboard: T makes the selected clip 2x, Shift+D keys opacity at the playhead (again removes it), Ctrl+E opens Export", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "keyboard path");
  await ready(page, false);
  const box = (await page.getByTestId("timeline-canvas").boundingBox())!;
  await page.mouse.click(box.x + (await gutterShift(page)) + 68, box.y + 56);
  await expect(page.getByTestId("insp-opacity")).toBeVisible();

  // Opacity keyframe: the diamond's tooltip names the key; Shift+D sets it, a second press takes it away.
  const diamond = page.getByTestId("insp-key-opacity");
  await expect(diamond).toHaveAttribute("title", /\(Shift\+D\)$/);
  await expect(diamond).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Shift+D");
  await expect(diamond).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Shift+D");
  await expect(diamond).toHaveAttribute("aria-pressed", "false");

  // Speed 2x.
  await page.keyboard.press("t");
  await page.getByRole("tab", { name: "Speed" }).click();
  await expect(page.getByTestId("speed-field")).toHaveValue("2");
  await expect(page.getByTestId("speed-preset-2")).toHaveAttribute("title", /\(T\)$/);
  await page.keyboard.press("Shift+T");
  await expect(page.getByTestId("speed-field")).toHaveValue("0.5");

  // Export.
  await expect(page.getByTestId("export-open")).toHaveAttribute("title", /\(Ctrl\+E\)$/);
  await page.keyboard.press("Control+e");
  await expect(page.getByTestId("export-dialog")).toBeVisible();
  await page.keyboard.press("Escape");

  // Listed in the palette and in the shortcut dialog.
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill("export");
  await expect(page.getByRole("option", { name: /Export video/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("menuitem", { name: "Keyboard shortcuts…" }).click();
  for (const id of ["clip.speed2x", "clip.speedHalf", "clip.speedNormal", "clip.keyframeAtPlayhead", "app.export"]) await expect(page.getByTestId(`sc-${id}`)).toBeVisible();
});

test("Media card: Add as overlay puts the item on a new video track above (one tap, where the user looks)", async ({ page }, info) => {
  const phone = info.project.name === "phone";
  await ready(page, phone); // the first import is added to the timeline, the second waits in the bin
  await page.getByTestId("media-input").setInputFiles(resolve("crates/media/tests/fixtures/vp9_opus.webm"));
  await expect(page.getByTestId("bin-item")).toHaveCount(2);
  if (phone) { await expect(page.getByTestId("panel-tool")).toHaveAttribute("data-open", "false"); await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click(); }
  const card = page.getByTestId("bin-item").filter({ hasText: "vp9_opus.webm" });
  await expect(card.getByTestId("bin-on-timeline")).toHaveCount(0);
  await card.hover();
  const overlay = card.getByTestId("bin-add-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay).toHaveAccessibleName(/Add as overlay: vp9_opus\.webm/);
  if (phone) { const o = (await overlay.boundingBox())!; expect(o.height).toBeGreaterThanOrEqual(44); expect(o.width).toBeGreaterThanOrEqual(44); }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await overlay.click();
  await expect(page.locator("#tl-summary")).toContainText("2 clips");
  await expect(page.locator("#tl-summary")).toContainText(/[34] tracks/); // a new video track came with it
});
