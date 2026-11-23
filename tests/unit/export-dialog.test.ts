import assert from "node:assert/strict";
import test from "node:test";
import { probeExportFormats } from "../../packages/engine-client/src/export/options";
import { planExport } from "../../packages/engine-client/src/export/plan";
import { ExportError } from "../../packages/engine-client/src/export/types";
import type { CodecProbe } from "../../packages/engine-client/src/export/presets";
import type { Project } from "../../packages/engine-client/src/model.generated";
import { canShareFile, saveFile, shareFile } from "../../apps/web/src/export/deliver";
import {
  buildSettings, errorKey, estimateBytes, etaSeconds, formatBytes, formatClock, fpsSteps, loadRemembered, pickFormat, presetChoice, presetHint, saveName, resolutionSteps, saveRemembered, scaledSize, usableCustom, videoBitrate,
  type Choice, type Source,
} from "../../apps/web/src/export/model";

const HD: Source = { width: 1920, height: 1080, fps: 30, seconds: 60 };
const SMALL: Source = { width: 1280, height: 720, fps: 29.97, seconds: 10 };
const PHONE: Source = { width: 1080, height: 1920, fps: 60, seconds: 20 };

const probeOf = (video: string[], audio: string[]): CodecProbe => ({
  video: async (c) => video.some((p) => c.codec.startsWith(p)),
  audio: async (c) => audio.includes(c.codec),
});
const OPT = (id: "mp4-h264" | "webm-vp9" | "webm-av1", warnings: string[] = []) => ({ id, container: id.startsWith("mp4") ? "mp4" : "webm", videoCodec: id.split("-")[1], audioCodec: id === "mp4-h264" ? "aac" : "opus", warnings }) as never;

test("presets only shrink, keep the shape, and use whole-number even sizes", () => {
  assert.deepEqual(scaledSize(HD, 720), { width: 1280, height: 720 });
  assert.deepEqual(scaledSize(SMALL, 1080), { width: 1280, height: 720 }); // never upscale
  assert.deepEqual(scaledSize({ width: 1000, height: 563 }, 480), { width: 852, height: 480 });
  const y = presetChoice("youtube", SMALL);
  assert.deepEqual([y.width, y.height, y.fps, y.quality], [1280, 720, null, "high"]);
  const o = presetChoice("original", HD);
  assert.deepEqual([o.width, o.height, o.fps, o.format], [1920, 1080, null, "auto"]);
});

test("presets: Small file is 720p, 30 fps at most and a lower bitrate; 9:16 is tall and at most 1080 wide", () => {
  const s = presetChoice("small", { ...HD, fps: 60 });
  assert.deepEqual([s.width, s.height, s.fps, s.quality], [1280, 720, 30, "medium"]);
  assert.ok(videoBitrate(s, HD, "h264") < videoBitrate({ ...s, quality: "high" }, HD, "h264"));
  const v = presetChoice("vertical", HD);
  assert.deepEqual([v.width, v.height], [1080, 1920]);
  assert.deepEqual([presetChoice("vertical", PHONE).width, presetChoice("vertical", PHONE).height], [1080, 1920]);
  const tiny = presetChoice("vertical", { width: 640, height: 360, fps: 30, seconds: 5 });
  assert.deepEqual([tiny.width, tiny.height], [640, 1138]);
  assert.equal(presetChoice("youtube", { ...HD, fps: 120 }).fps, 60);
});

test("advanced options list only sizes and rates at or below the project's", () => {
  assert.deepEqual(resolutionSteps(HD).map((r) => r.short), [null, 720, 480]);
  assert.deepEqual(resolutionSteps(SMALL).map((r) => r.short), [null, 480]);
  assert.deepEqual(fpsSteps(30), [null, 25, 24]);
  assert.deepEqual(fpsSteps(29.97), [null, 25, 24]);
  assert.deepEqual(fpsSteps(60), [null, 50, 30, 25, 24]);
});

test("size estimate is bitrate x length, scales with quality and length", () => {
  const c = presetChoice("original", HD);
  const f = OPT("mp4-h264");
  const high = estimateBytes(c, HD, f);
  assert.equal(high, Math.round(((videoBitrate(c, HD, "h264") + 192_000) * 60) / 8));
  assert.ok(estimateBytes({ ...c, quality: "low" }, HD, f) < high * 0.5);
  assert.ok(estimateBytes(c, { ...HD, seconds: 120 }, f) > high * 1.9);
});

test("settings handed to the engine carry size, rate, codecs and bitrates", () => {
  const c: Choice = { ...presetChoice("small", { ...HD, fps: 60 }) };
  const s = buildSettings(c, { ...HD, fps: 60 }, OPT("webm-vp9"));
  assert.deepEqual([s.container, s.videoCodec, s.audioCodec, s.width, s.height], ["webm", "vp9", "opus", 1280, 720]);
  assert.deepEqual(s.frameRate, { num: 30, den: 1 });
  assert.equal(s.audioBitrate, 128_000);
  assert.ok(!("frameRate" in buildSettings(presetChoice("original", HD), HD, OPT("mp4-h264"))));
});

test("the smart default is the device's auto format; an explicit choice that is gone falls back", () => {
  const opts = [OPT("webm-vp9"), OPT("webm-av1")];
  const c = presetChoice("original", HD);
  assert.equal(pickFormat(c, opts, "webm-vp9")?.id, "webm-vp9");
  assert.equal(pickFormat({ ...c, format: "webm-av1" }, opts, "webm-vp9")?.id, "webm-av1");
  assert.equal(pickFormat({ ...c, format: "mp4-h264" }, opts, "webm-vp9")?.id, "webm-vp9");
  assert.equal(pickFormat(c, [], null), null);
});

test("formats are offered only when the device's encoder accepts them (ADR 0004 order)", async () => {
  const chrome = await probeExportFormats({ width: 1920, height: 1080, fps: 30 }, probeOf(["avc1", "vp09", "av01"], ["mp4a.40.2", "opus"]));
  assert.deepEqual(chrome.options.map((o) => o.id), ["mp4-h264", "webm-vp9", "webm-av1"]);
  assert.equal(chrome.auto, "mp4-h264");
  assert.equal(chrome.options[0]!.audioCodec, "aac");
  // The sandbox case: no AAC. WebM/VP9 is the default; MP4 stays offered but flagged.
  const noAac = await probeExportFormats({ width: 1920, height: 1080, fps: 30 }, probeOf(["avc1", "vp09"], ["opus"]));
  assert.equal(noAac.auto, "webm-vp9");
  assert.equal(noAac.options.find((o) => o.id === "mp4-h264")!.warnings.length, 1);
  assert.ok(!noAac.options.some((o) => o.id === "webm-av1"));
  const none = await probeExportFormats({ width: 1920, height: 1080, fps: 30 }, probeOf([], []));
  assert.deepEqual(none, { options: [], auto: null });
});

test("the engine plan can run at a lower frame rate than the project", () => {
  const p = {
    id: "p", name: "t", schema_version: 1, media: [],
    sequences: [{ id: "s", name: "s", frame_rate: { num: 60, den: 1 }, resolution: { width: 1280, height: 720 }, sample_rate: 48000, tracks: [{ id: "v", kind: "video", locked: false, muted: false, name: "V", clips: [{ id: "c", media: "m", start: 0, source_in: 0, duration: 2 * 705_600_000 }] }] }],
  } as unknown as Project;
  assert.equal(planExport(p, { sequence: "s" }).totalFrames, 120);
  const half = planExport(p, { sequence: "s", frameRate: { num: 30, den: 1 } });
  assert.deepEqual([half.fpsNum, half.totalFrames, half.totalSamples], [30, 60, 96000]);
  assert.throws(() => planExport(p, { sequence: "s", frameRate: { num: 0, den: 1 } }), ExportError);
});

test("numbers read well", () => {
  assert.equal(formatBytes(950, "en"), "950 B");
  assert.equal(formatBytes(14_200_000, "en"), "14.2 MB");
  assert.equal(formatBytes(1_500_000_000, "en"), "1.5 GB");
  assert.equal(formatClock(75), "1:15");
  assert.equal(formatClock(3725), "1:02:05");
  assert.equal(etaSeconds(400), 1);
  assert.equal(etaSeconds(42_000), 42);
  assert.equal(etaSeconds(61_000), 65);
});

test("the last choice is remembered, junk and private mode are survivable, a stale custom choice is dropped", () => {
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  assert.deepEqual(loadRemembered(store), { preset: "original" });
  saveRemembered({ preset: "small" }, store);
  assert.deepEqual(loadRemembered(store), { preset: "small" });
  const custom: Choice = { width: 640, height: 360, fps: 24, format: "webm-vp9", quality: "low" };
  saveRemembered({ preset: "custom", custom }, store);
  assert.deepEqual(loadRemembered(store), { preset: "custom", custom });
  mem.set("overcut.export", "{not json");
  assert.deepEqual(loadRemembered(store), { preset: "original" });
  mem.set("overcut.export", JSON.stringify({ preset: "bogus" }));
  assert.deepEqual(loadRemembered(store), { preset: "original" });
  assert.deepEqual(loadRemembered({ getItem: () => { throw new Error("blocked"); } }), { preset: "original" });
  assert.doesNotThrow(() => saveRemembered({ preset: "youtube" }, { setItem: () => { throw new Error("full"); } }));
  assert.equal(usableCustom(custom, HD)?.width, 640);
  assert.equal(usableCustom({ ...custom, width: 3840 }, HD), null);
  assert.equal(usableCustom({ ...custom, fps: 60 }, HD), null);
});

test("the saved file gets a readable name", () => {
  assert.equal(saveName("mwt5k7ql-0-1sssd1.webm", new Date("2026-11-23T10:00:00Z")), "OverCut export 2026-11-23.webm");
});

test("every failure has a friendly message key", () => {
  const key = (code: ConstructorParameters<typeof ExportError>[0]) => errorKey(new ExportError(code, "x"));
  assert.equal(key("storage_failed"), "export.err.storage");
  assert.equal(key("encode_failed"), "export.err.encode");
  assert.equal(key("media_unavailable"), "export.err.media");
  assert.equal(key("unsupported"), "export.err.unsupported");
  assert.equal(key("not_yet"), "export.err.notYet");
  assert.equal(errorKey(new Error("boom")), "export.err.unknown");
});

// ---- delivering the file ----
const file = new File([new Uint8Array(10)], "overcut-export.mp4", { type: "video/mp4;codecs=avc1.640028,mp4a.40.2" });
function fakeWin(picker?: (o: unknown) => Promise<unknown>) {
  const log: string[] = [];
  const a = { href: "", download: "", rel: "", click: () => log.push(`click ${a.download} ${a.href}`), remove: () => log.push("remove") };
  return {
    log,
    win: {
      showSaveFilePicker: picker as never,
      document: { createElement: () => a, body: { append: () => log.push("append") } },
      URL: { createObjectURL: () => "blob:x", revokeObjectURL: (u: string) => log.push(`revoke ${u}`) },
      setTimeout: ((fn: () => void) => { fn(); return 0; }) as never,
    },
  };
}

test("save: a download where there is no picker", async () => {
  const { win, log } = fakeWin();
  assert.equal(await saveFile(file, win as never), "downloaded");
  assert.deepEqual(log, ["append", "click overcut-export.mp4 blob:x", "remove", "revoke blob:x"]);
});

test("save: the save picker writes the file; closing it is not an error; other failures are", async () => {
  let wrote: Blob | undefined;
  let closed = false;
  const ok = fakeWin(async () => ({ createWritable: async () => ({ write: async (b: Blob) => { wrote = b; }, close: async () => { closed = true; } }) }));
  assert.equal(await saveFile(file, ok.win as never), "saved");
  assert.ok(wrote === file && closed);
  const dismissed = fakeWin(async () => { throw new DOMException("closed", "AbortError"); });
  assert.equal(await saveFile(file, dismissed.win as never), "dismissed");
  let aborted = false;
  const full = fakeWin(async () => ({ createWritable: async () => ({ write: async () => { throw new DOMException("full", "QuotaExceededError"); }, close: async () => undefined, abort: async () => { aborted = true; } }) }));
  await assert.rejects(saveFile(file, full.win as never));
  assert.ok(aborted);
});

test("share: only offered when the browser can take the file; closing the sheet is not an error", async () => {
  assert.equal(canShareFile(file, {}), false);
  assert.equal(canShareFile(file, { share: async () => undefined, canShare: () => false }), false);
  assert.equal(canShareFile(file, { share: async () => undefined, canShare: () => true }), true);
  assert.equal(await shareFile(file, "x", { share: async () => undefined }), "shared");
  assert.equal(await shareFile(file, "x", { share: async () => { throw new DOMException("no", "AbortError"); } }), "dismissed");
  await assert.rejects(shareFile(file, "x", { share: async () => { throw new DOMException("no", "NotAllowedError"); } }));
});

test("preset hints never promise more than the output delivers", () => {
  const tiny: Source = { width: 160, height: 120, fps: 30, seconds: 5 };
  assert.deepEqual(presetHint("youtube", tiny), { key: "export.preset.youtube.capped", values: { size: "160×120" } });
  assert.deepEqual(presetHint("small", tiny), { key: "export.preset.small.capped", values: { size: "160×120" } });
  assert.equal(presetHint("youtube", { ...HD, width: 3840, height: 2160 }).key, "export.preset.youtube.hint");
  assert.deepEqual(presetHint("youtube", HD), { key: "export.preset.youtube.hint", values: { size: "1920×1080" } });
  assert.equal(presetHint("small", HD).key, "export.preset.small.hint");
  assert.equal(presetHint("small", SMALL).key, "export.preset.small.hint"); // 720p source: exactly 720p
  // 9:16 from a wide or square project has bars; from a portrait project it fills the frame
  assert.equal(presetHint("vertical", HD).key, "export.preset.vertical.bars");
  assert.equal(presetHint("vertical", { ...HD, width: 1080, height: 1080 }).key, "export.preset.vertical.bars");
  assert.equal(presetHint("vertical", PHONE).key, "export.preset.vertical.hint");
});

test("size estimate follows codec bits per pixel with no floor that inflates tiny frames", () => {
  const tiny: Source = { width: 160, height: 120, fps: 30, seconds: 5 };
  const c = presetChoice("original", tiny);
  const bytes = estimateBytes(c, tiny, OPT("webm-vp9"));
  assert.ok(bytes < 200_000, `${bytes}`); // the 1 Mbps floor gave about 705 KB for a file that came out at 182 KB
  // 1080p30 VP9 high: 1920*1080*30*0.075 = 4.67 Mbps video + 128 kbps audio over 60 s
  assert.equal(estimateBytes(presetChoice("original", HD), HD, OPT("webm-vp9")), Math.round(((4_665_600 + 128_000) * 60) / 8));
  assert.ok(videoBitrate({ ...c, width: 7680, height: 4320 }, HD, "h264") <= 80_000_000);
});
