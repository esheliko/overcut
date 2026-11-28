/**
 * Pure helpers for the clip inspector and the on-canvas handles (M2-003 / M2-024 UI): read the editable numbers out of a `ClipTransform`,
 * write one back (clamped to what the engine accepts, so `SetClipTransform` is never refused), and mint the coalescing key that makes one
 * drag or one field-editing session a single undo step.
 */
import type { Animated, ClipTransform, Fit } from "@app/engine-client";
import { evalAnimated } from "./keyframeModel";

export type NumKey = "position_x" | "position_y" | "scale_x" | "scale_y" | "rotation" | "opacity" | "crop_left" | "crop_top" | "crop_right" | "crop_bottom";

/** Editable numbers in the engine's own units (fractions, degrees); the UI shows percent for the fractions. */
export type Values = Record<NumKey, number>;

export const DEFAULTS: Values = { position_x: 0, position_y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1, crop_left: 0, crop_top: 0, crop_right: 0, crop_bottom: 0 };

const num = (a: Animated | undefined, d: number, rel: number | undefined): number =>
  rel !== undefined ? evalAnimated(a, d, rel) : a && Number.isFinite(a.value) ? a.value : d;

/** The editable numbers; with `rel` (clip-relative ticks at the playhead) animated properties are evaluated there, else the static value. */
export function valuesOf(t: ClipTransform | undefined, rel?: number): Values {
  const out = { ...DEFAULTS };
  if (t) for (const k of Object.keys(DEFAULTS) as NumKey[]) out[k] = num(t[k], DEFAULTS[k], rel);
  return out;
}

const MAX_CROP = 0.95;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The accepted range of one field given the others (opposite crop edges must leave a picture). */
export function rangeOf(key: NumKey, v: Values): [number, number] {
  switch (key) {
    case "position_x":
    case "position_y":
      return [-5, 5];
    case "scale_x":
    case "scale_y":
      return [0.01, 20];
    case "rotation":
      return [-3600, 3600];
    case "opacity":
      return [0, 1];
    case "crop_left":
      return [0, Math.min(MAX_CROP, 0.99 - v.crop_right)];
    case "crop_right":
      return [0, Math.min(MAX_CROP, 0.99 - v.crop_left)];
    case "crop_top":
      return [0, Math.min(MAX_CROP, 0.99 - v.crop_bottom)];
    case "crop_bottom":
      return [0, Math.min(MAX_CROP, 0.99 - v.crop_top)];
  }
}

/** A copy of `t` with `key` set to `value` (clamped). A non-finite value changes nothing. Keyframes of the field are kept (M2-004). */
export function setField(t: ClipTransform | undefined, key: NumKey, value: number): ClipTransform {
  const base = t ?? {};
  if (!Number.isFinite(value)) return base;
  const [lo, hi] = rangeOf(key, valuesOf(t));
  return { ...base, [key]: { ...base[key], value: clamp(value, lo, hi) } };
}

/** Several fields at once (a drag moves x and y together). Applied in order. */
export function setFields(t: ClipTransform | undefined, patch: Partial<Values>): ClipTransform {
  let out = t;
  for (const [k, v] of Object.entries(patch) as [NumKey, number][]) out = setField(out, k, v);
  return out ?? {};
}

export function setFit(t: ClipTransform | undefined, fit: Fit): ClipTransform {
  return { ...(t ?? {}), fit };
}

export function toggleFlip(t: ClipTransform | undefined, axis: "h" | "v"): ClipTransform {
  const k = axis === "h" ? "flip_h" : "flip_v";
  return { ...(t ?? {}), [k]: !(t?.[k] ?? false) };
}

/** The identity (what the engine treats as default and does not write). */
export const RESET: ClipTransform = {};

export function isIdentity(t: ClipTransform | undefined): boolean {
  if (!t) return true;
  if ((Object.keys(DEFAULTS) as NumKey[]).some((k) => t[k]?.keys?.length)) return false;
  const v = valuesOf(t);
  return (Object.keys(DEFAULTS) as NumKey[]).every((k) => v[k] === DEFAULTS[k]) && !t.flip_h && !t.flip_v && (t.fit ?? "contain") === "contain" && !t.anchor_x?.value && !t.anchor_y?.value;
}

/** One key per gesture: edits sent with the same key are one undo step (docs/features/timeline-ops.md). Starts high to stay clear of other users of the key. */
let gesture = 0x4000_0000;
export function newGestureKey(): number {
  gesture = gesture >= 0x7fff_ffff ? 0x4000_0000 : gesture + 1;
  return gesture;
}

/**
 * Rotation while dragging the rotate handle: Shift snaps to 15-degree steps, otherwise to a right angle (0, 90, 180, 270, ...) when within
 * 3 degrees of one. Pure; the handle (preview/TransformHandles) calls it with the raw angle in degrees.
 */
export function snapRotation(deg: number, shift: boolean): number {
  if (!Number.isFinite(deg)) return deg;
  if (shift) return Math.round(deg / 15) * 15 || 0;
  const near = Math.round(deg / 90) * 90 || 0; // `|| 0` keeps -0 out
  return Math.abs(deg - near) <= 3 ? near : deg;
}

/** Guide lines to draw while a move snaps, as fractions of the canvas (0 = left / top edge, 0.5 = centre, 1 = right / bottom edge). */
export interface SnapGuides { x?: number; y?: number }

/**
 * Moving a picture on the preview: pull its visible box onto the canvas centre or edges. `box` is the axis-aligned bounding box of the picture at the
 * position the pointer asks for (centre and half sizes, canvas pixels); within `tol` canvas pixels its centre lands on the canvas centre, or its left /
 * right / top / bottom edge on the matching canvas edge. Returns the shift to add and the guides to draw. Pure; each axis snaps on its own.
 */
export function snapMove(box: { cx: number; cy: number; hw: number; hh: number }, canvas: { width: number; height: number }, tol: number): { dx: number; dy: number; guides: SnapGuides } {
  const axis = (c: number, h: number, size: number): { d: number; at?: number } => {
    let best: { d: number; at?: number } = { d: 0 };
    let bestAbs = tol + 1e-9; // a tie (a picture as big as the canvas has its centre and its edges all on one line) keeps the centre, the first candidate
    for (const [value, at] of [[c, 0.5], [c - h, 0], [c + h, 1]] as const) {
      const d = at * size - value;
      if (Math.abs(d) < bestAbs) { best = { d, at }; bestAbs = Math.abs(d); }
    }
    return best;
  };
  const x = axis(box.cx, box.hw, canvas.width);
  const y = axis(box.cy, box.hh, canvas.height);
  return { dx: x.d, dy: y.d, guides: { ...(x.at !== undefined ? { x: x.at } : {}), ...(y.at !== undefined ? { y: y.at } : {}) } };
}
