import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** PM-02 (docs/features/open-with.md) and XT-06 (docs/features/error-screen.md). Needs a production build (the service worker exists only there). */
const FLASH = resolve("crates/media/tests/fixtures/flash_click.mp4");

test("the manifest declares file handling and a share target", async ({ request }) => {
  const m = await (await request.get("/manifest.webmanifest")).json();
  expect(m.file_handlers[0].accept["video/*"]).toContain(".mp4");
  expect(m.file_handlers[0].accept["application/x-overcut"]).toEqual([".overcut"]);
  expect(m.share_target).toMatchObject({ action: "/share-target", method: "POST", enctype: "multipart/form-data" });
});

test("a file shared to the installed app (share target) lands in the media bin, with no network", async ({ page, context }, info) => {
  test.skip(info.project.name !== "desktop", "the share path does not depend on the viewport");
  test.setTimeout(120_000);
  await page.goto("/");
  await expect(page.getByTestId("preview-import")).toBeEnabled({ timeout: 30_000 });
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);
  const b64 = readFileSync(FLASH).toString("base64");
  // What the OS does for a share: POST multipart to the manifest's action. The worker parks the file and redirects to /?shared=<id>.
  const landed = await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const body = new FormData();
    body.append("files", new File([bytes], "shared clip.mp4", { type: "video/mp4" }));
    const res = await fetch("/share-target", { method: "POST", body });
    return res.url;
  }, b64);
  expect(landed).toMatch(/\/\?shared=[0-9a-f-]{36}$/);
  const foreign: string[] = [];
  context.on("request", (r) => { if (!r.url().startsWith("data:") && !r.url().startsWith("blob:") && new URL(r.url()).host !== new URL(landed).host) foreign.push(r.url()); });
  await page.goto(landed);
  await expect(page.locator("#tl-summary")).toContainText("2 clips", { timeout: 60_000 });
  await expect(page).toHaveURL(/\/$/); // the one-time address is tidied away
  expect(foreign).toEqual([]);
});

test("an app failure shows the calm error screen; the report copies and holds the stack; saved work is only claimed when it is", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);
  await page.goto("/?e2e&force-error=2500");
  await expect(page.getByTestId("preview-import")).toBeEnabled({ timeout: 30_000 });
  const screen = page.getByTestId("error-screen");
  await expect(screen).toBeVisible({ timeout: 20_000 });
  await expect(screen).not.toContainText(/Forced test error|at \w+ \(/); // no stack trace on screen
  await expect(page.getByTestId("crash-work")).toHaveAttribute("data-state", "saved");
  await expect(page.getByTestId("crash-work")).toContainText("Your work is saved");
  await expect(page.getByTestId("crash-reload")).toBeVisible();
  await page.getByTestId("crash-copy").click();
  await expect(page.getByTestId("crash-copied")).toContainText(/Copied|Select the text/);
  if (await page.getByTestId("crash-copied").textContent().then((t) => /Copied/.test(t ?? ""))) {
    const text = await page.evaluate(() => navigator.clipboard.readText());
    const r = JSON.parse(text);
    expect(r.overcut_crash_report).toBe(1);
    expect(r.error.message).toContain("Forced test error");
    expect(r.error.stack).toContain("Forced test error");
    expect(r.device.overcut_device_report).toBe(1);
    expect(r.saved).toBe("saved");
  }
  await page.getByTestId("crash-reload").click();
  await page.waitForURL(/force-error/); // reload keeps the address; the screen comes back (it is a forced error)
});

test("the error screen fits a phone without sideways scrolling and has 44px buttons", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "phone viewport only");
  await page.goto("/?e2e&force-error=200");
  await expect(page.getByTestId("error-screen")).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const id of ["crash-reload", "crash-copy"]) expect((await page.getByTestId(id).boundingBox())!.height).toBeGreaterThanOrEqual(44);
});
