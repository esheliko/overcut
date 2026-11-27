import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * esheliko/overcut#209: clips of different sizes on one canvas must never make the GPU reject a texture copy ("wgpu: Validation Error
 * copy_external_image_to_texture ... overrunning the bounds of the Source texture"). The Worker's console is not visible to Playwright, so the renderer
 * counts the uncaptured GPU errors it reported there (`alloc.errors`); a healthy run has none. Both upload paths are driven: `frame` hands the VideoFrame
 * to the compositor (the copy that failed), `cpu` uploads RGBA bytes.
 */
const FIX = resolve("crates/media/tests/fixtures");
type Hook = { player: { seek(f: number): void }; gpu(): Promise<{ info: { backend: string; adapter: string }; alloc: { errors: number }; upload?: { path: string } }>; media(): Promise<unknown[]> };


async function importMixed(page: Page): Promise<void> {
  await page.addInitScript(() => { const w = window as unknown as Record<string, unknown>; delete w.showSaveFilePicker; delete w.showOpenFilePicker; }); // the plain file input
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect(page.getByTestId("preview-import")).toBeEnabled({ timeout: 20_000 });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: /^Import media$/ }).first().click();
  // 160x120, 320x180, 160x120: the canvas takes the first clip's size, the middle clip is larger than the canvas.
  await (await chooser).setFiles([`${FIX}/h264_aac.mp4`, `${FIX}/flash_click.mp4`, `${FIX}/h264_aac.mp4`]);
  await expect(page.locator("#tl-summary")).toContainText("3 clips", { timeout: 30_000 });
}

for (const path of ["frame", "cpu"] as const) {
  test(`mixed-size clips scrub and play without GPU errors (${path} upload)`, async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "the GPU path does not depend on the viewport");
    test.setTimeout(120_000);
    await importMixed(page);
    // Pin the device-measured upload choice (cached per backend, GPU and browser version in local storage), then start over so the Worker reads it.
    const g = await page.evaluate(async () => { const { info } = await (window as unknown as { __overcutPreview: Hook }).__overcutPreview.gpu(); return { info, ua: navigator.userAgent }; });
    await page.evaluate(([i, ua, p]) => { const v = /(Edg|CriOS|Firefox|Chrome|Version)\/([\d.]+)/.exec(ua)!; localStorage.setItem("overcut.uploadPath", JSON.stringify({ [`${i.backend}|${i.adapter}|${v[1]}/${v[2]}|v2`]: { path: p, ms: {} } })); }, [g.info, g.ua, path] as const);
    await page.reload();
    await importMixed(page);
    await page.evaluate(async () => {
      for (const f of [0, 20, 29, 31, 45, 60, 75, 89, 100, 119, 121, 140, 149, 5, 70, 35, 125]) { (window as unknown as { __overcutPreview: Hook }).__overcutPreview.player.seek(f); await new Promise((r) => setTimeout(r, 400)); }
    });
    await page.keyboard.press("Space");
    await page.waitForTimeout(2500);
    const after = await page.evaluate(() => (window as unknown as { __overcutPreview: Hook }).__overcutPreview.gpu());
    expect(after.upload?.path).toBe(path);
    expect(after.alloc.errors).toBe(0);
  });
}
