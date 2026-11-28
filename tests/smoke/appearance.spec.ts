import { expect, test } from "@playwright/test";

/** UX-05 accent colours and PM-12 install affordance (menu). No network: the install how-to is local text. */
test("accent: pick a colour beside the theme, it applies at once, is remembered after a reload, and stays within the screen", async ({ page }) => {
  await page.goto("/");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-accent", "teal");
  // r15: the swatches sit with the theme (the theme popover; on small phones the theme rows of the menu), not in the menu's Preview section.
  const themeButton = page.getByTestId("theme-toggle");
  if (await themeButton.isVisible()) await themeButton.click();
  else { await page.getByRole("button", { name: "Menu" }).click(); await page.getByTestId("menu-theme").click(); } // UX r15 D8: on a phone the theme is one row; the swatches show once it is open
  const picker = page.getByTestId("accent-picker");
  await expect(picker).toBeVisible();
  const swatches = picker.getByRole("menuitemradio");
  await expect(swatches).toHaveCount(7);
  for (const s of await swatches.all()) expect((await s.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const before = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
  await page.getByTestId("accent-violet").click();
  await expect(html).toHaveAttribute("data-accent", "violet");
  await expect(page.getByTestId("accent-violet")).toHaveAttribute("aria-checked", "true");
  const after = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
  expect(after).not.toBe(before);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.reload();
  await expect(html).toHaveAttribute("data-accent", "violet");
  // another theme keeps the accent choice (they are independent)
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html).toHaveAttribute("data-accent", "violet");
});

test("install: nothing is offered unasked; a browser install prompt adds an Install app item", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Menu" }).click();
  await expect(page.getByTestId("menu-install")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    const e = new Event("beforeinstallprompt", { cancelable: true }) as Event & { prompt?: () => Promise<void>; userChoice?: Promise<{ outcome: string }> };
    e.prompt = async () => { (window as unknown as { __prompted?: boolean }).__prompted = true; };
    e.userChoice = Promise.resolve({ outcome: "accepted" });
    window.dispatchEvent(e);
  });
  await page.getByRole("button", { name: "Menu" }).click();
  const item = page.getByTestId("menu-install");
  await expect(item).toBeVisible();
  expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(test.info().project.name === "phone" ? 43.5 : 31.5); // menu rows: 44 px on touch, 32 px desktop density with a mouse (V-11)
  await item.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __prompted?: boolean }).__prompted)).toBe(true);
  await expect(item).toHaveCount(0); // used once; the menu closed
});

test("install on iOS Safari: a short how-to sheet (Share > Add to Home Screen), closable with Esc", async ({ browser }) => {
  const ctx = await browser.newContext({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1", viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto("/");
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByTestId("menu-install").click();
  const sheet = page.getByTestId("install-howto");
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("Share");
  await expect(sheet).toContainText("Add to Home Screen");
  const box = (await sheet.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await ctx.close();
});
