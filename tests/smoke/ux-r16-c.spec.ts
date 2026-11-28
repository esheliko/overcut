import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { gutterShift } from "./timeline-geometry";

/** UX r16 lane C: phone gizmo and pinch, Back with menus open, the timeline's default height and splitter pill, toasts clear of the transport, tooltips that wrap, hidden menu rows, the Projects home tile. Needs a build with the engine. */
const FLASH = resolve("crates/media/tests/fixtures/flash_click.mp4");
const PORTRAIT = resolve("crates/media/tests/fixtures/rotated90.mp4"); // a vertical picture: the project canvas is 9:16, so the stage has room beside the frame

async function ready(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect(page.getByTestId("preview-import")).toBeEnabled({ timeout: 20_000 });
}
async function importClip(page: Page, phone: boolean, file = FLASH) {
  if (phone) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click();
  await page.getByTestId("media-input").setInputFiles(file);
  await expect(page.locator(".canvas")).toHaveAttribute("data-loaded", "true", { timeout: 30_000 });
  if (phone) await page.getByRole("button", { name: "Close panel" }).click({ timeout: 3000 }).catch(() => undefined);
}

test("phone: Back closes the timeline More menu and the app menu, never leaves the app (PHONE-2)", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "phone only");
  await ready(page);
  const url = page.url();
  await page.getByTestId("tl-more").click();
  await expect(page.getByTestId("tl-more-menu")).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId("tl-more-menu")).toHaveCount(0);
  expect(page.url()).toBe(url);
  await page.getByRole("button", { name: "Menu" }).first().click().catch(async () => page.getByLabel(/menu/i).first().click());
  await expect(page.getByRole("menu").first()).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect(page.url()).toBe(url);
});

test("phone: a selected clip shows its gizmo with no sheet, two fingers pinch it bigger (PHONE-1)", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "phone only");
  await ready(page);
  await importClip(page, true);
  const box = (await page.getByTestId("timeline-canvas").boundingBox())!;
  const dg = await gutterShift(page);
  await page.touchscreen.tap(box.x + dg + 68, box.y + 56);
  const th = page.locator(".th");
  await expect(th).toBeVisible(); // no Edit sheet is open
  await expect(page.locator('.library[data-open="true"]')).toHaveCount(0);
  const before = (await th.boundingBox())!;
  const pic = (await page.locator(".canvas").boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const cx = pic.x + pic.width / 2, cy = pic.y + pic.height / 2;
  const pts = (d: number) => [{ x: cx - d, y: cy, id: 1 }, { x: cx + d, y: cy, id: 2 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts(10) });
  for (let d = 12; d <= 36; d += 6) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pts(d) });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(async () => (await th.boundingBox())!.width, { timeout: 5000 }).toBeGreaterThan(before.width * 1.5);
});

test("phone: a tap on the stage outside the picture frame deselects the clip (PHONE-1)", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "phone only");
  await ready(page);
  await importClip(page, true, PORTRAIT);
  const box = (await page.getByTestId("timeline-canvas").boundingBox())!;
  const dg = await gutterShift(page);
  await page.touchscreen.tap(box.x + dg + 68, box.y + 56);
  await expect(page.locator(".th")).toBeVisible();
  const stage = (await page.locator(".stage-view").boundingBox())!;
  await page.touchscreen.tap(stage.x + 6, stage.y + 6);
  await expect(page.locator(".th")).toHaveCount(0);
});

test("desktop: the timeline is about 40 % of the editor by default and the splitter shows a grab pill (DESK-4)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop only");
  await page.setViewportSize({ width: 1440, height: 900 });
  await ready(page);
  const ws = (await page.locator(".workspace").boundingBox())!, tl = (await page.locator(".timeline").boundingBox())!;
  expect(tl.height / ws.height).toBeGreaterThan(0.37);
  expect(tl.height / ws.height).toBeLessThan(0.52);
  const pill = await page.locator(".splitter > span").evaluate((el) => ({ w: el.getBoundingClientRect().width, o: getComputedStyle(el).opacity }));
  expect(pill.w).toBeGreaterThanOrEqual(40);
  expect(Number(pill.o)).toBeGreaterThan(0.5);
});

test("desktop: a toast sits above the player bar, tooltips wrap, the More menu hides rows that cannot apply (FIRST-8, FIRST-7, FIRST-11)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop only");
  await ready(page);
  await importClip(page, false);
  const toast = page.locator(".toast");
  await expect(toast).toContainText(/\S/, { timeout: 10_000 }).catch(() => undefined);
  if (await toast.count() && (await toast.evaluate((e) => e.textContent ?? "")).trim()) {
    const t = (await toast.boundingBox())!, bar = (await page.locator(".player-bar").boundingBox())!;
    expect(t.y + t.height).toBeLessThanOrEqual(bar.y + 1);
  }
  await page.getByTestId("tl-magnetic").hover();
  const tip = page.locator(".tb:has([data-testid=tl-magnetic]) .tb-tip");
  await expect(tip).toBeVisible();
  const m = await tip.evaluate((e) => ({ w: e.getBoundingClientRect().width, sw: e.scrollWidth, cw: e.clientWidth }));
  expect(m.w).toBeLessThanOrEqual(322);
  expect(m.sw).toBeLessThanOrEqual(m.cw + 1);
  await page.getByTestId("tl-more").click();
  await expect(page.getByTestId("tl-duplicate")).toHaveCount(0); // nothing selected: the clip rows are not shown
  const menu = (await page.getByTestId("tl-more-menu").boundingBox())!;
  expect(menu.width).toBeGreaterThanOrEqual(270);
  expect(menu.y).toBeGreaterThanOrEqual(0);
  expect(menu.y + menu.height).toBeLessThanOrEqual(page.viewportSize()!.height);
});

test("projects home: New project is the first tile on wider screens and there is no full-width bar (FIRST-5)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop only");
  await ready(page);
  await importClip(page, false);
  await page.getByRole("button", { name: "Projects" }).first().click();
  const tile = page.getByTestId("projects-new-first");
  await expect(tile).toBeVisible();
  await expect(page.getByTestId("projects-new-fab")).toBeHidden();
  const b = (await tile.boundingBox())!;
  expect(b.width).toBeLessThan(page.viewportSize()!.width / 2);
});
