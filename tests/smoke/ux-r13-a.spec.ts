import { expect, test, type Page } from "@playwright/test";

/** M2 UX round 13 (lane a): the project name field has a visible boundary at rest (#242); an unreadable project file is explained in plain words with the parser text behind "Show details" (#243). */
async function ready(page: Page) {
  await page.addInitScript(() => { delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker; });
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
}

test("the project name has a visible bottom edge at rest (WCAG 1.4.11); 44 px tall on a phone", async ({ page }, info) => {
  await ready(page);
  const field = page.getByLabel("Project name");
  const edge = await field.evaluate((el) => { const c = getComputedStyle(el); return { w: c.borderBottomWidth, color: c.borderBottomColor }; });
  expect(edge.w).toBe("1px");
  expect(edge.color).not.toMatch(/rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)|transparent/);
  if (info.project.name === "phone") expect((await field.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

test("a file that is not a project: plain sentence, details hidden until asked", async ({ page }) => {
  test.setTimeout(60_000);
  await ready(page);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("menuitem", { name: "Open project…" }).click();
  await (await chooser).setFiles({ name: "junk.overcut", mimeType: "application/octet-stream", buffer: Buffer.from("this is not a zip") });
  const note = page.getByTestId("failure-note");
  await expect(note).toBeVisible({ timeout: 10_000 });
  await expect(note.locator("> span")).toHaveText(/not an OverCut project, or it is damaged/);
  await expect(note.locator("> span")).not.toContainText(/zip|EOCD/i);
  const details = page.getByTestId("failure-details");
  await expect(details.locator("code")).toBeHidden();
  await details.getByText("Show details").click();
  await expect(details.locator("code")).toBeVisible();
  expect((await details.locator("summary").boundingBox())!.height).toBeGreaterThanOrEqual(44);
});
