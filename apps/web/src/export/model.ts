/** Export dialog logic with no React and no DOM: presets, sizes, bitrates, the size estimate, formatting, the remembered choice, and error mapping.
 *  Unit-tested in tests/unit/export-dialog.test.ts. Rules: docs/features/export-dialog.md. */
import { ExportError, type DesktopCodecs, type ExportErrorCode, type ExportFormatId, type ExportFormatOption, type ExportFailureDetail, type ExportFormats, type ExportSettings } from "@app/engine-client";

export type PresetId = "original" | "youtube" | "vertical" | "x" | "facebook" | "whatsapp" | "discord" | "small";
export type QualityId = "high" | "medium" | "low";
export const PRESET_IDS: readonly PresetId[] = ["original", "youtube", "vertical", "x", "facebook", "whatsapp", "discord", "small"];
export const QUALITIES: readonly QualityId[] = ["high", "medium", "low"];
/** Video bitrate as a share of the default for the size (ADR 0004: bits per pixel). */
export const QUALITY_FACTOR: Record<QualityId, number> = { high: 1, medium: 0.6, low: 0.35 };

export interface Source {
  width: number;
  height: number;
  /** Frames per second of the project. */
  fps: number;
  seconds: number;
}

/** What the person chose, whether from a preset chip or the Advanced section. `null` size/fps/format = "same as the project" / "best this device can do". */
export interface Choice {
  width: number;
  height: number;
  /** Whole frames per second to export at, or null for the project's own rate. */
  fps: number | null;
  format: ExportFormatId | "auto";
  quality: QualityId;
  /** A size the file should stay under (platform upload cap): the video bitrate is lowered to aim at it. Dropped by any Advanced edit. */
  capBytes?: number;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** `short` pixels on the short side, same shape, never bigger than the project (no pointless upscaling). `null` = the project's own size. */
export function scaledSize(src: Pick<Source, "width" | "height">, short: number | null): { width: number; height: number } {
  const s = Math.min(src.width, src.height);
  if (short === null || short >= s) return { width: even(src.width), height: even(src.height) };
  const k = short / s;
  return { width: even(src.width * k), height: even(src.height * k) };
}

/** The sizes the Advanced section offers: the project's own, then standard steps below it. */
export function resolutionSteps(src: Pick<Source, "width" | "height">): { short: number | null; width: number; height: number }[] {
  const s = Math.min(src.width, src.height);
  const out: { short: number | null; width: number; height: number }[] = [{ short: null, ...scaledSize(src, null) }];
  for (const step of [2160, 1440, 1080, 720, 480]) if (step < s) out.push({ short: step, ...scaledSize(src, step) });
  return out;
}

/** Frame rates the Advanced section offers: the project's own (null) and the usual ones below it. */
export function fpsSteps(srcFps: number): (number | null)[] {
  return [null, ...[60, 50, 30, 25, 24].filter((f) => f < srcFps - 0.01 && Math.abs(f - srcFps) > 0.01)];
}

/**
 * Platform limits the presets use. The sourced figures and their "last checked" dates live in ONE table: docs/features/export.md
 * ("Platform limits"). Change a number there and here together. `capBytes` is what we aim under (decimal MB, as the platforms count),
 * `maxSeconds` only drives a warning (a longer video is not cut). Where sources disagree we use the lowest figure reported.
 */
export interface PlatformSpec {
  /** Short side to export at (never enlarged). */
  short: number;
  fpsMax: number;
  capBytes?: number;
  maxSeconds?: number;
  /** A fixed 9:16 frame (the project is fitted inside it with bars, never cropped). */
  tall?: boolean;
}
export const PLATFORMS: Partial<Record<PresetId, PlatformSpec>> = {
  youtube: { short: 1080, fpsMax: 60 },
  vertical: { short: 1080, fpsMax: 60, tall: true },
  x: { short: 1080, fpsMax: 60, capBytes: 512_000_000, maxSeconds: 140 },
  /** Feed and Reels share one spec: Full HD, no cap used (reported 10 GB / 240 min is out of reach), and the shape is kept (Reels framing is TL-24). */
  facebook: { short: 1080, fpsMax: 60 },
  whatsapp: { short: 720, fpsMax: 30, capBytes: 16_000_000 },
  discord: { short: 720, fpsMax: 30, capBytes: 10_000_000 },
};

/** Share of a cap the video aims for: the encoder is variable-rate and the container adds overhead, so aim under, not at, the limit. */
export const CAP_MARGIN = 0.9;
/** Below this many bits per pixel per frame a picture stops being watchable (H.264 "Medium" is 0.06): step the size down instead of the quality. */
export const MIN_BPP = 0.05;
const CAP_AUDIO_BPS = 192_000; // worst case (AAC), so the choice does not depend on the codec picked later

const capVideoBps = (capBytes: number, seconds: number, audioBps: number) => Math.max(0, (capBytes * CAP_MARGIN * 8) / Math.max(0.1, seconds) - audioBps);

/** The preset's concrete choice for this project. Presets only ever shrink: a 720p project exported as "YouTube 1080p" stays 720p. A capped preset also steps the size down until the cap leaves a watchable bitrate. */
export function presetChoice(id: PresetId, src: Source): Choice {
  if (id === "original") return { ...scaledSize(src, null), fps: null, format: "auto", quality: "high" };
  if (id === "small") return { ...scaledSize(src, 720), fps: src.fps > 30.01 ? 30 : null, format: "auto", quality: "medium" };
  const p = PLATFORMS[id]!;
  const fps = src.fps > p.fpsMax + 0.01 ? p.fpsMax : null;
  const rate = fps ?? src.fps;
  if (p.tall) {
    // A 9:16 frame as wide as the project allows, at most 1080 wide. A different shape is placed inside it (bars; reframing comes later).
    const w = even(Math.min(p.short, src.width));
    return { width: w, height: even((w * 16) / 9), fps, format: "auto", quality: "high" };
  }
  let size = scaledSize(src, p.short);
  if (p.capBytes) {
    const budget = capVideoBps(p.capBytes, src.seconds, CAP_AUDIO_BPS);
    const steps = [p.short, 720, 480, 360, 240].filter((s) => s <= p.short);
    for (const short of [...new Set(steps)]) {
      size = scaledSize(src, short);
      if (budget / (size.width * size.height * rate) >= MIN_BPP) break; // the last step stays when nothing reaches it
    }
  }
  return { ...size, fps, format: "auto", quality: "high", ...(p.capBytes ? { capBytes: p.capBytes } : null) };
}

/** What a preset writes, as one comparable string: two presets with the same key give the same file for this project. */
const presetKey = (c: Choice): string => [c.width, c.height, c.fps ?? "same", c.format, c.quality, c.capBytes ?? "nocap"].join("|");

/**
 * Presets that would give the same file for this project are one choice: the first of each group (in `ids` order) is shown, the others are listed
 * under it (`same`). A 720p project exported as "YouTube 1080p" is just "Original" with another name, so offering both made the choice look real when it was not.
 */
export function mergePresets(ids: readonly PresetId[], src: Source): { id: PresetId; same: PresetId[] }[] {
  const out: { id: PresetId; same: PresetId[]; key: string }[] = [];
  for (const id of ids) {
    const key = presetKey(presetChoice(id, src));
    const hit = out.find((g) => g.key === key);
    if (hit) hit.same.push(id);
    else out.push({ id, same: [], key });
  }
  return out.map(({ id, same }) => ({ id, same }));
}

/** The same choice without a platform's size cap (any manual change makes it a custom choice). */
export function withoutCap(c: Choice): Choice {
  const out = { ...c };
  delete out.capBytes;
  return out;
}

/** True when the picture's shape differs from the preset's fixed frame, so it will be placed inside it with bars (only 9:16 presets have one). */
export function needsBars(id: PresetId, src: Pick<Source, "width" | "height">): boolean {
  if (!PLATFORMS[id]?.tall) return false;
  return Math.abs(src.width / src.height - 9 / 16) > 0.02;
}

/** Warnings for a choice: over a platform's duration limit, or too long for its size cap even at the lowest bitrate. Pure; the UI shows them next to the estimate. */
export interface PresetWarning { key: "export.warn.duration" | "export.warn.cap"; values: Record<string, string | number> }
export function presetWarnings(id: PresetId | "custom", c: Choice, src: Source, f: ExportFormatOption, locale?: string): PresetWarning[] {
  const out: PresetWarning[] = [];
  const p = id === "custom" ? undefined : PLATFORMS[id];
  if (p?.maxSeconds && src.seconds > p.maxSeconds) out.push({ key: "export.warn.duration", values: { limit: formatClock(p.maxSeconds), length: formatClock(src.seconds) } });
  if (c.capBytes) {
    const est = estimateBytes(c, src, f);
    if (est > c.capBytes) out.push({ key: "export.warn.cap", values: { cap: formatBytes(c.capBytes, locale), size: formatBytes(est, locale) } });
  }
  return out;
}

/** Frame rate the export actually runs at. */
export const outputFps = (c: Choice, src: Source): number => c.fps ?? src.fps;

export function videoBitrate(c: Choice, src: Source, codec: ExportFormatOption["videoCodec"], audio: "aac" | "opus" = codec === "h264" ? "aac" : "opus"): number {
  // Bits per pixel per frame (ADR 0004). No 1 Mbps floor like the engine default: on a tiny frame that floor made the estimate several times too big.
  const bpp = codec === "h264" ? 0.1 : codec === "vp9" ? 0.075 : 0.06;
  const rate = c.width * c.height * outputFps(c, src) * bpp * QUALITY_FACTOR[c.quality];
  const normal = Math.min(80_000_000, Math.max(100_000, Math.round(rate)));
  // Size-capped preset: never above what keeps the file under the cap (same floor, so a very long video still gets a picture and the estimate says it will not fit).
  return c.capBytes ? Math.min(normal, Math.max(100_000, Math.round(capVideoBps(c.capBytes, src.seconds, audioBitrate(audio))))) : normal;
}

export const audioBitrate = (audio: "aac" | "opus"): number => (audio === "aac" ? 192_000 : 128_000);

/**
 * A plain-words note for the dialog when the file is WebM only because this device cannot make MP4 (ADR 0004: H.264 is the default wherever
 * it encodes). Null otherwise, including when the person picked WebM on purpose. Pure; the copy key lives in en.json.
 */
/** The format's name in the dialog (a message key). An MP4 that could only get Opus sound on this device (no AAC encoder) does not claim to work everywhere. */
export function formatLabelKey(f: Pick<ExportFormatOption, "id" | "audioCodec">, desktop = false): string {
  if (desktop && f.id === "webm-vp9") return "export.format.webm-vp9.offline";
  if (f.id === "mp4-h264" && f.audioCodec === "opus") return "export.format.mp4-h264.opus";
  return FORMAT_KEY[f.id];
}
const FORMAT_KEY: Record<ExportFormatId, string> = { "mp4-h264": "export.format.mp4-h264", "webm-vp9": "export.format.webm-vp9", "webm-av1": "export.format.webm-av1" };

export function formatNote(f: ExportFormatOption, options: readonly ExportFormatOption[]): "export.format.noMp4" | null {
  if (f.container !== "webm" || options.length === 0) return null;
  return options.some((o) => o.id === "mp4-h264") ? null : "export.format.noMp4";
}

/** The format the choice resolves to on this device, or null when none is encodable. */
export function pickFormat(c: Choice, options: readonly ExportFormatOption[], auto: ExportFormatId | null): ExportFormatOption | null {
  const id = c.format === "auto" ? auto : c.format;
  return options.find((o) => o.id === id) ?? options.find((o) => o.id === auto) ?? options[0] ?? null;
}

/** About how big the file will be: target bitrate x length. The encoder is variable-rate, so the real size lands near this, not on it. */
export function estimateBytes(c: Choice, src: Source, f: ExportFormatOption): number {
  return Math.round(((videoBitrate(c, src, f.videoCodec, f.audioCodec) + audioBitrate(f.audioCodec)) * src.seconds) / 8);
}

/** The settings handed to `engine.export.start` (the sequence and the media files are added by the caller). */
export function buildSettings(c: Choice, src: Source, f: ExportFormatOption): Omit<ExportSettings, "sequence" | "sources"> {
  return {
    container: f.container,
    videoCodec: f.videoCodec,
    audioCodec: f.audioCodec,
    width: c.width,
    height: c.height,
    ...(c.fps !== null ? { frameRate: { num: c.fps, den: 1 } } : null),
    videoBitrate: videoBitrate(c, src, f.videoCodec, f.audioCodec),
    audioBitrate: audioBitrate(f.audioCodec),
  };
}

export function formatBytes(n: number, locale?: string): string {
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  const text = new Intl.NumberFormat(locale, { maximumFractionDigits: v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2 }).format(v);
  return `${text} ${units[i]}`;
}

/** `m:ss` (or `h:mm:ss`) for a length in seconds. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Whole seconds left, rounded up to 5 s above a minute so the figure does not jitter. */
export function etaSeconds(etaMs: number): number {
  const s = Math.max(1, Math.ceil(etaMs / 1000));
  return s > 60 ? Math.ceil(s / 5) * 5 : s;
}

// ---- the remembered choice ----
export interface Remembered { preset: PresetId | "custom"; custom?: Choice }
const KEY = "overcut.export";

export function loadRemembered(store: Pick<Storage, "getItem"> | undefined = safeStorage()): Remembered {
  try {
    const raw = store?.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as Partial<Remembered>) : null;
    if (v && (v.preset === "custom" || PRESET_IDS.includes(v.preset as PresetId))) return { preset: v.preset as Remembered["preset"], ...(v.preset === "custom" && isChoice(v.custom) ? { custom: v.custom } : null) };
  } catch { /* unreadable: use the default */ }
  return { preset: "original" };
}

export function saveRemembered(r: Remembered, store: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
  try { store?.setItem(KEY, JSON.stringify(r)); } catch { /* private mode: the choice lasts this session */ }
}

function safeStorage(): Storage | undefined {
  try { return typeof localStorage === "undefined" ? undefined : localStorage; } catch { return undefined; }
}

function isChoice(c: unknown): c is Choice {
  const v = c as Partial<Choice> | undefined;
  return !!v && typeof v.width === "number" && typeof v.height === "number" && (v.fps === null || typeof v.fps === "number") && typeof v.format === "string" && QUALITIES.includes(v.quality as QualityId) && (v.capBytes === undefined || typeof v.capBytes === "number");
}

/** A remembered custom choice still valid for this project (sizes at or below the project's, same frame-rate rule), else null. */
export function usableCustom(c: Choice | undefined, src: Source): Choice | null {
  if (!c || c.width > even(src.width) || c.height > even(src.height) || (c.fps !== null && c.fps >= src.fps)) return null;
  return c;
}

// ---- errors ----
/** The message key for a failure; the dialog shows it with t(). Anything not an `ExportError` is a generic failure. */
export function errorKey(e: unknown): string {
  const code: ExportErrorCode | "unknown" = e instanceof ExportError ? e.code : "unknown";
  switch (code) {
    case "storage_failed": return "export.err.storage";
    case "encode_failed": return "export.err.encode";
    case "unsupported": return "export.err.unsupported";
    case "media_unavailable": return "export.err.media";
    case "media_failed": return "export.err.mediaFailed";
    case "empty_sequence": return "export.err.empty";
    case "not_yet": return "export.err.notYet";
    default: return "export.err.unknown";
  }
}
export const isCancel = (e: unknown): boolean => e instanceof ExportError && e.code === "cancelled";

/** A name worth saving under: "OverCut export 2026-11-23.mp4" (the engine's own file name is an internal id). */
export function saveName(internal: string, date: Date = new Date()): string {
  const ext = internal.includes(".") ? internal.slice(internal.lastIndexOf(".")) : "";
  return `OverCut export ${date.toISOString().slice(0, 10)}${ext}`;
}

/** The chip's second line, as a message key plus values, so it never promises more than the output delivers. */
export function presetHint(id: PresetId, src: Source, locale?: string): { key: string; values: Record<string, string> } {
  const c = presetChoice(id, src);
  const size = `${c.width}×${c.height}`;
  const short = Math.min(src.width, src.height);
  switch (id) {
    case "original": return { key: "export.preset.original.hint", values: { size } };
    case "youtube": return { key: short < 1080 ? "export.preset.youtube.capped" : "export.preset.youtube.hint", values: { size } };
    case "small": return { key: short < 720 ? "export.preset.small.capped" : "export.preset.small.hint", values: { size } };
    case "vertical": return { key: needsBars(id, src) ? "export.preset.vertical.bars" : "export.preset.vertical.hint", values: { size } };
    case "facebook": return { key: short < 1080 ? "export.preset.facebook.capped" : "export.preset.facebook.hint", values: { size } };
    case "x": return { key: short < 1080 ? "export.preset.x.capped" : "export.preset.x.hint", values: { size, cap: formatBytes(PLATFORMS[id]!.capBytes!, locale) } };
    case "whatsapp":
    case "discord": return { key: "export.preset.capped.hint", values: { size, cap: formatBytes(PLATFORMS[id]!.capBytes!, locale) } };
  }
}

// ---- desktop app: what the native encoder offers (docs/features/desktop.md) ----
/**
 * The formats the desktop app can write on this computer. MP4 (H.264 + AAC) needs an H.264 encoder: an OS / GPU one, or Cisco's OpenH264 once the person
 * has enabled it. Without one, WebM (VP9 + Opus, no network) is the default where the app can write it. Never offers a format the encoder cannot make.
 */
export function desktopFormats(c: DesktopCodecs): ExportFormats {
  if (c.h264 !== "none") return { options: [{ id: "mp4-h264", container: "mp4", videoCodec: "h264", audioCodec: "aac", warnings: [] }], auto: "mp4-h264" };
  if (c.webm) return { options: [{ id: "webm-vp9", container: "webm", videoCodec: "vp9", audioCodec: "opus", warnings: [] }], auto: "webm-vp9" };
  return { options: [], auto: null };
}

/** True when MP4 is missing and the person can switch it on (the explicit "Enable MP4" button): never downloads by itself. */
export const canOfferH264Download = (c: DesktopCodecs): boolean => c.h264 === "none" && c.canEnableH264;

/** The full failure for the "Technical details" box: code, name, message, stage, clip and position, encoder configs, stack and every earlier attempt. One line per fact so a screenshot of it is enough. */
export function describeFailure(e: unknown): string {
  const lines: string[] = [];
  const add = (label: string, v: unknown): void => { if (v !== undefined && v !== "") lines.push(`${label}: ${String(v)}`); };
  const detail = (d: ExportFailureDetail, indent: string): void => {
    const put = (label: string, v: unknown): void => { if (v !== undefined && v !== "") lines.push(`${indent}${label}: ${String(v)}`); };
    put("error", [d.name, d.message].filter(Boolean).join(": "));
    put("stage", d.stage);
    put("clip", d.clip);
    put("at", d.at);
    put("frames encoded", d.frames);
    put("compatibility level", d.level);
    put("video", d.video);
    put("audio", d.audio);
    if (d.filename) put("source", `${d.filename}:${d.lineno ?? 0}:${d.colno ?? 0}`);
    put("stack", d.stack?.split("\n").slice(0, 6).join(" | "));
  };
  if (e instanceof ExportError) {
    add("code", e.code);
    add("message", e.message);
    if (e.detail) detail(e.detail, "");
    e.detail?.attempts?.forEach((a, i) => { lines.push(`attempt ${i + 1} (failed earlier):`); detail(a, "  "); });
  } else if (e instanceof Error) {
    add("error", `${e.name}: ${e.message}`);
    add("stack", e.stack?.split("\n").slice(0, 6).join(" | "));
  } else add("error", String(e));
  return lines.join("\n");
}
