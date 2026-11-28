import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

/** UX r16 lane B: the export gap warning and the offline-file preflight, Details tabs by clip kind, one selection wording, Save and rename. */
const FIX = resolve("crates/media/tests/fixtures");
const file = (n: string) => resolve(FIX, n);
const E2E_MEDIA = "00000000000000000000000000000e2e"; // the offline item `?e2e` seeds
const TICKS = 705_600_000;

async function ready(page: Page, url = "/") {
  await page.addInitScript(() => { delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker; });
  await page.goto(url);
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect(page.getByTestId("preview-import")).toBeEnabled({ timeout: 20_000 });
}
const isPhone = (info: { project: { name: string } }) => info.project.name === "phone";
const openMedia = async (page: Page, phone: boolean) => { if (phone) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click(); };

/** Adds a clip of `media` on the first track of `kind` through the test hook (`?e2e`), `start` and `length` in seconds. */
async function addClip(page: Page, kind: "video" | "audio", media: string | null, id: number, start: number, length: number) {
  await page.waitForFunction(() => !!(window as unknown as { __overcutStore?: { getState(): { project: unknown } } }).__overcutStore?.getState().project);
  await page.evaluate(async ({ kind, media, id, start, length, TICKS }) => {
    const store = (window as unknown as { __overcutStore: { apply(o: unknown): Promise<unknown>; getState(): { project: { media: { id: string }[]; sequences: { tracks: { id: string; kind: string }[] }[] } } } }).__overcutStore;
    const p = store.getState().project;
    const track = p.sequences[0]!.tracks.find((t) => t.kind === kind)!.id;
    const m = media ?? p.media[p.media.length - 1]!.id;
    await store.apply({ op: "insert_clip", track, clip: { id: id.toString(16).padStart(32, "0"), media: m, start: start * TICKS, source_in: 0, duration: length * TICKS } });
  }, { kind, media, id, start, length, TICKS });
}

test("Export warns about black gaps and 'Show first gap' puts the playhead there", async ({ page }, info) => {
  test.setTimeout(120_000);
  const phone = isPhone(info);
  await ready(page, "/?e2e=bare");
  await openMedia(page, phone);
  await page.getByTestId("media-input").setInputFiles(file("flash_click.mp4")); // 3 s
  await expect(page.locator("#tl-summary")).toContainText("1 clip", { timeout: 30_000 });
  await page.waitForFunction(() => !!(window as unknown as { __overcutStore?: unknown }).__overcutStore);
  await addClip(page, "video", null, 0x501, 5, 1); // a second picture from 5 s: a 2 s hole between
  await expect(page.locator("#tl-summary")).toContainText("2 clips");
  await page.getByTestId("export-open").click();
  const warn = page.getByTestId("export-warning");
  await expect(warn).toContainText("Your video has 1 gap (2 s) that will be black");
  await expect(page.getByTestId("export-go")).toHaveText("Export anyway");
  await expect(page.getByTestId("export-go")).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.getByTestId("export-show-gap").click();
  await expect(page.getByTestId("export-dialog")).toHaveCount(0);
  await expect(page.getByTestId("timecode")).toContainText("00:00:03:00");
});

test("a clip whose file cannot be read blocks Export with a visible reason and a one-click reconnect", async ({ page }, info) => {
  const phone = isPhone(info);
  await ready(page, "/?e2e");
  await page.waitForFunction(() => !!(window as unknown as { __overcutStore?: unknown }).__overcutStore);
  await addClip(page, "video", E2E_MEDIA, 0x601, 0, 2);
  await expect(page.locator("#tl-summary")).toContainText("1 clip");
  await page.getByTestId("export-open").click();
  const dialog = page.getByTestId("export-dialog");
  await expect(page.getByTestId("export-offline")).toContainText("1 clip needs its file again");
  await expect(page.getByTestId("export-reconnect")).toBeVisible();
  await expect(page.getByTestId("export-go")).toBeDisabled();
  await expect(page.getByTestId("export-why")).toContainText("Export is off until");
  const box = (await dialog.boundingBox())!;
  if (!phone) expect(box.y).toBeGreaterThan(0);
});

test("Details tabs follow the clip: a sound gets Audio (no Video), a photo gets Photo | Duration (no Speed)", async ({ page }, info) => {
  test.setTimeout(120_000);
  const phone = isPhone(info);
  await ready(page, "/?e2e=bare");
  await openMedia(page, phone);
  await page.getByTestId("media-input").setInputFiles([file("tone.mp3"), file("still_red.png")]);
  await expect(page.locator("#tl-summary")).toContainText("2 clips", { timeout: 30_000 });
  const select = (what: "sound" | "photo") => page.evaluate((what) => {
    const store = (window as unknown as { __overcutStore: { getState(): { project: { media: { id: string; kind: string }[]; sequences: { tracks: { kind: string; clips: { id: string; media: string }[] }[] }[] } }; setSelection(s: Set<string>): void } }).__overcutStore;
    const p = store.getState().project;
    const kind = what === "sound" ? "audio" : "image";
    const media = new Set(p.media.filter((m) => m.kind === kind).map((m) => m.id));
    const clip = p.sequences[0]!.tracks.flatMap((t) => t.clips).find((c) => media.has(c.media))!;
    store.setSelection(new Set([clip.id]));
  }, what);
  await page.waitForFunction(() => !!(window as unknown as { __overcutStore?: unknown }).__overcutStore);
  await select("sound");
  if (phone) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Edit" }).click();
  const tabs = page.getByRole("tablist", { name: "Clip properties" });
  const names = async () => (await tabs.getByRole("tab").allInnerTexts()).map((x) => x.trim());
  await expect.poll(names).toEqual(["Audio", "Speed"]); // a sound: Audio first, no Video tab
  await expect(page.getByTestId("insp-audio")).toBeVisible();
  await tabs.getByRole("tab", { name: "Speed" }).click();
  await select("photo");
  await expect.poll(names).toEqual(["Photo", "Duration"]); // a photo: no Speed tab; it opens on its own first tab
  await expect(tabs.getByRole("tab", { name: "Photo" })).toHaveAttribute("aria-selected", "true");
  await tabs.getByRole("tab", { name: "Duration" }).click();
  await page.getByTestId("duration-field").fill("2");
  await page.getByTestId("duration-field").press("Enter");
  await expect(page.getByTestId("duration-field")).toHaveValue("2");
  await expect(page.getByTestId("timecode")).toContainText("/ 00:00:02:00"); // the photo (was 5 s) now lasts 2 s; it starts V1 at 0 (r16 lane A: a sound under it no longer pushes it later)
  await select("sound");
  await expect(tabs.getByRole("tab", { name: "Audio" })).toHaveAttribute("aria-selected", "true"); // not the Speed tab left by the last sound
});

test("the project name is saved on Enter and while typing; Ctrl+S and the Save row say 'Saved just now' (and the chip on a desktop)", async ({ page }, info) => {
  await ready(page, "/?e2e=bare");
  const name = page.locator(".project-name");
  await name.fill("My road trip");
  await name.press("Enter");
  await page.waitForTimeout(300);
  await page.reload();
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  await expect(page.locator(".project-name")).toHaveValue("My road trip", { timeout: 15_000 });
  // typing without leaving the field: the pause commits it
  await page.locator(".project-name").fill("Beach day");
  await page.waitForTimeout(900);
  await page.reload();
  await expect(page.locator(".project-name")).toHaveValue("Beach day", { timeout: 15_000 });

  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 15_000 });
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("save-state")).toContainText("Saved just now");
  await expect(page.getByTestId("save-state")).toContainText("Saved on this device", { timeout: 6_000 }); // it settles back
  await expect(page.getByTestId("save-state")).toContainText("Saved on this device", { timeout: 6_000 });
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByTestId("menu-save-now").click(); // the "Save" row
  await expect(page.getByTestId("save-state")).toContainText("Saved just now");
  if (info.project.name !== "phone") { // the chip is in the top bar on a desktop: a click saves too
    await expect(page.getByTestId("save-state")).toContainText("Saved on this device", { timeout: 6_000 });
    await page.getByTestId("save-state").click();
    await expect(page.getByTestId("save-state")).toContainText("Saved just now");
  }
});
