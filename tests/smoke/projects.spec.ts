import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Projects slice (PM-01, PM-06, PM-07, TL-06): new project sheet, canvas change, Projects home, project files, versions, history. Phone and desktop. */
const clip = resolve("crates/media/tests/fixtures/h264_aac.mp4");

const summary = (page: Page) => page.locator("#tl-summary");

async function ready(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("engine")).toContainText(/\(wasm\)/, { timeout: 30_000 });
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  // the project is open once the menu offers its actions (the saving session starts after the engine)
  await page.getByRole("button", { name: "Menu" }).click();
  await expect(page.getByTestId("menu-history")).toBeEnabled();
  await page.keyboard.press("Escape");
}
const menu = async (page: Page, item: string) => {
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByTestId(item).click();
};
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
/** 44 px on a touch device, 36 px with a fine pointer (the `--target` token). */
const target44 = async (page: Page, testid: string) => expect((await page.getByTestId(testid).first().boundingBox())!.height).toBeGreaterThanOrEqual(page.viewportSize()!.width < 720 ? 43.5 : 35.5);

test("new project: canvas chips and frame rate, the canvas is real, and it can be changed later (one undo step)", async ({ page }) => {
  await ready(page);
  await menu(page, "menu-new");
  const sheet = page.getByTestId("new-project");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("radio", { name: /Match first clip/ }).first()).toBeChecked(); // the default
  await noOverflow(page);
  await sheet.getByTestId("new-name").fill("Vertical trip");
  await sheet.getByTestId("new-canvas").getByRole("radio", { name: /9:16 Vertical/ }).check();
  await sheet.getByTestId("new-fps").getByRole("radio", { name: "24" }).check();
  await sheet.getByTestId("new-create").click();
  await expect(page.getByTestId("project-name-input")).toHaveValue("Vertical trip");
  await expect(page.getByTestId("ratio-select")).toHaveValue("9:16");
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  // the first import keeps the chosen canvas instead of adopting the clip's
  await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click().catch(() => undefined);
  await page.getByTestId("media-input").setInputFiles(clip);
  await expect(summary(page)).toContainText("2 clips");
  await expect(page.getByTestId("ratio-select")).toHaveValue("9:16");
  if ((page.viewportSize()?.width ?? 0) < 720) await page.getByRole("button", { name: "Close panel" }).click(); // the Media sheet covers the toolbar on a phone
  // change the canvas from the preview: a real project edit, undoable
  await page.getByTestId("ratio-select").selectOption("1:1");
  await expect(page.getByTestId("ratio-select")).toHaveValue("1:1");
  await page.getByRole("button", { name: "Undo" }).first().click();
  await expect(page.getByTestId("ratio-select")).toHaveValue("9:16");
  // the choice survives a reload (the same project opens again)
  await page.reload();
  await expect(page.getByTestId("engine")).toContainText(/\(wasm\)/, { timeout: 30_000 });
  await expect(page.getByTestId("project-name-input")).toHaveValue("Vertical trip");
  await expect(page.getByTestId("ratio-select")).toHaveValue("9:16");
});

test("history panel: named steps, click one to go back or forward, keyboard reachable", async ({ page }) => {
  await ready(page);
  await page.getByTestId("media-input").setInputFiles(clip).catch(async () => {
    await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click();
    await page.getByTestId("media-input").setInputFiles(clip);
  });
  await expect(summary(page)).toContainText("2 clips");
  await page.getByTestId("ratio-select").selectOption("9:16");
  await menu(page, "menu-history");
  const list = page.getByTestId("history-list");
  await expect(list.getByRole("button")).toHaveText([/Start of this session/, /Import h264_aac\.mp4/, /Change canvas to 1080×1920/]);
  await expect(list.getByRole("button", { name: /Change canvas/ })).toHaveAttribute("aria-current", "step");
  await noOverflow(page);
  expect((await list.getByRole("button").first().boundingBox())!.height).toBeGreaterThanOrEqual(page.viewportSize()!.width < 720 ? 43.5 : 35.5);
  await list.getByRole("button", { name: /Start of this session/ }).click(); // back to before the import
  await expect(list.getByRole("button", { name: /Start of this session/ })).toHaveAttribute("aria-current", "step");
  await page.keyboard.press("Escape");
  await expect(summary(page)).toContainText("0 clips");
  await menu(page, "menu-history");
  await page.getByTestId("history-list").getByRole("button", { name: /Change canvas/ }).focus();
  await page.keyboard.press("Enter"); // forward again, by keyboard
  await page.keyboard.press("Escape");
  await expect(summary(page)).toContainText("2 clips");
  await expect(page.getByTestId("ratio-select")).toHaveValue("9:16");
});

test("versions: save a named one, restore it as one undoable step, nothing is lost", async ({ page }) => {
  await ready(page);
  await page.getByTestId("ratio-select").selectOption("1:1");
  await menu(page, "menu-versions");
  const sheet = page.getByTestId("versions");
  await expect(sheet.getByTestId("versions-empty")).toBeVisible();
  await sheet.getByTestId("version-name").fill("Square");
  await sheet.getByTestId("version-save").click();
  await expect(sheet.getByTestId("version-list")).toContainText("Square");
  await noOverflow(page);
  await page.keyboard.press("Escape");
  await page.getByTestId("ratio-select").selectOption("9:16");
  await menu(page, "menu-versions");
  await page.getByTestId("versions").getByTestId("version-restore").first().click();
  await expect(page.getByTestId("versions")).toHaveCount(0); // closes when restored
  await expect(page.getByTestId("ratio-select")).toHaveValue("1:1");
  await page.getByRole("button", { name: "Undo" }).first().click(); // restore = one undo step
  await expect(page.getByTestId("ratio-select")).toHaveValue("9:16");
  await menu(page, "menu-versions");
  await expect(page.getByTestId("version-list")).toContainText("Before restore"); // a copy of what was replaced
});

test("projects home: list, rename, duplicate, export and open a project file, delete with confirm", async ({ page }) => {
  await ready(page);
  await menu(page, "menu-projects");
  const home = page.getByTestId("projects-home");
  await expect(home).toBeVisible();
  await noOverflow(page);
  await expect(page.getByTestId("project-card")).toHaveCount(1);
  await target44(page, "project-open-btn");
  // rename
  await page.getByTestId("project-rename-btn").click();
  await page.getByTestId("project-rename").fill("My film");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("project-name").first()).toHaveText("My film");
  // duplicate
  await page.getByTestId("project-duplicate").click();
  await expect(page.getByTestId("project-card")).toHaveCount(2);
  await expect(page.getByTestId("project-list")).toContainText("My film copy");
  // export a project file and open it as a new project
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("project-export").first().click()]);
  expect(download.suggestedFilename()).toMatch(/\.overcut$/);
  const path = await download.path();
  expect(readFileSync(path!).subarray(0, 2).toString()).toBe("PK"); // a zip
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("home-open-file").click()]);
  await chooser.setFiles(path!);
  await expect(page.getByTestId("project-card")).toHaveCount(3);
  // a file that is not a project is refused with a message, nothing is added
  const [bad] = await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("home-open-file").click()]);
  await bad.setFiles({ name: "x.overcut", mimeType: "application/zip", buffer: Buffer.from("not a zip") });
  await expect(page.getByTestId("home-problem")).toBeVisible();
  await expect(page.getByTestId("project-card")).toHaveCount(3);
  // delete asks first
  await page.getByTestId("project-delete").first().click();
  await expect(page.getByTestId("delete-confirm")).toBeVisible();
  await page.getByTestId("delete-cancel").click();
  await expect(page.getByTestId("project-card")).toHaveCount(3);
  await page.getByTestId("project-delete").first().click();
  await page.getByTestId("delete-confirm-go").click();
  await expect(page.getByTestId("project-card")).toHaveCount(2);
  // open one: back in the editor; deleting the open project would go home
  await page.getByTestId("project-open").first().click();
  await expect(page.getByTestId("ratio-select")).toBeVisible();
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
});

test("the home with no projects offers New project and Open project file", async ({ page }) => {
  await ready(page);
  await menu(page, "menu-projects");
  await page.getByTestId("project-delete").first().click();
  await page.getByTestId("delete-confirm-go").click();
  await expect(page.getByTestId("home-empty")).toBeVisible();
  await noOverflow(page);
  await target44(page, "home-new");
  await page.getByTestId("home-new").click();
  await expect(page.getByTestId("new-project")).toBeVisible();
  await page.getByTestId("new-create").click();
  await expect(page.getByTestId("ratio-select")).toBeVisible();
});
