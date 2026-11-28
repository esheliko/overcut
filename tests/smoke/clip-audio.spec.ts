import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gutterShift } from "./timeline-geometry";

/**
 * Clip volume and fades (AU-01, round 16): the Details Audio tab changes the sound of the selected clip (volume, fade out, Mute clip, one undo step per
 * field), the volume line on the timeline can be dragged, and the exported file is as loud as the settings say: half the level where the volume is 50%,
 * silent at the end of a fade out (the production export pipeline, then the file decoded again).
 */
const CLIP = resolve("crates/media/tests/fixtures/h264_aac.mp4"); // 160x120, 30 fps, 1 s, testsrc + sine
const TICKS = 705_600_000;
const UNDO = /^Undo( (?!recovery).+)?$/;

type Audio = { volume?: number; fade_in?: number; fade_out?: number } | undefined;
async function soundAudio(page: Page): Promise<Audio> {
  return page.evaluate(async () => {
    const { session } = (window as unknown as { __overcut: { session: { editing: { project(): Promise<unknown> } } } }).__overcut;
    type P = { sequences: { tracks: { kind: string; clips: { audio?: { volume?: number; fade_in?: number; fade_out?: number } }[] }[] }[] };
    const p = (await session.editing.project()) as P;
    return p.sequences[0]!.tracks.find((t) => t.kind === "audio")!.clips[0]!.audio;
  });
}

async function openClip(page: Page, phone: boolean): Promise<void> {
  await page.goto("/?e2e=bare");
  await page.waitForFunction(() => !!(window as unknown as { __overcut?: unknown }).__overcut, undefined, { timeout: 30_000 });
  await expect(page.getByTestId("engine")).toHaveAttribute("data-backend", "wasm", { timeout: 30_000 });
  if (phone) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Media" }).click();
  await page.getByTestId("media-input").setInputFiles(CLIP);
  await expect(page.locator("#tl-summary")).toContainText("1 clip");
  await expect(page.locator(".canvas")).toHaveAttribute("data-loaded", "true", { timeout: 20_000 });
}

test("audio tab: volume, fade out and Mute clip edit the sound of the selected picture; each field is one undo step", async ({ page }, info) => {
  const phone = info.project.name === "phone";
  await openClip(page, phone);
  const box = (await page.getByTestId("timeline-canvas").boundingBox())!;
  const dg = await gutterShift(page);
  if (phone) await page.touchscreen.tap(box.x + dg + 68, box.y + 56);
  else await page.mouse.click(box.x + dg + 68, box.y + 56);
  if (phone) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Edit" }).click();
  await page.getByRole("tab", { name: "Audio" }).click();
  await expect(page.getByTestId("audio-volume")).toHaveValue("100");
  expect(await soundAudio(page)).toBeUndefined(); // a plain clip writes nothing

  await page.getByTestId("audio-volume").fill("50");
  await page.getByTestId("audio-volume").blur();
  await expect(page.getByTestId("audio-slider-volume")).toHaveValue("50");
  await page.getByTestId("audio-fadeOut").fill("0.3");
  await page.getByTestId("audio-fadeOut").blur();
  expect(await soundAudio(page)).toEqual({ volume: 0.5, fade_out: 0.3 * TICKS });
  await page.getByTestId("audio-fadeOut").fill("9"); // more than half the clip: limited, and the note says so
  await expect(page.getByTestId("audio-fadeOut")).toHaveValue("0.5");
  await page.getByTestId("audio-fadeOut").blur();
  expect(((await soundAudio(page)) ?? {}).fade_out).toBe(0.5 * TICKS);

  // Mute clip: volume 0, the old level comes back on Unmute
  await page.getByTestId("audio-mute").click();
  await expect(page.getByTestId("audio-volume")).toHaveValue("0");
  await expect(page.getByTestId("audio-mute")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("audio-mute")).toContainText("Unmute clip");
  await page.getByTestId("audio-mute").click();
  await expect(page.getByTestId("audio-volume")).toHaveValue("50");

  // Double-click on a field puts it back
  await page.getByTestId("audio-volume").dblclick();
  await expect(page.getByTestId("audio-volume")).toHaveValue("100");
  if (phone) await page.getByRole("button", { name: "Close panel" }).click();
  await page.getByRole("button", { name: UNDO }).click(); // the reset of the volume
  if (phone) await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Edit" }).click();
  if (phone) await page.getByRole("tab", { name: "Audio" }).click();
  await expect(page.getByTestId("audio-volume")).toHaveValue("50");
});

test("timeline: the volume line of a selected sound is dragged to change the volume, one undo step", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "a mouse drag; the phone changes volume in Details");
  await openClip(page, false);
  const box = (await page.getByTestId("timeline-canvas").boundingBox())!;
  const dg = await gutterShift(page);
  const x = box.x + dg + 48 + 150;
  await page.mouse.click(x, box.y + 30 + 60 + 30); // the sound's lane: select (the picture and the sound are linked)
  await page.getByRole("tab", { name: "Audio" }).click();
  await page.getByTestId("audio-volume").fill("50");
  await page.getByTestId("audio-volume").blur();
  // the line of 50% sits a quarter of the way up the 38 px travel from the bottom: lane top + 50 - 9.5
  const laneTop = box.y + 30 + 60;
  const y = laneTop + 50 - 0.25 * 38;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 10, { steps: 4 });
  await page.mouse.move(x, y - 19, { steps: 4 });
  await page.mouse.up(); // 19 px = +100%: 150%
  await expect.poll(async () => ((await soundAudio(page)) ?? {}).volume).toBe(1.5);
  await page.getByRole("button", { name: UNDO }).click();
  await expect.poll(async () => ((await soundAudio(page)) ?? {}).volume).toBe(0.5); // the whole drag was one step
});

test("export: the file is half as loud at 50% and silent at the end of a fade out", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "export does not depend on the viewport");
  test.setTimeout(240_000);
  await openClip(page, false);
  const bytes = readFileSync(CLIP).toString("base64");
  const run = (audio: { volume: number; fade_out: number } | null) =>
    page.evaluate(async ({ bytes, audio }) => {
      type Engine = {
        editing: { project(): Promise<unknown> };
        export: { start(s: unknown): Promise<{ result: Promise<{ file(): Promise<File>; remove(): Promise<void> }> }> };
        media: { open(b: Blob, o: unknown): Promise<{ audio(start: number, count: number): Promise<Float32Array>; close(): Promise<void> }> };
      };
      const { engine } = (window as unknown as { __overcut: { engine: Engine } }).__overcut;
      const store = (window as unknown as { __overcutStore: { apply(o: unknown[]): Promise<unknown> } }).__overcutStore;
      type P = { media: { id: string }[]; sequences: { id: string; tracks: { kind: string; clips: { id: string }[] }[] }[] };
      const p = (await engine.editing.project()) as P;
      const a1 = p.sequences[0]!.tracks.find((t) => t.kind === "audio")!;
      if (audio) await store.apply([{ op: "set_clip_audio", clip: a1.clips[0]!.id, audio: { volume: audio.volume, fade_in: 0, fade_out: audio.fade_out } }]);
      const blob = new Blob([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))], { type: "video/mp4" });
      const job = await engine.export.start({ sequence: p.sequences[0]!.id, sources: { [p.media[0]!.id]: blob }, container: "webm", videoCodec: "vp9", videoBitrate: 2_000_000, hardware: "prefer-software", creationTime: 1_700_000_000_000 });
      const res = await job.result;
      const file = await res.file();
      const h = await engine.media.open(file, { gpu: false, audioRate: 48_000 });
      const pcm = await h.audio(0, 48_000); // interleaved stereo
      await h.close();
      await res.remove();
      const rms = (from: number, to: number): number => {
        let s = 0, n = 0;
        for (let i = Math.floor(from * 48_000) * 2; i < Math.floor(to * 48_000) * 2 && i < pcm.length; i++) { s += pcm[i]! * pcm[i]!; n++; }
        return Math.sqrt(s / Math.max(1, n));
      };
      return { start: rms(0.02, 0.4), end: rms(0.9, 0.98) };
    }, { bytes, audio });
  const plain = await run(null);
  expect(plain.start, "the test clip has sound").toBeGreaterThan(0.01);
  const quiet = await run({ volume: 0.5, fade_out: 0.4 * TICKS });
  console.log("clip audio export:", JSON.stringify({ plain, quiet }));
  expect(quiet.start / plain.start).toBeGreaterThan(0.4); // half the level (the codec adds a little)
  expect(quiet.start / plain.start).toBeLessThan(0.6);
  expect(quiet.end / plain.end).toBeLessThan(0.15); // the end of the fade: nearly silent
});
