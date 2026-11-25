import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

/** Every visible button is styled by the app: none falls back to the browser's own grey button with a raised (outset) border.
 *  Main actions that only have `.export-go` (Projects "New project", dialog OK / Apply / Save) are filled with the accent colour. Needs a build with the engine. */
const FIX = resolve("crates/media/tests/fixtures");

const browserChrome = (page: Page) => page.evaluate(() => [...document.querySelectorAll("button")].filter((b) => {
  const r = b.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const s = getComputedStyle(b);
  return s.borderTopStyle === "outset" || s.borderTopStyle === "inset";
}).map((b) => (b.getAttribute("data-testid") || b.getAttribute("aria-label") || b.textContent || "").trim().slice(0, 40)));

const accentFilled = (page: Page, testId: string) => page.getByTestId(testId).evaluate((b) => {
  const probe = document.createElement("span");
  probe.style.color = "var(--accent)";
  document.body.append(probe);
  const accent = getComputedStyle(probe).color;
  probe.remove();
  return getComputedStyle(b).backgroundColor === accent;
});

test("no button falls back to the browser's grey style; main actions are accent-filled", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  if ((page.viewportSize()?.width ?? 0) < 720) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click();
  await page.getByTestId("media-input").setInputFiles(resolve(FIX, "vp9_opus.webm"));
  await expect(page.locator("#tl-summary")).toContainText("2 clips", { timeout: 30_000 });
  const phone = (page.viewportSize()?.width ?? 0) < 720;
  const mediaTab = page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" });
  if (phone && !(await page.getByTestId("bin-tag-edit").first().isVisible())) await mediaTab.click(); // the sheet closes after an import on a phone
  await expect(page.getByTestId("bin-tag-edit").first()).toBeVisible();
  expect(await browserChrome(page)).toEqual([]); // editor, media bin (Tags) included
  if (phone) await page.getByRole("button", { name: "Close" }).first().click();

  await page.getByTestId("canvas-open").click();
  await expect(page.getByTestId("canvas-apply")).toBeVisible();
  expect(await browserChrome(page)).toEqual([]);
  expect(await accentFilled(page, "canvas-apply")).toBe(true);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("menuitem", { name: "Projects" }).click();
  await expect(page.getByTestId("projects-new")).toBeVisible();
  expect(await browserChrome(page)).toEqual([]);
  expect(await accentFilled(page, "projects-new")).toBe(true);
});
