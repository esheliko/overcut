import type { Page } from "@playwright/test";

/** How much wider the canvas's track-header column is than the 48 px the sample-layout coordinates in these specs were written for. */
export async function gutterShift(page: Page): Promise<number> {
  const g = await page.getByTestId("timeline-canvas").getAttribute("data-gutter");
  return Number(g ?? 48) - 48;
}
