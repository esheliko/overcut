import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * TL-19 background fill (docs/features/background.md): a 4:3 clip on a 9:16 canvas leaves the top and bottom bands empty. They are black until the
 * Canvas dialog's Background says otherwise: a flat colour, or the clip itself enlarged and blurred. The preview shows it and the exporter's frame is
 * the same pixels (`parity`: same compositor, same call). Headless Chromium has a software GPU: the asserts are about colour, not speed.
 */
const CLIP = resolve("crates/media/tests/fixtures/h264_aac.mp4"); // 160x120 testsrc, colourful from the first frame
type Hook = {
  gpu(): Promise<{ canvas: { width: number; height: number } }>;
  probe(x: number, y: number): Promise<number[]>;
  parity(frame: number): Promise<{ layers: number; previewVsReadback: number; previewVsCanvasCapture: number; lit: boolean; error?: string }>;
};

/** The preview canvas pixel at (fx, fy) of its size, as [r, g, b] (asked of the Worker that owns the canvas). */
const pixel = (page: Page, fx: number, fy: number): Promise<number[]> =>
  page.evaluate(async ([fx, fy]) => {
    const h = (window as unknown as { __overcutPreview: Hook }).__overcutPreview;
    const { canvas } = await h.gpu();
    return h.probe(Math.round(canvas.width * fx!), Math.round(canvas.height * fy!));
  }, [fx, fy] as const);

const setBackground = async (page: Page, change: (page: Page) => Promise<void>) => {
  await page.getByTestId("canvas-open").click();
  await expect(page.getByTestId("canvas-dialog")).toBeVisible();
  await change(page);
  await page.getByTestId("canvas-apply").click();
  await expect(page.getByTestId("canvas-dialog")).toBeHidden();
};

test("background: black by default, then blur and colour fill the empty bands; the export frame is the same pixels", async ({ page }, info) => {
  test.setTimeout(120_000);
  const phone = info.project.name === "phone";
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect(page.getByTestId("preview-import")).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId("preview-input").setInputFiles(CLIP);
  await expect(page.locator(".canvas")).toHaveAttribute("data-loaded", "true", { timeout: 20_000 });

  // A vertical canvas: the 4:3 picture is a band across the middle, the top and bottom are empty.
  await setBackground(page, async (p) => {
    await p.getByTestId("canvas-shape").selectOption("9:16");
    await expect(p.getByTestId("canvas-bg-mode")).toHaveValue("black");
  });
  await expect.poll(async () => { const b = (await page.locator(".canvas").boundingBox())!; return b.height > b.width; }).toBe(true);
  const top = () => pixel(page, 0.5, 0.04);
  const middle = () => pixel(page, 0.5, 0.5);
  await expect.poll(async () => Math.max(...(await middle())), { timeout: 15_000 }).toBeGreaterThan(20); // the picture is on screen
  expect((await top()).slice(0, 3), "black by default").toEqual([0, 0, 0]);

  // Blur: the top band now shows the picture, smeared.
  await setBackground(page, async (p) => {
    await p.getByTestId("canvas-bg-mode").selectOption("blur");
    await expect(p.getByTestId("canvas-bg-blur")).toBeVisible();
    await expect(p.getByTestId("canvas-bg-note")).toContainText("empty space");
    if (phone) {
      await p.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running")); // settled: mid-slide boxes read 43.99997 px
      for (const id of ["canvas-bg-mode", "canvas-bg-blur", "canvas-apply"]) expect((await p.getByTestId(id).boundingBox())!.height, id).toBeGreaterThanOrEqual(44);
    }
  });
  await expect.poll(async () => Math.max(...(await top()).slice(0, 3)), { timeout: 15_000 }).toBeGreaterThan(20);
  await expect(page.getByTestId("canvas-open")).toBeVisible();

  // Preview and export draw the same pixels, background included (desktop only: it does not depend on the viewport).
  if (!phone) {
    const r = await page.evaluate(() => (window as unknown as { __overcutPreview: Hook }).__overcutPreview.parity(0));
    expect(r.error).toBeUndefined();
    expect(r.layers).toBe(1);
    expect(r.previewVsReadback).toBeLessThanOrEqual(3);
    expect(r.previewVsCanvasCapture).toBeLessThanOrEqual(3);
  }

  // Colour: a swatch, exactly that colour in the band (sRGB-exact through the linear accumulation, within the golden tolerance).
  await setBackground(page, async (p) => {
    await p.getByTestId("canvas-bg-mode").selectOption("colour");
    await p.getByTestId("canvas-bg-colour-ef4444").click();
    await expect(p.getByTestId("canvas-bg-colour-ef4444")).toHaveAttribute("aria-checked", "true");
  });
  await expect.poll(async () => { const [r, g, b] = await top(); return Math.abs(r! - 0xef) + Math.abs(g! - 0x44) + Math.abs(b! - 0x44); }, { timeout: 15_000 }).toBeLessThanOrEqual(9);

  // One undo step each: Undo goes back to blur, again to black.
  const undo = page.getByRole("button", { name: /^Undo( (?!recovery).+)?$/ });
  await undo.click();
  await expect.poll(async () => { const p = await top(); return p[0] !== 0xef && Math.max(...p.slice(0, 3)) > 20; }, { timeout: 15_000 }).toBe(true);
  await undo.click();
  await expect.poll(async () => Math.max(...(await top()).slice(0, 3)), { timeout: 15_000 }).toBe(0);
  expect(errors).toEqual([]);
});
