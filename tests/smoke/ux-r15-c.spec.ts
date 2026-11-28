import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { gutterShift } from "./timeline-geometry";

/** UX r15 lane C: MP3 / WAV import, the compact Details panel (one Transform section, a group keyframe diamond, the curve easing menu), the Projects button and auto-named projects, the export's file name and keep-awake note. */
const FIX = resolve("crates/media/tests/fixtures");
const file = (n: string) => resolve(FIX, n);

async function ready(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect(page.getByTestId("preview-import")).toBeEnabled({ timeout: 20_000 });
}
const openMedia = async (page: Page, phone: boolean) => { if (phone) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click(); };

test("MP3 and WAV import as audio clips, with a real waveform source and no error card", async ({ page }, info) => {
  const phone = info.project.name === "phone";
  await ready(page);
  await openMedia(page, phone);
  await page.getByTestId("media-input").setInputFiles([file("tone.mp3"), file("tone.wav")]);
  await expect(page.locator("#tl-summary")).toContainText(/2 clips?|clips/, { timeout: 20_000 });
  const cards = page.getByTestId("bin-item");
  await expect(cards).toHaveCount(2);
  await expect(page.locator(".bin-error")).toHaveCount(0);
  await expect(cards.filter({ hasText: "tone.mp3" })).toHaveCount(1);
  await expect(cards.filter({ hasText: "tone.wav" })).toHaveCount(1);
  const list = page.getByRole("list", { name: "Clips on the timeline" });
  await expect(list.getByRole("listitem")).toHaveCount(2);
});

test("Details: Transform holds Opacity, one diamond keys the group, easing is a curve menu", async ({ page }, info) => {
  const phone = info.project.name === "phone";
  await ready(page);
  const tools = page.getByRole("navigation", { name: "Tools" });
  await openMedia(page, phone);
  await page.getByTestId("media-input").setInputFiles(file("flash_click.mp4"));
  await expect(page.locator("#tl-summary")).toContainText("1 clip");
  await expect(page.locator(".canvas")).toHaveAttribute("data-loaded", "true");
  const box = (await page.getByTestId("timeline-canvas").boundingBox())!;
  const dg = await gutterShift(page);
  if (phone) await page.touchscreen.tap(box.x + dg + 68, box.y + 56);
  else await page.mouse.click(box.x + dg + 68, box.y + 56);
  if (phone) await tools.getByRole("button", { name: "Edit" }).click();

  // One Transform section; no second "Opacity" header above an "Opacity" row.
  await expect(page.getByTestId("insp-sec-opacity")).toHaveCount(0);
  await expect(page.getByTestId("insp-opacity")).toBeVisible();
  if (!phone) {
    // 1280x800: every Transform value (and the Crop & flip / Speed headers) is inside the panel without scrolling.
    const body = (await page.locator(".insp-body").boundingBox())!;
    for (const id of ["insp-slider-position_x", "insp-slider-scale_x", "insp-slider-rotation", "insp-slider-opacity"]) {
      const b = (await page.getByTestId(id).boundingBox())!;
      expect(b.y + b.height, id).toBeLessThanOrEqual(body.y + body.height + 1);
    }
    // The Reset row is not a floating bar over the fields.
    expect(await page.getByTestId("insp-reset").evaluate((e) => getComputedStyle(e.parentElement!).position)).not.toBe("sticky");
  }

  // The group diamond keys position, scale and rotation at once; the per-field diamonds follow.
  const group = page.getByTestId("insp-key-transform");
  await expect(group).toHaveAttribute("aria-pressed", "false");
  await group.click();
  await expect(group).toHaveAttribute("aria-pressed", "true");
  for (const k of ["position_x", "position_y", "scale_x", "rotation"]) await expect(page.getByTestId(`insp-key-${k}`)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("insp-key-opacity")).toHaveAttribute("aria-pressed", "false"); // opacity is its own key

  // Easing: a button with the curve and its name, a menu of five curves (not a native select).
  const ease = page.getByTestId("insp-ease-position_x");
  await expect(ease).toHaveAttribute("data-value", "linear");
  await expect(page.locator("select.insp-ease")).toHaveCount(0);
  await ease.click();
  await expect(page.getByRole("menuitemradio")).toHaveCount(5);
  await page.getByTestId("insp-ease-position_x-ease-in-out").click();
  await expect(ease).toHaveAttribute("data-value", "ease-in-out");
  await expect(ease).toContainText("Ease in-out");

  await group.click(); // and one click takes the group's keys away
  await expect(group).toHaveAttribute("aria-pressed", "false");
});

test("a Projects button in the editor, and a new project is named by its date", async ({ page }) => {
  await ready(page);
  const back = page.getByTestId("topbar-projects");
  await expect(back).toBeVisible();
  expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(36);
  await back.click();
  await expect(page.getByTestId("projects-home")).toBeVisible();
  await page.getByTestId("projects-new").click();
  await expect(page.getByLabel("Project name")).toHaveValue(/^Project \S+/, { timeout: 20_000 });
  // The name field's underline is a straight line, not a bordered arc.
  const edge = await page.getByLabel("Project name").evaluate((e) => ({ bw: getComputedStyle(e).borderBottomWidth, r: getComputedStyle(e).borderBottomLeftRadius }));
  expect(edge).toEqual({ bw: "0px", r: "0px" });
});

test("the exported file is named after the project", async ({ page }, info) => {
  test.setTimeout(120_000);
  await ready(page);
  await page.getByLabel("Project name").fill("My film");
  await page.getByLabel("Project name").blur();
  await openMedia(page, info.project.name === "phone");
  await page.getByTestId("media-input").setInputFiles(file("flash_click.mp4"));
  await expect(page.locator("#tl-summary")).toContainText("1 clip");
  await page.getByTestId("export-open").click();
  await page.getByTestId("export-go").click();
  await expect(page.getByTestId("export-done")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("export-filename")).toHaveText(/^My film\.(mp4|webm)$/);
});
