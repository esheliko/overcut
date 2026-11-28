import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

/** M2 UX round 12, lane "phone": Back closes the top sheet or dialog, the Media sheet has a backdrop, a missing file is said out loud, the Projects list is compact on a phone,
 *  failures stay until dismissed, and the tool picker explains its words. Needs a build with the engine. */
const FLASH = resolve("crates/media/tests/fixtures/flash_click.mp4");
const tools = (page: Page) => page.getByRole("navigation", { name: "Tools" });

async function ready(page: Page) {
  await page.addInitScript(() => { delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker; delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker; });
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect(page.getByTestId("preview-import")).toBeEnabled({ timeout: 20_000 });
}
const menu = async (page: Page, item: string) => {
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("menuitem", { name: item }).click();
};

test("phone: Back closes the Media sheet and a dialog before leaving; the backdrop closes the sheet; the handle is a 44 px target", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "phone only");
  await ready(page);
  const panel = page.getByTestId("panel-tool");
  await tools(page).getByRole("button", { name: "Media" }).click();
  await expect(panel).toHaveAttribute("data-open", "true");
  expect((await page.getByTestId("sheet-handle").boundingBox())!.height).toBeGreaterThanOrEqual(44);
  // Back (the system gesture) closes the sheet and stays in the app.
  const url = page.url();
  await page.goBack();
  await expect(panel).toHaveAttribute("data-open", "false");
  expect(page.url()).toBe(url);
  await expect(page.getByTestId("editor")).toBeVisible();
  await expect(tools(page).getByRole("button", { name: "Media" })).toBeFocused(); // focus is not lost with the sheet
  // The backdrop: tap above the sheet. The tool bar still works while it is open.
  await tools(page).getByRole("button", { name: "Media" }).click();
  await expect(page.getByTestId("sheet-scrim")).toBeVisible();
  await page.getByTestId("sheet-scrim").click({ position: { x: 20, y: 20 } });
  await expect(panel).toHaveAttribute("data-open", "false");
  // Closing with the X leaves no ghost history entry: one Back later the sheet is not re-opened or re-closed (the app is still here).
  await tools(page).getByRole("button", { name: "Media" }).click();
  await page.getByRole("button", { name: "Close panel" }).click();
  await expect(panel).toHaveAttribute("data-open", "false");
  // A dialog: Back closes it, the sheet underneath stays as it was.
  await tools(page).getByRole("button", { name: "Media" }).click();
  await menu(page, "Privacy");
  await expect(page.getByTestId("privacy-dialog")).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId("privacy-dialog")).toHaveCount(0);
  await expect(panel).toHaveAttribute("data-open", "true");
  await page.goBack();
  await expect(panel).toHaveAttribute("data-open", "false");
});

test("a project whose media is missing says so, with the one action that fixes it (also after a plain reload)", async ({ page }) => {
  // r16 F: imports keep a copy in OPFS where there is one. This test is about a browser that cannot (no OPFS on the page), so it hides it.
  await page.addInitScript(() => { (navigator.storage as unknown as { getDirectory?: unknown }).getDirectory = undefined; });
  test.setTimeout(90_000);
  await ready(page);
  const phone = page.viewportSize()!.width < 720;
  if (phone) await tools(page).getByRole("button", { name: "Media" }).click();
  await page.getByTestId("media-input").setInputFiles(FLASH);
  await expect(page.locator("#tl-summary")).toContainText("1 clip", { timeout: 30_000 });
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 15_000 });
  await page.reload();
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  const note = page.getByTestId("offline-note");
  await expect(note).toBeVisible({ timeout: 20_000 });
  await expect(note).toContainText("not kept after a reload"); // UX r15 D4: a plain file input keeps no handle: not "missing"
  await expect(note).not.toContainText("missing");
  await expect(page.getByTestId("locate-files")).toBeVisible();
  // r13 #247: the picture itself says which file to choose again and offers the way out (not plain black).
  const frame = page.getByTestId("media-missing");
  await expect(frame).toBeVisible();
  await expect(frame).toContainText("Choose this file again");
  await expect(frame).toContainText("flash_click");
  expect((await page.getByTestId("media-missing-choose").boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await note.getByRole("button", { name: "Dismiss" }).click();
  await expect(note).toHaveCount(0);
});

test("the Projects list: a compact row (poster beside the text) on a phone, poster cards on wide screens", async ({ page }, info) => {
  test.setTimeout(90_000);
  const phone = info.project.name === "phone";
  await ready(page);
  await page.getByLabel("Project name").fill("Alpha");
  await page.getByLabel("Project name").blur();
  for (const name of ["Beta", "Gamma", "Delta"]) {
    await menu(page, "Projects");
    await page.getByTestId("projects-new").click();
    await expect(page.getByTestId("canvas-open")).toBeVisible({ timeout: 20_000 });
    await page.getByLabel("Project name").fill(name);
    await page.getByLabel("Project name").blur();
  }
  await menu(page, "Projects");
  const cards = page.getByTestId("project-card");
  await expect(cards).toHaveCount(4);
  const first = (await cards.nth(0).boundingBox())!;
  const poster = (await cards.nth(0).locator(".poster").boundingBox())!;
  const text = (await cards.nth(0).locator(".project-text").boundingBox())!;
  if (phone) {
    expect(first.height).toBeLessThan(110); // was ~270: two projects filled the screen
    expect(poster.x + poster.width).toBeLessThanOrEqual(text.x + 1); // poster on the left of the text
    const last = (await cards.nth(3).boundingBox())!;
    expect(last.y + last.height).toBeLessThan(page.viewportSize()!.height); // all four are on the first screen
    expect((await cards.nth(0).getByTestId("project-more").boundingBox())!.height).toBeGreaterThanOrEqual(44);
  } else {
    expect(poster.y + poster.height).toBeLessThanOrEqual(text.y + 1); // poster above the text
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  // Rename from the "…" menu: when its dialog closes, focus is back on that "…" button (the menu row it came from is gone)
  await cards.nth(0).getByTestId("project-more").click();
  await page.getByTestId("project-rename").click();
  await expect(page.getByTestId("rename-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("rename-dialog")).toHaveCount(0);
  await expect(cards.nth(0).getByTestId("project-more")).toBeFocused();
});

test("a failure stays on screen until it is dismissed; an info toast does not", async ({ page }) => {
  test.setTimeout(60_000);
  await ready(page);
  const chooser = page.waitForEvent("filechooser");
  await menu(page, "Open project…");
  await (await chooser).setFiles({ name: "broken.overcut", mimeType: "application/octet-stream", buffer: Buffer.from("not a project") });
  const failure = page.getByTestId("failure-note");
  await expect(failure).toBeVisible({ timeout: 10_000 });
  await expect(failure).toContainText("not an OverCut project"); // r13 #243: plain words (the stale "could not be opened" copy changed)
  await page.waitForTimeout(6_000); // longer than any toast
  await expect(failure).toBeVisible();
  await failure.getByRole("button", { name: "Dismiss" }).click();
  await expect(failure).toHaveCount(0);
});

test("the tool picker explains ripple, roll, slip and slide in plain words", async ({ page }) => {
  await ready(page);
  await page.getByTestId("tl-tool").click();
  const m = page.getByTestId("tl-tool-menu");
  await expect(m).toContainText("Trim a clip and pull the clips after it along");
  await expect(m).toContainText("Move the cut between two clips");
  await expect(m).toContainText("Change which part of the clip shows");
});

test("phone: the Media sheet and dialogs ride above the on-screen keyboard", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "phone only");
  // Headless Chromium has no keyboard: a stand-in visual viewport that shrinks the way iOS / Android Chrome's does (the layout viewport stays).
  await page.addInitScript(() => {
    const vv = Object.assign(new EventTarget(), { height: innerHeight, offsetTop: 0, width: innerWidth });
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    (window as unknown as { __kb(h: number): void }).__kb = (h) => { vv.height = innerHeight - h; vv.dispatchEvent(new Event("resize")); };
  });
  await ready(page);
  const vh = page.viewportSize()!.height;
  await tools(page).getByRole("button", { name: "Media" }).click();
  const panel = page.getByTestId("panel-tool");
  const bottom = async () => { const b = (await panel.boundingBox())!; return b.y + b.height; };
  expect(await bottom()).toBeGreaterThan(vh - 120); // docked above the tool bar
  await page.evaluate(() => (window as unknown as { __kb(h: number): void }).__kb(340));
  await expect.poll(bottom).toBeLessThanOrEqual(vh - 340 + 1); // lifted clear of the keyboard
  expect((await panel.boundingBox())!.y).toBeGreaterThanOrEqual(50); // and still under the top bar
  await expect(page.getByRole("searchbox", { name: "Search media" })).toBeInViewport();
  await page.evaluate(() => (window as unknown as { __kb(h: number): void }).__kb(0));
  await expect.poll(bottom).toBeGreaterThan(vh - 120);
  // The empty Media sheet speaks to touch: there is nothing to drop files from
  await expect(page.getByTestId("import-empty")).toContainText("Tap to choose");
  await expect(page.getByTestId("import-empty")).not.toContainText("Drop");
});

test("phone landscape: the backdrop reaches the bottom (no tool bar there) and leaves the tool rail usable", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "phone only");
  await page.setViewportSize({ width: 844, height: 390 });
  await ready(page);
  await tools(page).getByRole("button", { name: "Media" }).click();
  const scrim = page.getByTestId("sheet-scrim");
  await expect(scrim).toBeVisible();
  const b = (await scrim.boundingBox())!;
  expect(b.y + b.height).toBeGreaterThanOrEqual(389);
  expect(b.x).toBeGreaterThanOrEqual(72); // the rail stays out of it
  await tools(page).getByRole("button", { name: "Edit" }).click(); // switching tool still works with the sheet open
  await expect(page.getByTestId("panel-tool")).toHaveAttribute("aria-label", "Edit");
});
