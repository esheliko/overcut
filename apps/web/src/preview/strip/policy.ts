/**
 * Scrub strip policy (docs/features/preview.md "Smooth scrubbing"): which clips get a background-built strip of small JPEG stand-ins, and its shape.
 * Pure functions, no platform calls: the numbers a device reports go in, a yes/no and a plan come out.
 */

/** Scrub budget for the first visible frame after a seek (docs/PERFORMANCE.md, low tier). A clip whose exact seek is slower than this needs help. */
export const SCRUB_BUDGET_MS = 120;
/** Fixed cost of a seek (read, plan, message, draw), ms; from the owner's laptop and S24 numbers (GOP 30 p50 minus half a GOP of decode). */
export const SEEK_OVERHEAD_MS = 15;
/** Seeks needed before the measured numbers outrank the estimate. */
export const MIN_SAMPLES = 8;
/** A clip shorter than this is never worth a strip (a whole-clip decode is cheap). */
export const MIN_FRAMES = 60;

export type Tier = "low" | "mid" | "high";

/**
 * Decode cost of one frame during a seek, ms per megapixel, per tier. Derived from `/diagnostics` seek p95 on GOP 150 (docs/PERFORMANCE.md):
 * laptop 202 ms -> 0.7, Galaxy S24 376 ms -> 1.3, low-end proxy 1254 ms -> 4.4 (the proxy is a calibrated estimate, not a measurement).
 * (p95 - overhead) / (0.9 x GOP) / 2.07 MP (1080p).
 */
export const MS_PER_MEGAPIXEL: Record<Tier, number> = { high: 0.7, mid: 1.3, low: 4.4 };

/** Device tier from what a Worker can read (`navigator.hardwareConcurrency`, `navigator.deviceMemory`, the user agent). Unknown values count as capable, never as a reason to build. */
export function deviceTier(d: { cores?: number; memoryGb?: number; mobile?: boolean }): Tier {
  const cores = d.cores ?? 8;
  const mem = d.memoryGb ?? 8;
  if (d.mobile) return mem <= 4 || cores <= 4 ? "low" : "mid";
  if (mem <= 2 || cores <= 2) return "low";
  return cores >= 8 ? "high" : "mid";
}

export interface GopInfo {
  /** Frames in the video track. */
  frames: number;
  /** Longest run of frames from one keyframe to the next. */
  maxGop: number;
  /** Mean distance between keyframes. */
  meanGop: number;
}

/** GOP lengths from the decode-order positions of the keyframes (the demuxer's index) and the packet count. */
export function gopOf(keys: ArrayLike<number>, frames: number): GopInfo {
  if (frames <= 0) return { frames: 0, maxGop: 0, meanGop: 0 };
  if (keys.length === 0) return { frames, maxGop: frames, meanGop: frames };
  let max = 0;
  for (let i = 0; i < keys.length; i++) max = Math.max(max, (i + 1 < keys.length ? keys[i + 1]! : frames) - keys[i]!);
  return { frames, maxGop: max, meanGop: frames / keys.length };
}

/** Estimated p95 of a random exact seek, ms: fixed cost + decoding up to 0.9 of the longest GOP from its keyframe. */
export function estimateSeekP95(gop: GopInfo, width: number, height: number, tier: Tier): number {
  const mp = (width * height) / 1e6;
  return SEEK_OVERHEAD_MS + 0.9 * gop.maxGop * MS_PER_MEGAPIXEL[tier] * mp;
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

export interface Decision { build: boolean; reason: "short" | "small" | "estimate" | "measured" | "fast-enough"; estimateMs: number; measuredP95?: number }

/**
 * The detection rule. Never for tiny clips or pictures at most 480 px on the long edge (decode is cheap). Measured seek times (>= 8 exact seeks of this
 * clip on this device) decide when there are any: slower than the budget builds, within 60 % of it does not. Otherwise the estimate from GOP length,
 * picture size and device tier decides.
 */
export function needsStrip(gop: GopInfo, width: number, height: number, tier: Tier, seeks: readonly number[] = []): Decision {
  const estimateMs = estimateSeekP95(gop, width, height, tier);
  if (gop.frames < MIN_FRAMES) return { build: false, reason: "short", estimateMs };
  if (Math.max(width, height) <= 480) return { build: false, reason: "small", estimateMs };
  if (seeks.length >= MIN_SAMPLES) {
    const measuredP95 = percentile([...seeks].sort((a, b) => a - b), 0.95);
    if (measuredP95 > SCRUB_BUDGET_MS) return { build: true, reason: "measured", estimateMs, measuredP95 };
    if (measuredP95 <= 0.6 * SCRUB_BUDGET_MS) return { build: false, reason: "fast-enough", estimateMs, measuredP95 };
    return { build: estimateMs > SCRUB_BUDGET_MS, reason: estimateMs > SCRUB_BUDGET_MS ? "estimate" : "fast-enough", estimateMs, measuredP95 };
  }
  return estimateMs > SCRUB_BUDGET_MS ? { build: true, reason: "estimate", estimateMs } : { build: false, reason: "fast-enough", estimateMs };
}

export interface StripSpec {
  /** Picture size of every stored frame (coded orientation, even numbers). */
  w: number;
  h: number;
  /** One frame in `stride` is stored (the stand-in is at most stride/2 frames off, and the exact frame replaces it anyway). */
  stride: number;
  /** Source frames per stored segment (a multiple of `stride`). */
  segFrames: number;
  /** JPEG quality, 0..1. */
  quality: number;
}

export const STRIP_LONG_EDGE = 480;
export const STRIP_QUALITY = 0.55;
/** About this many stored frames per second of video. */
export const STRIP_FPS = 15;
export const SEGMENT_SECONDS = 8;

/** The strip's shape for a clip: 480 px on the long edge, about 15 stored frames per second, segments of about 8 s. */
export function planStrip(width: number, height: number, fps: number): StripSpec {
  const k = Math.min(1, STRIP_LONG_EDGE / Math.max(width, height, 1));
  const even = (v: number) => Math.max(2, Math.round((v * k) / 2) * 2);
  const stride = Math.max(1, Math.round(fps / STRIP_FPS));
  const perSeg = Math.max(1, Math.round((SEGMENT_SECONDS * fps) / stride));
  return { w: even(width), h: even(height), stride, segFrames: perSeg * stride, quality: STRIP_QUALITY };
}

/** The stored frame closest to `index` (ties go to the earlier one), clamped to the clip. */
export function nearestStored(index: number, stride: number, frames: number): number {
  const lower = Math.floor(index / stride) * stride;
  const upper = lower + stride;
  const pick = index - lower <= upper - index || upper >= frames ? lower : upper;
  return Math.min(Math.max(0, pick), Math.max(0, frames - 1));
}
