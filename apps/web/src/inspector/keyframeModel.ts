/**
 * Pure keyframe helpers for the inspector and the timeline diamonds (M2-004 / M2-048, `docs/features/keyframes.md`): evaluate a property
 * the way the engine does (for display and for the value a new key starts from), find keys near the playhead, name easings, build ops.
 * Times are clip-relative integer ticks, like the engine's.
 */
import type { Animated, Clip, ClipTransform, Easing, Keyframe, Op, Rational, TransformProp } from "@app/engine-client";
import { TICKS_PER_SECOND } from "../timeline/scene";

export const LINEAR: Easing = { kind: "linear" };
export const HOLD: Easing = { kind: "hold" };
/** CSS presets, stored as numbers (the file has no names; `easingId` matches them back). Same numbers as `Easing::EASE_*` in app-model. */
export const EASE_IN: Easing = { kind: "bezier", x1: 0.42, y1: 0, x2: 1, y2: 1 };
export const EASE_OUT: Easing = { kind: "bezier", x1: 0, y1: 0, x2: 0.58, y2: 1 };
export const EASE_IN_OUT: Easing = { kind: "bezier", x1: 0.42, y1: 0, x2: 0.58, y2: 1 };

export type EasingId = "linear" | "ease-in" | "ease-out" | "ease-in-out" | "hold" | "custom";
export const EASING_CHOICES: readonly { id: Exclude<EasingId, "custom">; easing: Easing }[] = [
  { id: "linear", easing: LINEAR },
  { id: "ease-in", easing: EASE_IN },
  { id: "ease-out", easing: EASE_OUT },
  { id: "ease-in-out", easing: EASE_IN_OUT },
  { id: "hold", easing: HOLD },
];

const same = (a: Easing, b: Easing): boolean => {
  if (a.kind !== "bezier" || b.kind !== "bezier") return a.kind === b.kind;
  return a.x1 === b.x1 && a.y1 === b.y1 && a.x2 === b.x2 && a.y2 === b.y2;
};

/** The preset a stored easing is (a missing easing is linear, as in the file); anything else is "custom". */
export function easingId(e: Easing | undefined): EasingId {
  const x = e ?? LINEAR;
  return EASING_CHOICES.find((c) => same(c.easing, x))?.id ?? "custom";
}

const keysOf = (a: Animated | undefined): readonly Keyframe[] => a?.keys ?? [];

/** Eased progress of a CSS cubic-bezier at `x` (display only: bisection, the engine's own solver decides the rendered frame). */
function bezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  const at = (a: number, b: number, s: number) => 3 * a * s * (1 - s) * (1 - s) + 3 * b * s * s * (1 - s) + s * s * s;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (at(x1, x2, mid) < x) lo = mid;
    else hi = mid;
  }
  return at(y1, y2, (lo + hi) / 2);
}

/** Value of `a` at clip-relative `t` ticks: end values hold, `hold` steps, `linear` and beziers blend. Mirrors `Animated::eval`. */
export function evalAnimated(a: Animated | undefined, fallback: number, t: number): number {
  const keys = keysOf(a);
  if (!a) return fallback;
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (!first || !last) return Number.isFinite(a.value) ? a.value : fallback;
  if (t <= first.t) return first.v;
  if (t >= last.t) return last.v;
  let i = 0;
  while (keys[i + 1]!.t <= t) i++;
  const k0 = keys[i]!;
  const k1 = keys[i + 1]!;
  const e = k0.easing ?? LINEAR;
  if (e.kind === "hold") return k0.v;
  const x = (t - k0.t) / (k1.t - k0.t);
  const s = e.kind === "linear" ? x : bezier(e.x1, e.y1, e.x2, e.y2, x);
  return k0.v * (1 - s) + k1.v * s;
}

export const isAnimated = (a: Animated | undefined): boolean => keysOf(a).length > 0;

/** The key within `tol` ticks of `rel` (the playhead snaps to frames, a key may sit between two), nearest first. */
export function keyNear(a: Animated | undefined, rel: number, tol: number): Keyframe | undefined {
  let best: Keyframe | undefined;
  for (const k of keysOf(a)) if (Math.abs(k.t - rel) <= tol && (!best || Math.abs(k.t - rel) < Math.abs(best.t - rel))) best = k;
  return best;
}

export type KeyState = "none" | "between" | "on";
/** `none` = not animated, `between` = animated but no key at the playhead, `on` = a key at the playhead. */
export function keyState(a: Animated | undefined, rel: number, tol: number): KeyState {
  if (!isAnimated(a)) return "none";
  return keyNear(a, rel, tol) ? "on" : "between";
}

/** The clip-relative time of the closest key before / after `rel` (outside `tol` of it), or undefined. */
export function neighbourKey(a: Animated | undefined, rel: number, tol: number, dir: -1 | 1): number | undefined {
  const ks = keysOf(a);
  return dir < 0 ? [...ks].reverse().find((k) => k.t < rel - tol)?.t : ks.find((k) => k.t > rel + tol)?.t;
}

/** Ticks of one frame (the playhead's step) and the playhead as clip-relative ticks. The store keeps the playhead in frames. */
export const ticksPerFrame = (r: Rational): number => (TICKS_PER_SECOND * r.den) / r.num;
export const frameToTicks = (frame: number, r: Rational): number => Math.round(frame * ticksPerFrame(r));
export const ticksToFrame = (ticks: number, r: Rational): number => Math.round(ticks / ticksPerFrame(r));
export const relativeTicks = (clip: Pick<Clip, "start">, frame: number, r: Rational): number => frameToTicks(frame, r) - clip.start;

/** What one inspector field animates: scale moves both axes together (the field is uniform). */
export const PROPS_OF: Readonly<Record<string, readonly TransformProp[]>> = {
  position_x: ["position_x"],
  position_y: ["position_y"],
  scale_x: ["scale_x", "scale_y"],
  rotation: ["rotation"],
  opacity: ["opacity"],
  crop_left: ["crop_left"],
  crop_top: ["crop_top"],
  crop_right: ["crop_right"],
  crop_bottom: ["crop_bottom"],
};

/**
 * "Add keyframe at playhead" from the keyboard (the opacity diamond's edit, `docs/features/keyframes.md`): a key holding the value now, or the key
 * already at the playhead removed. Null when the playhead is outside the clip (the diamond is disabled there too).
 */
export function opacityKeyOps(clip: Clip, rate: Rational, playhead: number): Op[] | null {
  const rel = relativeTicks(clip, playhead, rate);
  if (rel < 0 || rel >= clip.duration) return null;
  return toggleKeyOps(clip.id, clip.transform, PROPS_OF.opacity!, rel, ticksPerFrame(rate) / 2, 1);
}

/** Ops that set the key at `t` to `value` on every prop; an existing key keeps its easing, a new one is linear. */
export function setKeyOps(clip: string, tr: ClipTransform | undefined, props: readonly TransformProp[], t: number, value: number, tol = 0): Op[] {
  return props.map((prop) => {
    const near = keyNear(tr?.[prop], t, tol);
    return { op: "set_keyframe", clip, prop, key: { t: near?.t ?? t, v: value, easing: near?.easing ?? LINEAR } };
  });
}

/**
 * The edit for the diamond: adds a key holding the value at `rel`, or removes the key near it. Removing a property's last key makes it
 * static at that key's value (one `set_clip_transform`), so the picture does not jump back to a stale static value.
 */
export function toggleKeyOps(clip: string, tr: ClipTransform | undefined, props: readonly TransformProp[], rel: number, tol: number, fallback: number): Op[] {
  const first = tr?.[props[0]!];
  const near = keyNear(first, rel, tol);
  if (!near) {
    return props.map((prop) => ({ op: "set_keyframe", clip, prop, key: { t: rel, v: evalAnimated(tr?.[prop], prop.startsWith("scale") ? 1 : fallback, rel), easing: LINEAR } }));
  }
  const lastKey = keysOf(first).length === 1;
  if (!lastKey) return props.map((prop) => ({ op: "delete_keyframe", clip, prop, t: keyNear(tr?.[prop], rel, tol)?.t ?? near.t }));
  const next: ClipTransform = { ...(tr ?? {}) };
  for (const prop of props) next[prop] = { value: keysOf(tr?.[prop])[0]?.v ?? near.v };
  return [{ op: "set_clip_transform", clip, transform: next }];
}

export function easingOps(clip: string, tr: ClipTransform | undefined, props: readonly TransformProp[], rel: number, tol: number, easing: Easing): Op[] {
  return props.flatMap((prop) => {
    const k = keyNear(tr?.[prop], rel, tol);
    return k ? [{ op: "set_easing" as const, clip, prop, t: k.t, easing }] : [];
  });
}

/** Absolute timeline times (ticks) of every key of every property of the clip, ascending and unique: what the timeline draws as diamonds. */
export function clipKeyTimes(clip: Pick<Clip, "start" | "duration" | "transform">): number[] {
  const out = new Set<number>();
  const tr = clip.transform;
  if (!tr) return [];
  for (const prop of Object.keys(PROPS_OF) as (keyof typeof PROPS_OF)[]) {
    for (const k of keysOf(tr[prop as TransformProp])) if (k.t >= 0 && k.t <= clip.duration) out.add(clip.start + k.t);
  }
  const ys = tr.scale_y;
  for (const k of keysOf(ys)) if (k.t >= 0 && k.t <= clip.duration) out.add(clip.start + k.t);
  return [...out].sort((a, b) => a - b);
}
