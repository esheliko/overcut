import { expect, test, type Page } from "@playwright/test";

/** PM-06 projects list: create two projects, switch between them, rename, duplicate, delete (docs/features/projects.md). Needs a build with the engine. */
const ready = async (page: Page) => {
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
/** A project action lives in the card's "…" menu: open it, pick the item. */
const act = async (page: Page, name: string, item: "rename" | "duplicate" | "delete" | "export" | "archive" | "restore") => {
  await card(page, name).getByTestId("project-more").click();
  await page.getByTestId(`project-${item}`).click();
};
const overflowX = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("projects list: two projects, switch, rename, duplicate, delete, and it is the first screen after a reload", async ({ page }, info) => {
  test.setTimeout(120_000);
  const phone = info.project.name === "phone";
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page); // a first start opens its one (new) project straight away

  // Project 1: give it a 9:16 canvas so the two projects are visibly different.
  await page.getByTestId("canvas-open").click();
  await page.getByTestId("canvas-shape").selectOption("9:16");
  await page.getByTestId("canvas-apply").click();
  await expect(page.getByTestId("canvas-open")).toHaveAccessibleName(/^Canvas: 9:16/);
  await page.getByLabel("Project name").fill("Alpha");
  await page.getByLabel("Project name").blur();

  // The list: one row with the real canvas, honest empty facts (no thumbnail).
  await menu(page, "Projects");
  await expect(page.getByTestId("projects-home")).toBeVisible();
  await expect(cards(page)).toHaveCount(1);
  await expect(card(page, "Alpha")).toContainText("1080 × 1920");
  await expect(card(page, "Alpha")).toContainText("0 clips");
  expect(await overflowX(page)).toBeLessThanOrEqual(0);

  // Project 2: new, default 16:9.
  await page.getByTestId("projects-new").click();
  await expect(page.getByTestId("canvas-open")).toHaveAccessibleName(/^Canvas: 16:9/, { timeout: 20_000 });
  await expect(page.getByLabel("Project name")).toHaveValue("Untitled project");

  // Switch back: project 1 is exactly as left (name and canvas), not project 2.
  await menu(page, "Projects");
  await expect(cards(page)).toHaveCount(2);
  await card(page, "Alpha").getByTestId("project-open").click();
  await expect(page.getByLabel("Project name")).toHaveValue("Alpha");
  await expect(page.getByTestId("canvas-open")).toHaveAccessibleName(/^Canvas: 9:16/, { timeout: 20_000 });

  // Rename project 2 from the list.
  await menu(page, "Projects");
  await act(page, "Untitled project", "rename");
  if (phone) expect((await page.getByTestId("rename-ok").boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.getByTestId("rename-input").fill("Beta");
  await page.getByTestId("rename-ok").click();
  await expect(card(page, "Beta")).toHaveCount(1);

  // Touch targets on the list.
  if (phone) {
    for (const id of ["project-open", "project-more", "projects-new"]) {
      const box = (await page.getByTestId(id).first().boundingBox())!;
      expect(box.height, id).toBeGreaterThanOrEqual(44);
    }
    expect(await overflowX(page)).toBeLessThanOrEqual(0);
  }

  // Duplicate Alpha: a third project with the same canvas; the original stays.
  await act(page, "Alpha", "duplicate");
  await expect(card(page, "Alpha copy")).toContainText("1080 × 1920");
  await expect(cards(page)).toHaveCount(3);

  // Delete asks first; cancelling keeps it, confirming removes it.
  await act(page, "Alpha copy", "delete");
  await page.getByTestId("confirm-cancel").click();
  await expect(cards(page)).toHaveCount(3);
  await act(page, "Alpha copy", "delete");
  await page.getByTestId("confirm-ok").click();
  await expect(cards(page)).toHaveCount(2);

  // After a reload with several projects the list is the first screen, and the renamed ones are still there.
  await page.reload();
  await expect(page.getByTestId("projects-home")).toBeVisible({ timeout: 30_000 });
  await expect(cards(page)).toHaveCount(2);
  await expect(card(page, "Alpha")).toHaveCount(1);
  await expect(card(page, "Beta")).toHaveCount(1);
  await card(page, "Beta").getByTestId("project-open").click();
  await expect(page.getByLabel("Project name")).toHaveValue("Beta");

  expect(errors).toEqual([]);
});
