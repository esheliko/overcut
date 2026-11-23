/** Export dialog logic with no React and no DOM: presets, sizes, bitrates, the size estimate, formatting, the remembered choice, and error mapping.
 *  Unit-tested in tests/unit/export-dialog.test.ts. Rules: docs/features/export-dialog.md. */
import { ExportError, type ExportErrorCode, type ExportFormatId, type ExportFormatOption, type ExportSettings } from "@app/engine-client";

export type PresetId = "original" | "youtube" | "vertical" | "small";
export type QualityId = "high" | "medium" | "low";
export const PRESET_IDS: readonly PresetId[] = ["original", "youtube", "vertical", "small"];
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

/** The preset's concrete choice for this project. Presets only ever shrink: a 720p project exported as "YouTube 1080p" stays 720p. */
export function presetChoice(id: PresetId, src: Source): Choice {
  switch (id) {
    case "original":
      return { ...scaledSize(src, null), fps: null, format: "auto", quality: "high" };
    case "youtube":
      return { ...scaledSize(src, 1080), fps: src.fps > 60.01 ? 60 : null, format: "auto", quality: "high" };
    case "vertical": {
      // A 9:16 frame as wide as the project allows, at most 1080 wide. A wider picture is placed inside it (black bars; reframing comes later).
      const w = even(Math.min(1080, src.width));
      return { width: w, height: even((w * 16) / 9), fps: src.fps > 60.01 ? 60 : null, format: "auto", quality: "high" };
    }
    case "small":
      return { ...scaledSize(src, 720), fps: src.fps > 30.01 ? 30 : null, format: "auto", quality: "medium" };
  }
}

/** Frame rate the export actually runs at. */
export const outputFps = (c: Choice, src: Source): number => c.fps ?? src.fps;

export function videoBitrate(c: Choice, src: Source, codec: ExportFormatOption["videoCodec"]): number {
  // Bits per pixel per frame (ADR 0004). No 1 Mbps floor like the engine default: on a tiny frame that floor made the estimate several times too big.
  const bpp = codec === "h264" ? 0.1 : codec === "vp9" ? 0.075 : 0.06;
  const rate = c.width * c.height * outputFps(c, src) * bpp * QUALITY_FACTOR[c.quality];
  return Math.min(80_000_000, Math.max(100_000, Math.round(rate)));
}

export const audioBitrate = (audio: "aac" | "opus"): number => (audio === "aac" ? 192_000 : 128_000);

/** The format the choice resolves to on this device, or null when none is encodable. */
export function pickFormat(c: Choice, options: readonly ExportFormatOption[], auto: ExportFormatId | null): ExportFormatOption | null {
  const id = c.format === "auto" ? auto : c.format;
  return options.find((o) => o.id === id) ?? options.find((o) => o.id === auto) ?? options[0] ?? null;
}

/** About how big the file will be: target bitrate x length. The encoder is variable-rate, so the real size lands near this, not on it. */
export function estimateBytes(c: Choice, src: Source, f: ExportFormatOption): number {
  return Math.round(((videoBitrate(c, src, f.videoCodec) + audioBitrate(f.audioCodec)) * src.seconds) / 8);
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
    videoBitrate: videoBitrate(c, src, f.videoCodec),
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
  return !!v && typeof v.width === "number" && typeof v.height === "number" && (v.fps === null || typeof v.fps === "number") && typeof v.format === "string" && QUALITIES.includes(v.quality as QualityId);
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
export function presetHint(id: PresetId, src: Source): { key: string; values: { size: string } } {
  const c = presetChoice(id, src);
  const size = `${c.width}×${c.height}`;
  const short = Math.min(src.width, src.height);
  switch (id) {
    case "original": return { key: "export.preset.original.hint", values: { size } };
    case "youtube": return { key: short < 1080 ? "export.preset.youtube.capped" : "export.preset.youtube.hint", values: { size } };
    case "small": return { key: short < 720 ? "export.preset.small.capped" : "export.preset.small.hint", values: { size } };
    case "vertical": return { key: src.width / src.height > 0.57 ? "export.preset.vertical.bars" : "export.preset.vertical.hint", values: { size } };
  }
}
