import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Pictures on the timeline: the preview shows them and the export contains them (they used to be black, and the export failed). Needs a build with the engine. */
const FIX = resolve("crates/media/tests/fixtures");
type Hook = { probe(x: number, y: number): Promise<number[]>; player: { endFrame: number } };

async function ready(page: Page) {
  await page.addInitScript(() => { delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker; });
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect(page.getByTestId("preview-import")).toBeEnabled({ timeout: 20_000 });
  if ((page.viewportSize()?.width ?? 0) < 720) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click();
}
const pixel = (page: Page) => page.evaluate(() => (window as unknown as { __overcutPreview: Hook }).__overcutPreview.probe(30, 30));

test("a picture shows in the preview, lasts 5 s, and exports as a picture (not black, not an error)", async ({ page }, info) => {
  test.setTimeout(120_000);
  await ready(page);
  await page.getByTestId("media-input").setInputFiles(resolve(FIX, "still_red.png"));
  await expect(page.locator("#tl-summary")).toContainText("1 clip", { timeout: 20_000 });
  await expect(page.getByTestId("timecode")).toContainText("/ 00:00:05:00");
  await expect.poll(async () => (await pixel(page))[0], { timeout: 15_000 }).toBeGreaterThan(200); // red, not black
  const [, g, b] = await pixel(page);
  expect(g).toBeLessThan(60);
  expect(b).toBeLessThan(60);

  await page.getByTestId("export-open").click();
  await page.getByTestId("export-go").click();
  await expect(page.getByTestId("export-done")).toBeVisible({ timeout: 90_000 });
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-save").click()]);
  const path = info.outputPath(`still.${download.suggestedFilename().split(".").pop()}`);
  await download.saveAs(path);
  expect(readFileSync(path).length).toBeGreaterThan(1000);

  let ffmpeg = true;
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch { ffmpeg = false; }
  if (ffmpeg) { // the middle of the file is the red picture
    const px = execFileSync("ffmpeg", ["-v", "error", "-ss", "2.5", "-i", path, "-vf", "scale=1:1:flags=area,format=rgb24", "-frames:v", "1", "-f", "rawvideo", "-"]);
    expect(px[0]).toBeGreaterThan(200);
    expect(px[1]).toBeLessThan(60);
    expect(px[2]).toBeLessThan(60);
  }
});

test("a portrait picture sets the canvas,", async ({ page }) => {
  await ready(page);
  await page.getByTestId("media-input").setInputFiles(resolve(FIX, "still_blue_portrait.jpg"));
  await expect(page.locator("#tl-summary")).toContainText("1 clip", { timeout: 20_000 });
  await expect.poll(async () => (await pixel(page))[2], { timeout: 15_000 }).toBeGreaterThan(200); // blue
  const box = (await page.locator(".canvas").boundingBox())!;
  expect(box.height).toBeGreaterThan(box.width); // 200 x 300
});
