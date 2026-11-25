import { expect, test } from "@playwright/test";
import { gutterShift } from "./timeline-geometry";

/** Edge auto-scroll (M2): holding a drag near an edge of the timeline scrolls it, and the clip keeps following. */
test("mouse: a drag held at the left edge scrolls the timeline back", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "mouse drag");
  await page.goto("/?sample");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  const canvas = page.getByTestId("timeline-canvas");
  await page.getByRole("slider", { name: "Playhead position" }).press("End"); // the playhead stays in view when zooming (M1), so it sits at the end for the zoomed view to scroll
  await canvas.focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press("+"); // zoomed in: the content is wider than the canvas
  await expect.poll(async () => Number(await canvas.getAttribute("data-scrollx"))).toBeGreaterThan(100);
  const s0 = Number(await canvas.getAttribute("data-scrollx"));
  const box = (await canvas.boundingBox())!;
  const dg = await gutterShift(page);
  const y = box.y + 30 + 26;
  await page.mouse.move(box.x + dg + 300, y);
  await page.mouse.down();
  await page.mouse.move(box.x + dg + 250, y, { steps: 4 });
  await page.mouse.move(box.x + dg + 48 + 8, y, { steps: 8 }); // into the left edge zone, then hold
  await expect.poll(async () => Number(await canvas.getAttribute("data-scrollx")), { timeout: 5000 }).toBeLessThan(s0 - 100);
  await page.mouse.up();
});
