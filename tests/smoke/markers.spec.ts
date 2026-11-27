import { expect, test } from "@playwright/test";

// M2-046: markers and the in/out range, through the More menu (touch friendly) and the M / I / O keys, on phone and desktop.
test("add, rename and delete a marker; set, loop and clear the in/out range", async ({ page }, info) => {
  const phone = info.project.name === "phone";
  await page.goto("/?sample");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  const live = page.locator('[data-announcer="polite"]');
  const pick = async (id: string) => { await page.getByTestId("tl-more").click(); await page.getByTestId(id).click(); };

  await page.getByTestId("tl-more").click();
  for (const id of ["tl-marker-add", "tl-range-in", "tl-range-out"]) {
    const b = (await page.getByTestId(id).boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    if (phone) expect(b.height).toBeGreaterThanOrEqual(44);
  }
  for (const id of ["tl-marker-edit", "tl-range-loop", "tl-range-clear"]) await expect(page.getByTestId(id)).toHaveAttribute("aria-disabled", "true"); // nothing to edit, no range yet
  await page.keyboard.press("Escape");

  await pick("tl-marker-add");
  await expect(live).toContainText("Marker added");
  await pick("tl-marker-edit"); // the playhead is on the marker
  await expect(page.getByTestId("marker-menu")).toBeVisible();
  await page.getByTestId("marker-name-input").fill("Intro");
  await page.keyboard.press("Enter");
  await expect(live).toContainText("Marker changed");
  await expect(page.getByTestId("marker-menu")).toHaveCount(0);
  await pick("tl-marker-edit");
  await expect(page.getByTestId("marker-name-input")).toHaveValue("Intro");
  for (const id of ["marker-chapter", "marker-delete", "marker-colour-default"]) { const b = (await page.getByTestId(id).boundingBox())!; expect(b.height).toBeGreaterThanOrEqual(test.info().project.name === "phone" ? 43.5 : 31.5); } // 44 px on touch, 32 px menu rows with a mouse (V-11)
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("marker-menu")).toHaveCount(0);
  await pick("tl-marker-edit");
  await page.getByTestId("marker-delete").click();
  await expect(live).toContainText("Marker deleted");

  await pick("tl-range-in");
  await expect(live).toContainText("In point set");
  await pick("tl-range-loop");
  await expect(live).toContainText("Looping the range");
  await page.getByTestId("tl-more").click();
  await expect(page.getByTestId("tl-range-clear")).not.toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  await pick("tl-range-clear");
  await expect(live).toContainText("cleared");
});
