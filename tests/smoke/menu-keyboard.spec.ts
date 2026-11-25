import { expect, test } from "@playwright/test";

/** The app menu is a menu for the keyboard too: focus goes to its first item, arrows move, Escape closes and puts focus back on the button. */
test("app menu: opens on the first item, arrows and Home/End move, Escape returns focus to the button", async ({ page }) => {
  await page.goto("/?sample");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  const button = page.getByRole("button", { name: "Menu" });
  await button.focus();
  await page.keyboard.press("Enter");
  const items = page.locator(".menu-pop").first().locator("button, a[href]");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(items.last()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.first()).toBeFocused(); // wraps
  await page.keyboard.press("Escape");
  await expect(page.locator(".menu-pop")).toHaveCount(0);
  await expect(button).toBeFocused();
});

test("track switches from the keyboard: Shift+M mutes the selected clip's audio track (video tracks have no mute)", async ({ page }) => {
  await page.goto("/?sample");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect(page.locator("#tl-summary")).toContainText("Untitled project: 2 tracks"); // the engine has opened the sample project: edits work
  await page.getByTestId("timeline-canvas").focus();
  await page.keyboard.press("Enter"); // select the clip at the playhead
  await page.keyboard.press("Shift+M"); // a video track has no mute: a short message, nothing changes
  await expect(page.locator('[data-announcer="polite"]')).toContainText(/audio tracks/i);
  await page.keyboard.press("ArrowDown"); // the audio clip below
  await page.keyboard.press("Shift+M");
  await expect(page.locator('[data-announcer="polite"]')).toContainText(/muted/i);
  await page.keyboard.press("Shift+M");
  await expect(page.locator('[data-announcer="polite"]')).toContainText(/unmuted/i);
});
