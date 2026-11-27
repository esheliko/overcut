/**
 * The project canvas (PM-01, `docs/features/project-file.md`, `docs/features/canvas.md`): pure choices <-> the sequence's size and frame rate.
 * No DOM, no engine. The canvas lives in the project (`Sequence.resolution` / `frame_rate` plus the `size_fixed` / `rate_fixed` flags) and changes
 * only through the `set_canvas` op, so it is undoable, journaled and saved in the `.overcut` file; preview and export read the same sequence.
 */
import type { BackgroundMode, Op, Project, Rational, Resolution, Sequence } from "@app/engine-client";

export interface Shape { id: string; w: number; h: number }
/** Aspect presets, in the order the picker shows them. `custom` is added by the dialog. */
export const SHAPES: readonly Shape[] = [
  { id: "16:9", w: 16, h: 9 },
  { id: "9:16", w: 9, h: 16 },
  { id: "1:1", w: 1, h: 1 },
  { id: "4:5", w: 4, h: 5 },
  { id: "21:9", w: 21, h: 9 },
];
/** Short-side choices ("1080p"): 1080 x 1920 vertical, 1920 x 1080 landscape, 1080 x 1350 for 4:5, 2520 x 1080 for 21:9. */
export const QUALITIES = [720, 1080, 1440, 2160] as const;
export const FPS_CHOICES = [24, 25, 30, 50, 60] as const;
/** What an empty project starts as before the first clip (or a choice) says otherwise. */
export const DEFAULT_SIZE: Resolution = { width: 1920, height: 1080 };
export const DEFAULT_RATE: Rational = { num: 30, den: 1 };
export const MIN_SIDE = 16;
export const MAX_SIDE = 8192;

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

/** Pixel size of `shape` at `short` pixels on the short side (both sides even: H.264 wants it). */
export function sizeOf(shape: Shape, short: number): Resolution {
  const wide = shape.w >= shape.h;
  const ratio = wide ? shape.w / shape.h : shape.h / shape.w;
  const long = even(short * ratio);
  return wide ? { width: long, height: even(short) } : { width: even(short), height: long };
}

/** The preset a size belongs to (within a pixel or two of rounding), or `custom`. */
export function shapeOf(r: Resolution): string {
  const a = r.width / r.height;
  return SHAPES.find((s) => Math.abs(a - s.w / s.h) < 0.004)?.id ?? "custom";
}

/** Ratios the canvas chip can name: the picker's presets plus the 4:3 and 3:4 common in phone and archive footage. */
const NAMED_RATIOS: readonly Shape[] = [...SHAPES, { id: "4:3", w: 4, h: 3 }, { id: "3:4", w: 3, h: 4 }];

/** What the canvas chip shows: the named ratio the size matches ("4:3", "16:9"...), else its pixel size ("160×120"). Never "custom". */
export function ratioLabel(r: Resolution): string {
  const a = r.width / r.height;
  let best: Shape | null = null;
  let bestDiff = Infinity;
  for (const s of NAMED_RATIOS) {
    const d = Math.abs(a - s.w / s.h);
    if (d < bestDiff) { best = s; bestDiff = d; }
  }
  return best && bestDiff < 0.004 ? best.id : `${r.width}×${r.height}`;
}

/** The short-side choice a size matches exactly, else null. */
export function qualityOf(r: Resolution): number | null {
  const short = Math.min(r.width, r.height);
  const s = SHAPES.find((x) => x.id === shapeOf(r));
  return s && QUALITIES.includes(short as never) && sizeOf(s, short).width === r.width && sizeOf(s, short).height === r.height ? short : null;
}

/** A frame rate as a number of frames per second (23.976 for 24000/1001). */
export const fpsOf = (r: Rational): number => r.num / r.den;
/** The preset frame rate a rate is, or null (23.976 and 29.97 read as "24" and "30" in the picker only through `fpsLabel`). */
export const presetFps = (r: Rational): number | null => (FPS_CHOICES.find((f) => r.den === 1 && r.num === f) ?? null);
export function fpsLabel(r: Rational): string {
  const v = fpsOf(r);
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, "");
}

/** What the dialog edits. `match` = follow the first picture imported (the zero-question default). */
export interface CanvasChoice {
  shape: string; // "match" | a SHAPES id | "custom"
  short: number; // short side for presets
  custom: Resolution;
  fps: string; // "match" | one of FPS_CHOICES as text
}

export const hasPicture = (p: Project): boolean => p.media.some((m) => m.kind !== "audio");

/** The dialog's starting point: what the sequence says now. */
export function choiceOf(seq: Sequence): CanvasChoice {
  const size = seq.size_fixed ? shapeOf(seq.resolution) : "match";
  const rate = seq.rate_fixed ? presetFps(seq.frame_rate) : null;
  return {
    shape: size,
    short: qualityOf(seq.resolution) ?? 1080,
    custom: seq.resolution,
    fps: seq.rate_fixed ? String(rate ?? "custom") : "match",
  };
}

/** Size a choice means. `match` keeps the sequence's current size (until the first picture arrives, then it is that picture's). */
export function resolutionOf(c: CanvasChoice, current: Resolution): Resolution {
  if (c.shape === "match") return current;
  if (c.shape === "custom") return { width: even(clamp(c.custom.width)), height: even(clamp(c.custom.height)) };
  return sizeOf(SHAPES.find((s) => s.id === c.shape)!, c.short);
}
const clamp = (n: number): number => Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.round(Number.isFinite(n) ? n : MIN_SIDE)));

export function frameRateOf(c: CanvasChoice, current: Rational): Rational {
  return c.fps === "match" || c.fps === "custom" ? current : { num: Number(c.fps), den: 1 };
}

/** True when the choice would change nothing (the dialog's Apply stays disabled). */
export function sameCanvas(seq: Sequence, c: CanvasChoice): boolean {
  const r = resolutionOf(c, seq.resolution);
  const f = frameRateOf(c, seq.frame_rate);
  return r.width === seq.resolution.width && r.height === seq.resolution.height && f.num * seq.frame_rate.den === seq.frame_rate.num * f.den
    && (c.shape !== "match") === !!seq.size_fixed && (c.fps !== "match") === !!seq.rate_fixed;
}

/** The one op that applies a choice (one undo step). */
export function canvasOp(seq: Sequence, c: CanvasChoice): Op {
  return {
    op: "set_canvas",
    sequence: seq.id,
    resolution: resolutionOf(c, seq.resolution),
    frame_rate: frameRateOf(c, seq.frame_rate),
    size_fixed: c.shape !== "match",
    rate_fixed: c.fps !== "match",
  };
}

/** What the dialog edits about the background (TL-19): what shows where no clip covers the canvas. */
export interface BackgroundChoice { mode: BackgroundMode; colour: [number, number, number]; blur: number }
export const BACKGROUND_MODES: readonly BackgroundMode[] = ["black", "colour", "blur"];
export const DEFAULT_BLUR = 50;
/** Preset colours of the swatch row (the design system's accents plus white and a dark grey); any other colour comes from the colour input. */
export const BACKGROUND_SWATCHES: readonly string[] = ["#ffffff", "#1f2937", "#ef4444", "#f59e0b", "#22c55e", "#06b6d4", "#3b82f6", "#a855f7", "#ec4899"];

/** The sequence's background with every default filled in (an older project has none: black). */
export function backgroundOf(seq: Sequence): BackgroundChoice {
  const b = seq.background;
  const c = b?.colour;
  return {
    mode: b?.mode ?? "black",
    colour: c && c.length === 3 ? [c[0]!, c[1]!, c[2]!] : [0, 0, 0],
    blur: b?.blur ?? DEFAULT_BLUR,
  };
}
/** "#rrggbb" for a colour (the colour input's and the swatches' format). */
export const hexOf = (c: readonly number[]): string => `#${c.slice(0, 3).map((v) => Math.min(255, Math.max(0, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
/** The colour a "#rrggbb" string means, or null when it is not one. */
export function rgbOf(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)] : null;
}
/** The parts that count for the mode: a flat colour does not matter while the mode is black or blur, the blur strength only for blur. */
const relevant = (b: BackgroundChoice): string => (b.mode === "colour" ? `c${hexOf(b.colour)}` : b.mode === "blur" ? `b${b.blur}` : "k");
export const sameBackground = (seq: Sequence, b: BackgroundChoice): boolean => b.mode === backgroundOf(seq).mode && relevant(b) === relevant(backgroundOf(seq));
/** The op that sets a background choice (one undo step). The values of the unused parts are kept, so switching back restores them. */
export function backgroundOp(seq: Sequence, b: BackgroundChoice): Op {
  return { op: "set_background", sequence: seq.id, background: { mode: b.mode, colour: [...b.colour], blur: Math.min(100, Math.max(0, Math.round(b.blur))) } };
}
/** Every op the dialog's choices need: the canvas one and/or the background one (a single undo step each; Apply sends them together). */
export function canvasDialogOps(seq: Sequence, c: CanvasChoice, b: BackgroundChoice): Op[] {
  return [...(sameCanvas(seq, c) ? [] : [canvasOp(seq, c)]), ...(sameBackground(seq, b) ? [] : [backgroundOp(seq, b)])];
}

/** Frame rate and size the first picture should set: only the parts the user has not fixed. */
export function adoptedFormat(seq: Sequence, from: { frame_rate: Rational; resolution: Resolution }): { frame_rate: Rational; resolution: Resolution } | null {
  const frame_rate = seq.rate_fixed ? seq.frame_rate : from.frame_rate;
  const resolution = seq.size_fixed ? seq.resolution : from.resolution;
  return seq.rate_fixed && seq.size_fixed ? null : { frame_rate, resolution };
}

/** "9:16 · 1080 × 1920 · 30 fps": the canvas in one line (the preview's button, the announcement after a change). */
export function canvasSummary(size: Resolution, rate: Rational): string {
  const named = ratioLabel(size);
  // a named ratio leads; a free size reads as its dimensions only (never a colon ratio)
  const head = named === `${size.width}×${size.height}` ? "" : `${named} · `;
  return `${head}${size.width} × ${size.height} · ${fpsLabel(rate)} fps`;
}
