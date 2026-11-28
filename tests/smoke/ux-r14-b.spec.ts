import { expect, test } from "@playwright/test";
import { gutterShift } from "./timeline-geometry";

/** UX r14 lane B: the icon toolbar (desktop) and the bottom tool strip (phone) put the actions for the selection one click away. */
test("clip actions: an icon toolbar on desktop, a tool strip on the phone, both switch with the selection", async ({ page }, info) => {
  const phone = info.project.name === "phone";
  await page.goto("/?sample");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect(page.getByTestId("panel-timeline")).toBeVisible();
  const canvas = page.getByTestId("timeline-canvas");
  await expect(page.locator("#tl-summary")).toContainText("14 clips");
  const strip = page.getByTestId("tool-strip");

  if (phone) {
    await expect(strip).toHaveAttribute("data-mode", "global");
    for (const id of ["media", "split", "canvas", "edit"]) await expect(page.getByTestId(`strip-${id}`)).toBeVisible();
  } else {
    // Unavailable actions stay in place, really disabled, and the tooltip says why.
    const del = page.getByRole("button", { name: "Delete", exact: true });
    await expect(del).toBeDisabled();
    await del.locator("xpath=..").hover();
    await expect(del.locator("xpath=..").locator(".tb-tip")).toContainText("Select a clip first");
    for (const id of ["tl-speed", "tl-crop", "tl-ripple-delete", "tl-duplicate-btn"]) await expect(page.getByTestId(id)).toBeDisabled();
  }

  const box = (await canvas.boundingBox())!; // measured now: the toolbar above may have settled
  const dg = await gutterShift(page);
  if (phone) await page.touchscreen.tap(box.x + dg + 108, box.y + 56); else await page.mouse.click(box.x + dg + 108, box.y + 56); // the first clip of the sample
  if (phone) {
    await expect(strip).toHaveAttribute("data-mode", "clip");
    for (const id of ["back", "edit", "split", "speed", "crop", "duplicate", "delete", "keyframe"]) {
      const b = page.getByTestId(`strip-${id}`);
      await expect(b).toBeVisible();
      expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await page.getByTestId("strip-speed").click(); // the sheet opens on the Speed tab
    await expect(page.getByRole("tab", { name: "Speed" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: "Close panel" }).click();
    await page.getByTestId("strip-back").click();
    await expect(strip).toHaveAttribute("data-mode", "global");
  } else {
    for (const id of ["tl-speed", "tl-crop", "tl-ripple-delete", "tl-duplicate-btn"]) await expect(page.getByTestId(id)).toBeEnabled();
    await page.getByTestId("tl-speed").click();
    await expect(page.getByTestId("tl-speed-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    // Snapping is a toggle next to the zoom and keeps its state.
    const snap = page.getByTestId("tl-snap");
    await expect(snap).toHaveAttribute("aria-pressed", "true");
    await snap.click();
    await expect(snap).toHaveAttribute("aria-pressed", "false");
    await snap.click();
  }
});
