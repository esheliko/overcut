import { expect, test } from "@playwright/test";

/** Two or more offline media offer ONE "Choose all" action; the recovery note keeps its close button on the first line at phone width. */
test("offline media: one Choose-all button; the recovery note does not wrap its close button", async ({ page }, info) => {
  await page.goto("/?sample");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  const phone = info.project.name === "phone";
  if (phone) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click();
  const all = page.getByTestId("relink-all");
  await expect(all).toBeVisible();
  await expect(all).toContainText("Choose all 2 files again");
  expect((await all.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: "/tmp/claude-0/-home-user-overcut/d1542f7e-6dcf-52b8-b7c1-efef7b6b1a0e/scratchpad/relink-" + info.project.name + ".png" });
  // The recovery note's layout, with the same markup the app renders.
  await page.evaluate(() => {
    const d = document.createElement("div");
    d.className = "persist-notes";
    d.innerHTML = '<div class="persist-note" role="status" data-testid="fake-note"><span>We recovered your last changes after the app closed unexpectedly.</span><button>Undo recovery</button><button class="icon-btn" aria-label="Dismiss">×</button></div>';
    document.body.append(d);
  });
  const close = page.locator('[data-testid="fake-note"] .icon-btn');
  const text = page.locator('[data-testid="fake-note"] > span');
  const [c, t] = [(await close.boundingBox())!, (await text.boundingBox())!];
  expect(c.y).toBeLessThan(t.y + t.height); // the close button sits on the text's first row, not under it
  expect(c.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: "/tmp/claude-0/-home-user-overcut/d1542f7e-6dcf-52b8-b7c1-efef7b6b1a0e/scratchpad/note-" + info.project.name + ".png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
