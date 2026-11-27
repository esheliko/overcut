import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * M2 UX r12 (a11y lane): axe-core (WCAG 2.0/2.1/2.2 A and AA) on every surface, in dark, light and high-contrast, at a phone (390x844) and a desktop (1440x900) size.
 * Target: zero serious or critical violations. Rules switched off are listed in DISABLED with the reason and the alternative that covers them.
 * The tests make their own context (viewport, touch, theme), so they run once, under the "desktop" project only.
 */
const FIX = resolve("crates/media/tests/fixtures");
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** Rules we do not run, with the reason. `color-contrast` is NOT disabled: the timeline is a <canvas> (axe cannot see inside it), the contrast of its painted colours is checked by tests/unit/theme-contrast.test.ts. */
const DISABLED: Record<string, string> = {};

const VIEWS = [
  { name: "phone", viewport: { width: 390, height: 844 }, touch: true },
  { name: "desktop", viewport: { width: 1440, height: 900 }, touch: false },
] as const;
const THEMES = ["dark", "light", "high-contrast"] as const;

type Found = { surface: string; id: string; impact: string; nodes: string[] };

async function scan(page: Page, surface: string, out: Found[], include?: string, exclude?: string): Promise<void> {
  let b = new AxeBuilder({ page }).withTags(TAGS).disableRules(Object.keys(DISABLED));
  if (include) b = b.include(include);
  if (exclude) b = b.exclude(exclude);
  const r = await b.analyze();
  for (const v of r.violations) {
    if (v.impact !== "serious" && v.impact !== "critical") continue;
    out.push({ surface, id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 4).map((n) => `${n.target.join(" ")} :: ${(n.failureSummary ?? "").split("\n").slice(1, 3).join(" ").slice(0, 160)}`) });
  }
}

for (const view of VIEWS) {
  for (const theme of THEMES) {
    test(`axe: every surface, ${theme}, ${view.name}`, async ({ browser }, info) => {
      test.skip(info.project.name !== "desktop", "makes its own viewport");
      test.setTimeout(240_000);
      const ctx = await browser.newContext({ viewport: view.viewport, hasTouch: view.touch, isMobile: view.touch, colorScheme: theme === "light" ? "light" : "dark" });
      const page = await ctx.newPage();
      await page.addInitScript((th) => { try { localStorage.setItem("overcut.theme", th); } catch { /* ignore */ } delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker; }, theme);
      const found: Found[] = [];
      const phone = view.touch;
      const tools = page.getByRole("navigation", { name: "Tools" });
      const menu = async () => { await page.getByRole("button", { name: "Menu" }).click(); await expect(page.getByRole("menu")).toBeVisible(); };
      const closeTop = async () => { await page.keyboard.press("Escape"); await page.waitForTimeout(250); };

      // 1. empty editor
      await page.goto("/");
      await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
      await expect(page.getByTestId("preview-import")).toBeEnabled({ timeout: 20_000 });
      await page.waitForTimeout(400);
      await scan(page, "empty editor", found);

      // 2. editor with clips and a selected clip
      if (phone) await tools.getByRole("button", { name: "Media" }).click();
      await page.getByTestId("media-input").setInputFiles([resolve(FIX, "flash_click.mp4"), resolve(FIX, "vp9_opus.webm")]);
      await expect(page.locator("#tl-summary")).toContainText("2 clips", { timeout: 30_000 });
      if (phone) {
        await scan(page, "media sheet", found);
        const close = page.getByRole("button", { name: "Close panel" });
        if (await close.isVisible()) await close.click();
      }
      const cv = page.getByTestId("timeline-canvas");
      const box = (await cv.boundingBox())!;
      const g = Number(await cv.getAttribute("data-gutter"));
      if (phone) await page.touchscreen.tap(box.x + g + 40, box.y + 56); else await page.mouse.click(box.x + g + 40, box.y + 56);
      await expect(page.getByTestId("tl-selected")).toContainText("1 clip");
      await scan(page, "editor with a selected clip", found);

      // 3. Details / Edit
      if (phone) { await tools.getByRole("button", { name: "Edit" }).click(); await expect(page.getByTestId("insp-position_x")).toBeVisible(); await page.waitForTimeout(600); /* the sheet slides in: scan the settled colours */ await scan(page, "edit sheet", found); await page.getByRole("button", { name: "Close panel" }).click(); }
      else await scan(page, "details panel", found, "[data-testid=panel-inspector]");

      // 4. context menu
      await cv.focus();
      await page.keyboard.press("Shift+F10");
      await expect(page.getByTestId("tl-clip-menu")).toBeVisible();
      await scan(page, "clip context menu", found, undefined, "[data-testid=tl-bar]"); // the toolbar behind the popover is covered by design (axe target-size "obscured"); its own sizes are scanned on the surfaces without a menu
      await closeTop();

      // 5. More menu (timeline) and app menu
      await page.getByTestId("tl-more").click();
      await page.waitForTimeout(250);
      await scan(page, "timeline more menu", found, undefined, "[data-testid=tl-bar]");
      await closeTop();
      await menu();
      await scan(page, "app menu", found);

      // 6. palette
      await page.getByTestId("menu-palette").click();
      await expect(page.getByTestId("palette-input")).toBeFocused();
      await scan(page, "command palette", found);
      await closeTop();

      // 7. shortcuts
      await menu(); await page.getByTestId("menu-shortcuts").click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await scan(page, "shortcuts dialog", found);
      await closeTop();

      // 8. privacy / network log
      await menu(); await page.getByTestId("menu-privacy").click();
      await expect(page.getByTestId("network-log")).toBeVisible();
      await scan(page, "privacy / network log", found);
      await closeTop();

      // 9. versions
      await menu(); await page.getByTestId("menu-versions").click();
      await expect(page.getByTestId("versions-save")).toBeVisible();
      await page.getByTestId("versions-save").click();
      await expect(page.getByTestId("version-item").first()).toBeVisible();
      await scan(page, "versions", found);
      await closeTop();

      // 10. canvas dialog
      await page.getByTestId("canvas-open").click();
      await expect(page.getByTestId("canvas-apply")).toBeVisible();
      await scan(page, "canvas dialog", found);
      await closeTop();

      // 11. export dialog
      await page.getByTestId("export-open").click();
      await expect(page.getByTestId("export-dialog")).toBeVisible();
      await expect(page.getByTestId("export-go")).toBeEnabled({ timeout: 30_000 });
      await scan(page, "export dialog", found);
      await closeTop();

      // 12. Projects home and project menu
      await menu(); await page.getByTestId("menu-projects").click();
      await expect(page.getByTestId("projects-home")).toBeVisible();
      await scan(page, "projects home", found);
      await page.getByTestId("project-more").first().click();
      await page.waitForTimeout(250);
      await scan(page, "project menu", found);
      await closeTop();

      // 13. error screen
      await page.goto("/?e2e&force-error=200");
      await expect(page.getByTestId("error-screen")).toBeVisible({ timeout: 30_000 });
      await scan(page, "error screen", found);

      await ctx.close();
      const text = found.map((f) => `[${f.impact}] ${f.surface}: ${f.id}\n    ${f.nodes.join("\n    ")}`).join("\n");
      expect.soft(found.length, `serious/critical axe violations (${theme}, ${view.name}):\n${text}`).toBe(0);
      if (process.env.A11Y_DUMP) console.log(`### ${theme} ${view.name}\n${text}`);
    });
  }
}
