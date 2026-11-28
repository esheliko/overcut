import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

/** UX r15 lane D (customer phone feedback): one-row phone notes and the "choose again" wording, the short phone menu, Snapping and Ripple rows in More,
 *  the overlay fullscreen on touch phones, the phone preview/timeline grab bar, the Filter popover and the theme icon. */
const FLASH = resolve("crates/media/tests/fixtures/flash_click.mp4");

const boot = async (page: Page) => {
  await page.addInitScript(() => { delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker; delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker; });
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect(page.getByTestId("preview-import")).toBeEnabled({ timeout: 20_000 });
};
const isPhone = (info: { project: { name: string } }) => info.project.name === "phone";
const importOne = async (page: Page, phone: boolean) => {
  if (phone) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click();
  await page.getByTestId("media-input").setInputFiles(FLASH);
  await expect(page.locator("#tl-summary")).toContainText("1 clip", { timeout: 30_000 });
};

test("a file that cannot survive a reload says 'choose it again' in ONE compact row (icon, text, action, close), at 360 and 390", async ({ page }, info) => {
  test.skip(!isPhone(info), "phone only");
  test.setTimeout(120_000);
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await boot(page);
    await importOne(page, true);
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 15_000 });
    await page.reload();
    const note = page.getByTestId("offline-note");
    await expect(note).toBeVisible({ timeout: 20_000 });
    await expect(note).toContainText("not kept after a reload");
    await expect(note).not.toContainText(/missing|not found/i);
    await expect(page.getByTestId("locate-files")).toHaveText("Choose files again");
    const [n, x, a] = await Promise.all([note.boundingBox(), note.getByRole("button", { name: "Dismiss" }).boundingBox(), page.getByTestId("locate-files").boundingBox()]);
    expect(n!.height).toBeLessThanOrEqual(64); // one row, not a tall card
    expect(x!.y).toBeLessThan(n!.y + n!.height / 2 + 24); // the X is on the same row as the text and the action
    expect(Math.abs(x!.y - a!.y)).toBeLessThan(24);
    expect(x!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await note.getByRole("button", { name: "Dismiss" }).click();
  }
});

test("phone menu: the theme is one row that opens its choices, no engine status, and the menu fits in 60% of a 640 px screen", async ({ page }, info) => {
  test.skip(!isPhone(info), "phone only");
  await page.setViewportSize({ width: 390, height: 640 });
  await boot(page);
  await page.getByRole("button", { name: "Menu" }).click();
  const pop = page.locator(".menu-pop");
  await expect(pop).toBeVisible();
  await expect(page.getByTestId("menu-theme")).toContainText("Theme:");
  await expect(page.getByTestId("theme-dark")).toHaveCount(0); // choices only while the row is open
  await expect(page.getByTestId("accent-picker")).toHaveCount(0);
  await expect(pop).not.toContainText(/engine|ready/i);
  await expect(page.getByTestId("save-state-menu")).toContainText("Saved on this device");
  const box = (await pop.boundingBox())!;
  expect(box.height).toBeLessThanOrEqual(640 * 0.6);
  expect(await pop.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true); // no scrolling
  await page.getByTestId("menu-theme").click();
  await expect(page.getByTestId("theme-dark")).toBeVisible();
  await expect(page.getByTestId("accent-picker")).toBeVisible();
  await page.getByTestId("theme-light").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  for (const b of await pop.locator("button").all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
});

test("narrow bar: Snapping and Ripple edits are switch rows in More with their state visible", async ({ page }, info) => {
  test.skip(!isPhone(info), "phone only");
  await boot(page);
  await importOne(page, true);
  await page.getByTestId("tl-more").click();
  const snap = page.getByTestId("tl-snap-row"), ripple = page.getByTestId("tl-magnetic-row");
  await expect(snap).toHaveAttribute("role", "menuitemcheckbox");
  await expect(ripple).toHaveAttribute("role", "menuitemcheckbox");
  await expect(snap).toHaveAttribute("aria-checked", "true");
  await expect(snap).toContainText("On");
  await snap.click();
  await expect(snap).toHaveAttribute("aria-checked", "false"); // the menu stays open: the change is seen
  await expect(snap).toContainText("Off");
  await ripple.click();
  await expect(ripple).toHaveAttribute("aria-checked", "false");
});

test("touch phone: fullscreen uses the app's own overlay (no browser 'press and hold to exit' notice over the controls)", async ({ page }, info) => {
  test.skip(!isPhone(info), "phone only");
  await boot(page);
  await importOne(page, true);
  await page.evaluate(() => { (window as unknown as { __rf: number }).__rf = 0; const orig = Element.prototype.requestFullscreen; Element.prototype.requestFullscreen = function (...a) { (window as unknown as { __rf: number }).__rf++; return orig.apply(this, a as never); }; });
  await page.getByTestId("fullscreen-toggle").click();
  await expect(page.locator('.stage[data-fs="overlay"]')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __rf: number }).__rf)).toBe(0);
  expect(await page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await page.getByTestId("fullscreen-toggle").click();
  await expect(page.locator('.stage[data-fs="overlay"]')).toHaveCount(0);
});

test("phone portrait: a grab bar (44 px) resizes the preview against the timeline, is remembered, and keeps the preview >= 30% and the timeline >= 260 px", async ({ page }, info) => {
  test.skip(!isPhone(info), "phone only");
  await page.setViewportSize({ width: 390, height: 700 });
  await boot(page);
  await importOne(page, true);
  await page.getByTestId("tl-more").click();
  await page.getByTestId("track-add-video").click(); // 3 tracks: the picture starts smaller so they all show
  await expect(page.locator(".workspace")).toHaveAttribute("data-tracks", "many");
  const bar = page.getByTestId("phone-splitter");
  await expect(bar).toBeVisible();
  expect((await bar.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const sizes = () => page.evaluate(() => ({ canvas: document.querySelector(".stage .canvas")!.getBoundingClientRect().height, stage: document.querySelector(".stage")!.getBoundingClientRect().height, tl: document.querySelector(".timeline")!.getBoundingClientRect().height, ws: document.querySelector(".workspace")!.getBoundingClientRect().height }));
  const a = await sizes();
  expect(a.tl).toBeGreaterThanOrEqual(260);
  const b0 = (await bar.boundingBox())!;
  await page.mouse.move(b0.x + b0.width / 2, b0.y + b0.height / 2);
  await page.mouse.down();
  await page.mouse.move(b0.x + b0.width / 2, b0.y - 100, { steps: 5 });
  await page.mouse.up();
  const b = await sizes();
  expect(b.canvas).toBeLessThan(a.canvas); // dragging up gives the timeline the room
  expect(b.tl).toBeGreaterThan(a.tl);
  expect(b.stage).toBeGreaterThanOrEqual(b.ws * 0.3 - 2);
  await page.keyboard.press("Tab"); // the bar is focusable: arrows nudge it
  await bar.focus();
  await page.keyboard.press("End");
  const c = await sizes();
  expect(c.tl).toBeGreaterThanOrEqual(259);
  await page.keyboard.press("Home");
  const d = await sizes();
  expect(d.stage).toBeGreaterThanOrEqual(d.ws * 0.3 - 2);
  await page.reload();
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect.poll(async () => Math.abs((await sizes()).canvas - d.canvas)).toBeLessThan(3); // remembered
});

test("Filter and sort is a compact popover over the cards: it does not push them down, rows are 32 px (mouse) / 44 px (touch)", async ({ page }, info) => {
  const phone = isPhone(info);
  await boot(page);
  await importOne(page, phone);
  const toggle = page.getByTestId("bin-filter-toggle");
  if (phone && !(await toggle.isVisible())) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click();
  await expect(toggle).toBeVisible();
  const card = page.getByTestId("bin-item").first();
  await page.waitForTimeout(700); // the phone sheet is still sliding in
  const y0 = (await card.boundingBox())!.y;
  await toggle.click();
  const pop = page.getByTestId("bin-filter-panel");
  await expect(pop).toBeVisible();
  expect((await card.boundingBox())!.y).toBe(y0); // nothing moved
  const min = phone ? 44 : 32;
  for (const id of ["bin-kind-video", "bin-kind-all", "bin-sort"]) expect((await page.getByTestId(id).boundingBox())!.height).toBeGreaterThanOrEqual(min - 0.5);
  const pb = (await pop.boundingBox())!;
  expect(pb.x).toBeGreaterThanOrEqual(0);
  expect(pb.x + pb.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.getByTestId("bin-kind-audio").click();
  await expect(page.getByTestId("bin-filter-on")).toHaveText("On"); // controls work, the popover stays open
  await expect(pop).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
  await expect(toggle).toBeFocused();
});

test("the theme button shows a sun or a moon (not an abstract half circle) and is still called Theme", async ({ page }, info) => {
  test.skip(isPhone(info), "desktop: the button is in the top bar");
  await page.emulateMedia({ colorScheme: "dark" });
  await boot(page);
  const toggle = page.getByTestId("theme-toggle");
  await expect(toggle).toHaveAttribute("title", "Theme");
  const dark = await toggle.locator("path").getAttribute("d");
  await toggle.click();
  await page.getByTestId("theme-light").click();
  const light = await toggle.locator("path").getAttribute("d");
  expect(light).not.toBe(dark); // sun for a light screen, moon for a dark one
  expect(dark).toMatch(/^M20\.5 14\.2/); // the moon
});
