import { expect, test } from "@playwright/test";

/** M2-043: a two-hour project zooms out to fit, the overview bar pans and zooms it, and two fingers pinch and pan on a phone. */
test("2 h project: fit, overview drag, zoom to selection", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "mouse drag; the pinch test covers the phone");
  await page.goto("/?sample=2h");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  const canvas = page.getByTestId("timeline-canvas");
  await expect(page.locator("#tl-summary")).toContainText("2,300 clips", { timeout: 30_000 });
  const pps = async () => Number(await canvas.getAttribute("data-pps"));
  const overview = page.getByTestId("tl-overview");
  await canvas.focus();
  await page.keyboard.press("0"); // fit the whole 2 h project: the whole width shows it, so the bar hides
  await expect.poll(pps).toBeLessThan(0.3);
  await expect(overview).toBeHidden();
  for (let i = 0; i < 4; i++) await page.keyboard.press("+"); // zoomed in: the bar appears with a window
  await expect(overview).toBeVisible();
  const bar = overview.locator("canvas");
  await expect.poll(async () => Number(await bar.getAttribute("data-win1"))).toBeGreaterThan(0);
  const box = (await bar.boundingBox())!;
  const win0 = Number(await bar.getAttribute("data-win0")), win1 = Number(await bar.getAttribute("data-win1"));
  const s0 = Number(await canvas.getAttribute("data-scrollx"));
  // Drag the window to the middle: the timeline scrolls there.
  const y = box.y + box.height / 2, mid = (win0 + win1) / 2;
  await page.mouse.move(box.x + mid, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Number(await canvas.getAttribute("data-scrollx"))).toBeGreaterThan(s0 + 300);
  // Drag the window's right edge outwards: the zoom drops.
  const p1 = await pps();
  const w1 = Number(await bar.getAttribute("data-win1"));
  await page.mouse.move(box.x + w1 - 3, y);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.min(box.width - 4, w1 + 60), y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(pps).toBeLessThan(p1);
  // Ctrl+wheel zooms around the pointer.
  const p2 = await pps();
  const cb = (await canvas.boundingBox())!;
  await page.mouse.move(cb.x + cb.width / 2, cb.y + 80);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -300);
  await page.keyboard.up("Control");
  await expect.poll(pps).toBeGreaterThan(p2);
  // Zoom to selection fits the selected clip to the width.
  await page.mouse.click(cb.x + cb.width / 2, cb.y + 30 + 26);
  await canvas.focus();
  const before = await pps();
  await page.keyboard.press("Shift+Z");
  await expect.poll(pps).not.toBe(before);
});

test("phone: two fingers pinch to zoom and drag to pan", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "touch");
  await page.goto("/?sample=2h");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  const canvas = page.getByTestId("timeline-canvas");
  const pps = async () => Number(await canvas.getAttribute("data-pps"));
  await expect(page.locator("#tl-summary")).toContainText("2,300 clips", { timeout: 30_000 });
  await page.getByTestId("tl-fit").click();
  await expect.poll(pps).toBeLessThan(0.3);
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + 80;
  const cdp = await page.context().newCDPSession(page);
  const touch = async (type: "touchStart" | "touchMove" | "touchEnd", pts: { x: number; y: number }[]) => {
    await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map((p, id) => ({ ...p, id })) });
  };
  const p0 = await pps();
  await touch("touchStart", [{ x: cx - 20, y: cy }, { x: cx + 20, y: cy }]);
  for (let k = 1; k <= 8; k++) await touch("touchMove", [{ x: cx - 20 - k * 12, y: cy }, { x: cx + 20 + k * 12, y: cy }]);
  await touch("touchEnd", []);
  await expect.poll(pps).toBeGreaterThan(p0 * 2); // fingers spread: zoomed in
  const s0 = Number(await canvas.getAttribute("data-scrollx"));
  await touch("touchStart", [{ x: cx - 30, y: cy }, { x: cx + 30, y: cy }]);
  for (let k = 1; k <= 8; k++) await touch("touchMove", [{ x: cx - 30 - k * 8, y: cy }, { x: cx + 30 - k * 8, y: cy }]); // both fingers slide left, same distance
  await touch("touchEnd", []);
  await expect.poll(async () => Number(await canvas.getAttribute("data-scrollx"))).toBeGreaterThan(s0 + 20); // content followed the fingers
});
