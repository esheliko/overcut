import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * M1-042 / XT-06: a whole session makes no network request beyond OverCut's own assets, even offline afterwards.
 * Records every request of the page, its Workers and the service worker (context-level) and fails on a host not in
 * config/network-allowlist.json. Needs a production build (CSP meta and the service worker exist only there).
 */
const allow = JSON.parse(readFileSync(resolve("config/network-allowlist.json"), "utf8")) as { sameOrigin: boolean; hosts: string[] };
const FIX = resolve("crates/media/tests/fixtures");

const hostOf = (url: string): string | null => {
  const u = new URL(url);
  return /^(https?|wss?):$/.test(u.protocol) ? u.host : null; // data:, blob:, about: never leave the device
};

/** A real keyboard edit: pick the clip at the playhead (Enter) and split it there (S). */
const edit = async (page: Page) => {
  await page.getByRole("slider", { name: "Playhead position" }).focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await page.keyboard.press("s");
};

test("a full session (load, import, edit, play, export, offline reload) talks only to its own origin", async ({ page, context, baseURL }, info) => {
  test.skip(info.project.name !== "desktop", "the network does not depend on the viewport");
  test.setTimeout(180_000);
  const own = new URL(baseURL!).host;
  const seen: { url: string; host: string }[] = [];
  const violations: string[] = [];
  context.on("request", (r) => {
    const host = hostOf(r.url());
    if (host === null) return;
    seen.push({ url: r.url(), host });
    if (!(allow.sameOrigin && host === own) && !allow.hosts.includes(host)) violations.push(`${r.method()} ${r.url()}`);
  });
  const csp: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (/content security policy/i.test(m.text())) csp.push(m.text()); });
  await page.addInitScript(() => {
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker; // native picker cannot be answered headless
    addEventListener("securitypolicyviolation", (e) => console.error(`Content Security Policy violation: ${e.violatedDirective} ${e.blockedURI}`));
  });

  // load; the policy is really in the page
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  expect(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content")).toContain("default-src 'self'");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 15_000 }).toBe(true);

  // import a fixture, edit, play
  await page.getByTestId("media-input").setInputFiles(resolve(FIX, "vp9_opus.webm"));
  await expect(page.locator("#tl-summary")).toContainText("2 clips", { timeout: 30_000 });
  await edit(page);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Pause", exact: true }).click();

  // export with the default preset
  await page.getByTestId("export-open").click();
  await page.getByTestId("export-go").click();
  await expect(page.getByTestId("export-done")).toBeVisible({ timeout: 90_000 });
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-save").click()]);
  expect(download.suggestedFilename()).toMatch(/\.(mp4|webm)$/);
  await page.getByTestId("export-done-close").click();

  // the visible network log (Privacy menu): it lists the app's own files, says nothing left, and names no foreign host
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByTestId("menu-privacy").click();
  const log = page.getByTestId("network-log");
  await expect(log).toBeVisible();
  await expect(page.getByTestId("network-summary")).toContainText("OverCut made no requests outside its own files");
  const shown = await log.locator("tbody tr").count();
  expect(shown).toBeGreaterThan(3);
  for (const url of await log.locator(".net-url").allTextContents()) expect(new URL(url).host, `listed request ${url}`).toBe(own);
  await page.keyboard.press("Escape");

  // diagnostics page, if the app has one yet
  const diag = await page.goto("/diagnostics");
  if (diag?.ok()) await page.waitForLoadState("load");

  // the service worker holds every file the page loaded (the app's own warm-up, main.tsx), so going offline cannot lose any
  await expect
    .poll(() => page.evaluate(async () => {
      const urls = performance.getEntriesByType("resource").map((e) => e.name).filter((u) => new URL(u).origin === location.origin);
      const hits = await Promise.all(urls.map((u) => caches.match(u, { ignoreVary: true })));
      return urls.filter((_, i) => !hits[i]);
    }), { timeout: 15_000 })
    .toEqual([]);

  // offline: the installed app still opens and edits
  const online = seen.length;
  await context.setOffline(true);
  await page.goto("/");
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await page.getByTestId("media-input").setInputFiles(resolve(FIX, "h264_aac.mp4"));
  await expect(page.locator("#tl-summary")).toContainText(/\d+ clips/, { timeout: 30_000 });
  await edit(page);
  await context.setOffline(false);

  expect(violations, `requests outside config/network-allowlist.json:\n${violations.join("\n")}`).toEqual([]);
  expect(csp, "Content-Security-Policy violations").toEqual([]);
  expect(errors).toEqual([]);
  expect(seen.length).toBeGreaterThan(5);
  console.log(`network: ${seen.length} requests (${online} online), hosts: ${[...new Set(seen.map((s) => s.host))].join(", ")}`);
});
