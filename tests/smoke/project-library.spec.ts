import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** PM-08 project library: archive / restore with Archived filter and Undo, export and import a `.overcut` from the library (docs/features/project-library.md). Needs a build with the engine. */
const ready = async (page: Page) => {
  await page.addInitScript(() => { delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker; delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker; });
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect(page.getByTestId("preview-import")).toBeEnabled({ timeout: 20_000 });
};
const menu = async (page: Page, item: string) => {
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("menuitem", { name: item }).click();
};
const cards = (page: Page) => page.getByTestId("project-card");
const card = (page: Page, name: string) => cards(page).filter({ has: page.getByTestId("project-name").getByText(name, { exact: true }) });
const act = async (page: Page, name: string, item: "rename" | "duplicate" | "delete" | "export" | "archive" | "restore") => {
  await card(page, name).getByTestId("project-more").click();
  await page.getByTestId(`project-${item}`).click();
};
const overflowX = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("library: archive and restore (with Undo and the Archived filter), export to a file and import it back", async ({ page }, info) => {
  test.setTimeout(120_000);
  const phone = info.project.name === "phone";
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page);
  await page.getByTestId("canvas-open").click();
  await page.getByTestId("canvas-shape").selectOption("9:16");
  await page.getByTestId("canvas-apply").click();
  await expect(page.getByTestId("canvas-open")).toHaveAccessibleName(/^Canvas: 9:16/);
  await page.getByLabel("Project name").fill("Alpha");
  await page.getByLabel("Project name").blur();
  await menu(page, "Projects");
  await page.getByTestId("projects-new").click();
  await expect(page.getByTestId("canvas-open")).toBeVisible({ timeout: 20_000 });
  await page.getByLabel("Project name").fill("Beta");
  await page.getByLabel("Project name").blur();
  await menu(page, "Projects");
  await expect(cards(page)).toHaveCount(2);
  // No archived project yet: no filter bar to clutter the list.
  await expect(page.getByTestId("library-filter-archived")).toHaveCount(0);

  // The "…" menu: a 44 px target, opens with the keyboard, Escape closes and gives focus back.
  const more = card(page, "Alpha").getByTestId("project-more");
  if (phone) expect((await more.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("project-menu")).toBeVisible();
  await expect(page.getByTestId("project-rename")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("project-menu")).toHaveCount(0);
  await expect(more).toBeFocused();

  // Archive: leaves the main list, a note offers Undo; Undo brings it back.
  await act(page, "Alpha", "archive");
  await expect(cards(page)).toHaveCount(1);
  await expect(page.getByTestId("library-note")).toContainText("Archived “Alpha”");
  await page.getByTestId("library-undo").click();
  await expect(cards(page)).toHaveCount(2);

  // Archive again, look at the Archived filter, restore from there; the empty state says so.
  await act(page, "Alpha", "archive");
  await expect(cards(page)).toHaveCount(1);
  await page.getByTestId("library-filter-archived").click();
  await expect(cards(page)).toHaveCount(1);
  await expect(card(page, "Alpha")).toContainText("Archived");
  expect(await overflowX(page)).toBeLessThanOrEqual(0);
  await act(page, "Alpha", "restore");
  await expect(page.getByTestId("archived-empty")).toContainText("No archived projects");
  await page.getByRole("button", { name: "Back to projects" }).click();
  await expect(cards(page)).toHaveCount(2);

  // Archived survives a reload (it is in the list file, not the page).
  await act(page, "Alpha", "archive");
  await expect(cards(page)).toHaveCount(1);
  await page.reload();
  // One active project left: the editor opens it directly (archived ones do not count); the library is one tap away.
  await expect(page.getByLabel("Project name")).toHaveValue("Beta", { timeout: 30_000 });
  await menu(page, "Projects");
  await expect(cards(page)).toHaveCount(1);
  await expect(page.getByTestId("library-filter-archived")).toContainText("(1)");

  // Export Alpha from the library: a real .overcut (a zip) is downloaded.
  await page.getByTestId("library-filter-archived").click();
  const saved = page.waitForEvent("download");
  await act(page, "Alpha", "export");
  const file = await saved;
  expect(file.suggestedFilename()).toBe("Alpha.overcut");
  const saved2 = join(mkdtempSync(join(tmpdir(), "overcut-")), file.suggestedFilename()); // a real name on disk: the import names the project after its file
  await file.saveAs(saved2);
  const bytes = readFileSync(saved2);
  expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
  await expect(page.locator(".toast")).toContainText("Exported Alpha.overcut");

  // Import that file back: it becomes its own project (the editor opens it); the library then lists both.
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("projects-open-file").click();
  await (await chooser).setFiles(saved2);
  await expect(page.getByLabel("Project name")).toHaveValue("Alpha", { timeout: 20_000 });
  await menu(page, "Projects");
  await expect(page.getByTestId("library-filter-active")).toContainText("(2)");

  // Delete from the archive still asks first.
  await page.getByTestId("library-filter-archived").click();
  await act(page, "Alpha", "delete");
  await page.getByTestId("confirm-cancel").click();
  await expect(cards(page)).toHaveCount(1);
  await act(page, "Alpha", "delete");
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("archived-empty")).toBeVisible();

  expect(await overflowX(page)).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});
