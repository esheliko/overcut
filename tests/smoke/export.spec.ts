import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/** What `window.__exportHarness.run` returns (apps/web/src/ExportHarness.tsx). */
interface Outcome {
  ok: boolean;
  code?: string;
  message?: string;
  mime?: string;
  fileBytes?: number;
  sha256?: string;
  head?: number[];
  progressEvents: number;
  lastProgress?: { framesDone: number; totalFrames: number; fraction: number; phase: string };
  leftoverFiles: number;
  stats?: { frames: number; durationSeconds: number; speedVsRealtime: number; peakEncodeQueue: number; codecs: string };
  slices?: string[];
}
type Run = { seconds: number; speed?: [number, number]; realMedia?: { base64: string; name: string }; width?: number; height?: number; settings?: Record<string, unknown>; cancelAfterProgress?: number; fps?: [number, number] };

// Export is engine work in a Worker, not layout: one viewport is enough (the phone project would only repeat it).
test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "export does not depend on the viewport");
  await page.goto("/#export-harness");
  await page.waitForFunction(() => (window as unknown as { __exportHarness?: unknown }).__exportHarness !== undefined, null, { timeout: 30_000 });
});

const run = (page: Page, r: Run, keep = false): Promise<Outcome> =>
  page.evaluate(([r, keep]) => (window as unknown as { __exportHarness: { run(r: unknown, keep: boolean): Promise<Outcome> } }).__exportHarness.run(r, keep), [r, keep] as const);

// Pinned codecs: software VP9 + Opus in WebM exists in every Chromium and is deterministic; AAC and hardware H.264 depend on the machine.
const pinned = { container: "webm", videoCodec: "vp9", creationTime: 1_700_000_000_000 };

test("export: a synthetic project renders to a playable WebM, with progress, and cleans up its storage", async ({ page }) => {
  const r = await run(page, { seconds: 3, settings: pinned });
  expect(r.code).toBeUndefined();
  expect(r.ok).toBe(true);
  expect(r.mime).toMatch(/^video\/webm; codecs="vp09/);
  expect(r.head?.slice(0, 4)).toEqual([0x1a, 0x45, 0xdf, 0xa3]); // EBML header
  expect(r.fileBytes).toBeGreaterThan(10_000);
  expect(r.stats?.frames).toBe(90);
  expect(r.stats?.durationSeconds).toBe(3);
  expect(r.progressEvents).toBeGreaterThanOrEqual(2);
  expect(r.lastProgress).toMatchObject({ framesDone: 90, totalFrames: 90, fraction: 1, phase: "finalizing" });
  expect(r.stats?.peakEncodeQueue).toBeLessThanOrEqual(6); // back-pressure: a handful of frames in flight, whatever the length
  expect(r.leftoverFiles).toBe(0); // result.remove() freed the OPFS file
});

test("export is deterministic: the same project and settings give byte-identical files", async ({ page }) => {
  // Byte determinism is a promise of the readback route (docs/features/export.md); the default `canvas` route is checked by every other test here.
  const a = await run(page, { seconds: 3, settings: { ...pinned, capture: "readback" } });
  const b = await run(page, { seconds: 3, settings: { ...pinned, capture: "readback" } });
  expect(a.ok && b.ok).toBe(true);
  expect(b.fileBytes).toBe(a.fileBytes);
  expect(b.sha256).toBe(a.sha256);
});

test("export: the default preset picks a format this browser can encode and says if it has a catch", async ({ page }) => {
  const r = await run(page, { seconds: 1, settings: { creationTime: 1_700_000_000_000 } });
  expect(r.ok).toBe(true);
  expect(r.mime).toMatch(/^video\/(mp4|webm)/);
  expect(r.stats?.frames).toBe(30);
});

test("export: cancel stops the job, rejects with the typed code and leaves no file behind", async ({ page }) => {
  const r = await run(page, { seconds: 60, settings: pinned, cancelAfterProgress: 2 });
  expect(r.ok).toBe(false);
  expect(r.code).toBe("cancelled");
  expect(r.leftoverFiles).toBe(0);
});

test("export: asking for a format the browser cannot encode is a typed, readable error", async ({ page }) => {
  const r = await run(page, { seconds: 1, settings: { container: "webm", videoCodec: "h264" } });
  expect(r.ok).toBe(false);
  expect(r.code).toBe("unsupported");
  expect(r.message).toMatch(/cannot encode/);
});

test("export: the audio click and the video flash line up to well under a frame in the decoded file (S3 verifier)", async ({ page }, info) => {
  let ffmpeg = true;
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
  } catch {
    ffmpeg = false;
  }
  test.skip(!ffmpeg, "ffmpeg is not installed here");
  const seconds = 6;
  const r = await run(page, { seconds, settings: pinned }, true);
  expect(r.ok).toBe(true);
  const file = info.outputPath("sync.webm");
  writeFileSync(file, Buffer.concat((r.slices ?? []).map((s) => Buffer.from(s, "base64"))));
  const out = JSON.parse(execFileSync("node", ["spikes/s3-encode/verify.mjs", file, String(seconds)], { maxBuffer: 1 << 24 }).toString()) as {
    decodedVideoFrames: number;
    expectedVideoFrames: number;
    flashesFound: number;
    clicksMeasured: number;
    maxAbsOffsetFrames: number;
    driftMsPerMinute: number;
    videoStart: number;
    audioStart: number;
  };
  expect(out.decodedVideoFrames).toBe(out.expectedVideoFrames);
  expect(out.flashesFound).toBe(seconds);
  expect(out.clicksMeasured).toBe(seconds);
  expect(out.maxAbsOffsetFrames).toBeLessThan(0.1); // bar is < 1 frame; the pipeline is exact to a sample
  expect(Math.abs(out.driftMsPerMinute)).toBeLessThan(1);
  expect(out.videoStart).toBe(0);
  expect(out.audioStart).toBe(0);
});

test("export: a real file goes through the production decoder (video and audio) into the new file", async ({ page }, info) => {
  const base64 = readFileSync("crates/media/tests/fixtures/vp9_opus.webm").toString("base64"); // 160x120, 30 fps, 1 s, 440 Hz tone
  const r = await run(page, { seconds: 1, width: 320, height: 240, realMedia: { base64, name: "fixture.webm" }, settings: pinned }, true);
  expect(r.message).toBeUndefined();
  expect(r.ok).toBe(true);
  expect(r.stats?.frames).toBe(30);
  let ffmpeg = true;
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  } catch {
    ffmpeg = false;
  }
  if (!ffmpeg) return;
  const file = info.outputPath("real.webm");
  writeFileSync(file, Buffer.concat((r.slices ?? []).map((s) => Buffer.from(s, "base64"))));
  // the tone survived: audible, and the picture is not black
  const vol = spawnSync("ffmpeg", ["-hide_banner", "-i", file, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const mean = Number(/mean_volume: (-?[\d.]+) dB/.exec(vol)?.[1] ?? "-99");
  expect(mean).toBeGreaterThan(-40);
  const luma = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", "select=eq(n\\,15),scale=1:1,format=gray", "-frames:v", "1", "-f", "rawvideo", "-"]);
  expect(luma[0] ?? 0).toBeGreaterThan(20);
});

// M2-026: a sped-up or slowed clip exports at its new length, the click stays on its flash (flash and click are once per SOURCE second,
// so the pair repeats every 1 / speed timeline seconds), and the pitch of the sound is kept.
for (const [num, den] of [[2, 1], [1, 2]] as const) {
  test(`export: a ${num / den}x clip has the right length and its click stays on its flash`, async ({ page }, info) => {
    let ffmpeg = true;
    try {
      execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    } catch {
      ffmpeg = false;
    }
    test.skip(!ffmpeg, "ffmpeg is not installed here");
    const seconds = 6;
    const r = await run(page, { seconds, speed: [num, den], settings: pinned }, true);
    expect(r.ok).toBe(true);
    expect(r.stats?.frames).toBe(seconds * 30);
    const file = info.outputPath(`speed-${num}-${den}.webm`);
    writeFileSync(file, Buffer.concat((r.slices ?? []).map((s) => Buffer.from(s, "base64"))));
    const period = den / num;
    const out = JSON.parse(execFileSync("node", ["spikes/s3-encode/verify.mjs", file, String(seconds), String(period)], { maxBuffer: 1 << 24 }).toString()) as {
      decodedVideoFrames: number;
      expectedVideoFrames: number;
      flashesFound: number;
      expectedFlashes: number;
      clicksMeasured: number;
      maxAbsOffsetFrames: number;
    };
    const length = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString());
    expect(out.decodedVideoFrames).toBe(out.expectedVideoFrames);
    expect(length).toBeCloseTo(seconds, 1);
    expect(out.flashesFound).toBeGreaterThanOrEqual(out.expectedFlashes - 1);
    expect(out.clicksMeasured).toBeGreaterThanOrEqual(out.expectedFlashes - 1); // an edge click may fall inside the first/last window
    expect(out.maxAbsOffsetFrames).toBeLessThan(1); // the bar: under one frame
  });
}

// esheliko/overcut#138: the audio track must end where the video ends (the encoder's last, padded Opus packet used to run 20 ms past it).
for (const [container, videoCodec, ext] of [["webm", "vp9", "webm"], ["mp4", "h264", "mp4"]] as const) {
  for (const seconds of [2, 7]) {
    test(`export: audio and video end together (${container}, ${seconds} s)`, async ({ page }, info) => {
      let ffprobe = true;
      try {
        execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
      } catch {
        ffprobe = false;
      }
      test.skip(!ffprobe, "ffprobe is not installed here");
      const r = await run(page, { seconds, settings: { container, videoCodec, creationTime: 1_700_000_000_000 } }, true);
      test.skip(!r.ok && r.code === "unsupported", `this browser cannot encode ${videoCodec} here`);
      expect(r.ok).toBe(true);
      const file = info.outputPath(`av-${seconds}.${ext}`);
      writeFileSync(file, Buffer.concat((r.slices ?? []).map((s) => Buffer.from(s, "base64"))));
      const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,duration:format=duration", "-of", "json", file]).toString()) as { streams: { codec_type: string; duration?: string }[]; format: { duration: string } };
      const dur = (kind: string) => Number(probe.streams.find((s) => s.codec_type === kind)?.duration ?? probe.format.duration);
      console.log(`${container} ${seconds}s:`, JSON.stringify({ video: dur("video"), audio: dur("audio"), format: probe.format.duration }));
      expect(dur("video")).toBeCloseTo(seconds, 2);
      expect(dur("audio") - dur("video")).toBeLessThan(0.0025); // within a sample or two of the video, not a whole 20 ms Opus frame
      expect(dur("audio") - dur("video")).toBeGreaterThan(-0.021); // and never more than one audio frame short
    });
  }
}
test("export: a clip whose audio track is shorter than its picture exports (audio past the end is silence, not 'out of range')", async ({ page }) => {
  const base64 = readFileSync("crates/media/tests/fixtures/vp9_opus_short_audio.webm").toString("base64"); // 1.5 s picture, 1 s of tone
  const r = await run(page, { seconds: 2, width: 320, height: 240, realMedia: { base64, name: "short-audio.webm" }, settings: pinned });
  expect(r.message).toBeUndefined();
  expect(r.ok).toBe(true);
  expect(r.stats?.frames).toBe(60);
});
