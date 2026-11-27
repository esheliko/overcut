import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { gutterShift } from "./timeline-geometry";

/** Fixes for what a first-time user trips over (docs/M1-STATUS.md section 4): import, split, undo, tool rail, fit, canvas. Needs a build with the engine. */
const FLASH = resolve("crates/media/tests/fixtures/flash_click.mp4"); // 3 s, 30 fps, picture + sound

test("first import: rail shows only working tools, the zoom fits the clip, undo says what it undoes, split at the clip start explains itself, the phone sheet closes", async ({ page }, info) => {
  const phone = info.project.name === "phone";
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect(page.getByTestId("preview-import")).toBeEnabled({ timeout: 20_000 });

  // No dead promises: only tools that work (Media, and Edit for the clip transform from M2) in the rail; the Details panel is docked on wide screens.
  const rail = page.getByRole("navigation", { name: "Tools" }).getByRole("button");
  if (phone) {
    await expect(rail).toHaveCount(2); // Media and Edit open sheets
    await expect(rail.first()).toHaveText("Media");
    await expect(rail.last()).toHaveText("Edit");
  } else await expect(rail).toHaveCount(0); // Media is always open and Details is docked on a wide screen: no rail with a single tool
  await expect(page.getByTestId("panel-inspector")).toHaveCount(phone ? 0 : 1);

  // The shape control is the project's canvas (not just the preview), and says what it is.
  const shape = page.getByTestId("canvas-open");
  await expect(shape).toHaveAttribute("title", /shape, size and frame rate of your video/);
  await expect(shape).toHaveAccessibleName(/^Canvas: 16:9 · 1920 × 1080 · 30 fps/);

  const canvas = page.getByTestId("timeline-canvas");
  const pps = async () => Number(await canvas.getAttribute("data-pps"));
  const before = await pps();
  if (phone) await rail.first().click();
  await page.getByTestId("media-input").setInputFiles(FLASH);
  await expect(page.locator("#tl-summary")).toContainText("1 clip");

  // Phone: the Media sheet closed itself, so the Split / Undo toolbar is reachable.
  if (phone) await expect(page.getByTestId("panel-tool")).toBeHidden();
  // Zoom to fit the content, and the visible Fit control does it again after the user zooms out.
  await expect.poll(pps).toBeGreaterThan(before * 1.5); // 3 s over the whole width, not 40 px per second
  const fitted = await pps();
  const box = (await canvas.boundingBox())!;
  expect(Math.abs(fitted - (box.width - 48 - (await gutterShift(page)) - 96) / 3)).toBeLessThan(1);
  const fit = page.getByRole("button", { name: "Fit timeline to the window" });
  await expect(fit).toBeVisible();
  if (phone) expect((await fit.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  // Phones keep only Fit in the bar (pinch zooms); Zoom in / out are rows of the More menu.
  const zoomOut = async () => { if (phone) { await page.getByTestId("tl-more").click(); await page.getByRole("menuitem", { name: "Zoom out" }).click(); } else await page.getByRole("button", { name: "Zoom out" }).click(); };
  await zoomOut();
  await zoomOut();
  await expect.poll(pps).toBeLessThan(fitted * 0.7);
  await fit.click();
  await expect.poll(async () => Math.abs((await pps()) - fitted)).toBeLessThan(1);

  // Split with the playhead on the clip start: a visible hint, and nothing changed.
  await page.getByRole("button", { name: "Split at playhead" }).click();
  await expect(page.locator(".toast")).toContainText("Nothing to split here");
  // The toast never lies over the timeline (K-03): it ends above the timeline's top edge.
  const [toastBox, timelineBox] = await Promise.all([page.locator(".toast").boundingBox(), page.locator(".timeline").first().boundingBox()]);
  expect(toastBox && timelineBox && toastBox.y + toastBox.height <= timelineBox.y + 1).toBe(true);
  await expect(page.locator("#tl-summary")).toContainText("1 clip");

  // Undo names the import; using it announces and shows what was undone.
  const undo = page.getByRole("button", { name: "Undo import of flash_click.mp4" });
  await expect(undo).toBeVisible();
  await undo.click();
  await expect(page.locator(".toast")).toContainText("Undid import of flash_click.mp4");
  await expect(page.locator("#tl-summary")).toContainText("0 clips");
  await expect(page.getByRole("button", { name: "Redo import of flash_click.mp4" })).toBeVisible();

  // Redo, then leave for the projects list while a toast is up: the editor's message must not follow, and the card counts the import as one clip.
  await page.getByRole("button", { name: "Redo import of flash_click.mp4" }).click();
  await page.getByRole("button", { name: "Split at playhead" }).click();
  await expect(page.locator(".toast")).toContainText("Nothing to split here");
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("menuitem", { name: "Projects" }).click();
  await expect(page.getByTestId("projects-new")).toBeVisible();
  await expect(page.locator(".toast")).toHaveText("");
  await expect(page.getByTestId("project-card").first()).toContainText("1 clip");
});
