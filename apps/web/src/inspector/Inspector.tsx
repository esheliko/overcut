import { useRef, useState, type PointerEvent, type ReactNode } from "react";
import type { Clip, ClipTransform, Fit, Op, Project } from "@app/engine-client";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { useProjectStore, useStore } from "../store/projectStore";
import { isIdentity, newGestureKey, setField, setFit, toggleFlip, valuesOf, RESET, rangeOf, type NumKey } from "./transformModel";
import { EASING_CHOICES, PROPS_OF, easingId, easingOps, keyNear, keyState, neighbourKey, relativeTicks, setKeyOps, ticksPerFrame, ticksToFrame, toggleKeyOps, type EasingId } from "./keyframeModel";
import { canvasSummary } from "../canvas";
import { clipCount, timelineEnd } from "../media/plan";
import { TICKS_PER_SECOND, timecodeHMS } from "../preview/timing";
import "./inspector.css";

/** The one selected video clip, or null (nothing, several, or an audio clip). */
export function selectedVideoClip(project: Project | null, selection: ReadonlySet<string>): Clip | null {
  if (!project || selection.size === 0) return null;
  const seq = project.sequences[0];
  if (!seq) return null;
  let found: Clip | null = null;
  for (const tr of seq.tracks) {
    if (tr.kind !== "video") continue;
    for (const c of tr.clips) {
      if (!selection.has(c.id)) continue;
      if (found) return null;
      found = c;
    }
  }
  return found;
}

/**
 * Sends the edit of a whole transform for `clip` (`set_clip_transform`); edits that share a `key` are one undo step. A number that changed
 * on an animated property is not written as its static value but as a keyframe at the playhead (so a handle drag or field edit on an
 * animated clip updates the key there, M2-004).
 */
export function useTransformEdit() {
  const store = useStore();
  const { t } = useI18n();
  return (clip: string, next: ClipTransform, key?: number) => {
    const s = store.getState();
    const c = selectedVideoClip(s.project, new Set([clip]));
    const rate = s.project?.sequences[0]?.frame_rate;
    const cur = c?.transform;
    const animated = c && rate && cur ? NUM_KEYS.filter((k) => cur[k]?.keys?.length && next[k]?.value !== cur[k]?.value) : [];
    if (!c || !rate || animated.length === 0) return void store.apply({ op: "set_clip_transform", clip, transform: next }, key, t("inspector.undoLabel"));
    const rel = relativeTicks(c, s.playhead, rate);
    const keyed: ClipTransform = { ...next };
    const ops: Op[] = [];
    for (const k of animated) {
      keyed[k] = cur![k];
      ops.push(...setKeyOps(clip, cur, [k], rel, next[k]!.value, ticksPerFrame(rate) / 2));
    }
    const rest = JSON.stringify(keyed) !== JSON.stringify(cur);
    void store.apply(rest ? [{ op: "set_clip_transform", clip, transform: keyed }, ...ops] : ops, key, t("inspector.undoLabel"));
  };
}

const NUM_KEYS: NumKey[] = ["position_x", "position_y", "scale_x", "scale_y", "rotation", "opacity", "crop_left", "crop_top", "crop_right", "crop_bottom"];
const PCT = 100;
interface FieldDef { key: NumKey; label: string; unit: "%" | "°"; mul: number; step: number }
const FIELDS: FieldDef[] = [
  { key: "position_x", label: "inspector.x", unit: "%", mul: PCT, step: 1 },
  { key: "position_y", label: "inspector.y", unit: "%", mul: PCT, step: 1 },
  { key: "scale_x", label: "inspector.scale", unit: "%", mul: PCT, step: 5 },
  { key: "rotation", label: "inspector.rotation", unit: "°", mul: 1, step: 1 },
  { key: "opacity", label: "inspector.opacity", unit: "%", mul: PCT, step: 5 },
];
const CROPS: FieldDef[] = [
  { key: "crop_left", label: "inspector.cropLeft", unit: "%", mul: PCT, step: 1 },
  { key: "crop_top", label: "inspector.cropTop", unit: "%", mul: PCT, step: 1 },
  { key: "crop_right", label: "inspector.cropRight", unit: "%", mul: PCT, step: 1 },
  { key: "crop_bottom", label: "inspector.cropBottom", unit: "%", mul: PCT, step: 1 },
];
const FITS: Fit[] = ["contain", "cover", "stretch"];

/** One diamond outline / filled; `state` decides which (the colour and the aria state say the same in words). */
function Diamond({ filled }: { filled: boolean }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path d="M12 3 21 12 12 21 3 12Z" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

/** Transform of the selected clip: numeric fields with keyframe controls, then crop / flip / fit, reset. Every field editing session (focus to blur) is one undo step. */
export function Inspector(): ReactNode {
  const { t } = useI18n();
  const project = useProjectStore((s) => s.project);
  const selection = useProjectStore((s) => s.selection);
  const clip = selectedVideoClip(project, selection);
  if (!clip || !project) return <><p className="insp-empty">{t("inspector.none")}</p>{project && <ProjectInfo project={project} />}</>;
  return <InspectorFields clip={clip} rate={project.sequences[0]!.frame_rate} />;
}

/** Nothing selected: what the project is, so the Details panel is never an empty column. */
function ProjectInfo({ project }: { project: Project }) {
  const { t } = useI18n();
  const seq = project.sequences[0];
  if (!seq) return null;
  const frames = Math.round((timelineEnd(project) * seq.frame_rate.num) / (TICKS_PER_SECOND * seq.frame_rate.den));
  return (
    <dl className="insp-info" data-testid="insp-project-info">
      <div><dt>{t("inspector.info.canvas")}</dt><dd>{canvasSummary(seq.resolution, seq.frame_rate)}</dd></div>
      <div><dt>{t("inspector.info.background")}</dt><dd data-testid="insp-background">{t(`canvas.bg.${seq.background?.mode ?? "black"}`)}</dd></div>
      <div><dt>{t("inspector.info.length")}</dt><dd>{timecodeHMS(frames, seq.frame_rate)}</dd></div>
      <div><dt>{t("inspector.info.clips")}</dt><dd>{clipCount(project)}</dd></div>
    </dl>
  );
}

/** The fields. Only this part follows the playhead, and only as the clip-relative time clamped to just outside the clip: while the playhead is elsewhere nothing here re-renders. */
function InspectorFields({ clip, rate }: { clip: NonNullable<ReturnType<typeof selectedVideoClip>>; rate: Project["sequences"][number]["frame_rate"] }): ReactNode {
  const { t } = useI18n();
  const store = useStore();
  const readOnly = useProjectStore((s) => s.readOnly);
  const pad = 2 * ticksPerFrame(rate); // two frames of margin keep the "on a key" tolerance exact next to the clip
  // Follows the playhead frame by frame only when a property is animated (its value, key state and neighbours change with time). Otherwise the fields only
  // need "is the playhead on the clip", so the selector answers 0 / -1 and the form stays put during playback (a key click reads the exact time itself).
  const animated = Object.values(PROPS_OF).flat().some((p) => clip.transform?.[p]?.keys?.length);
  const rel = useProjectStore((s) => {
    const r = relativeTicks(clip, s.playhead, rate);
    return animated ? Math.min(clip.duration + pad, Math.max(-pad, r)) : r >= 0 && r < clip.duration ? 0 : -1;
  });
  const edit = useTransformEdit();
  const key = useRef<number | undefined>(undefined);
  const drag = useRef<{ x: number; v: number; moved: boolean } | null>(null); // a label drag-scrub in progress
  const [clamped, setClamped] = useState<{ key: NumKey; text: string } | null>(null); // F-01: the field a typed number was limited on, and why
  const tr = clip.transform;
  const tol = ticksPerFrame(rate) / 2;
  const onClip = rel >= 0 && rel < clip.duration;
  const v = valuesOf(tr, rel);
  const goToClip = () => store.setPlayhead(Math.max(0, ticksToFrame(clip.start, rate)));
  const gesture = () => key.current ?? (key.current = newGestureKey());
  const label = t("inspector.undoLabel");
  const set = (f: FieldDef, value: number) => {
    const props = PROPS_OF[f.key]!;
    if (tr?.[props[0]!]?.keys?.length) {
      // An animated property: the edit sets (or updates) the key at the playhead.
      const [lo, hi] = rangeOf(f.key, v);
      const clamped = Math.min(hi, Math.max(lo, value));
      void store.apply(setKeyOps(clip.id, tr, props, rel, clamped, tol), gesture(), label);
      return;
    }
    // Scale is uniform here: both axes move together (the handles also scale uniformly).
    let next = setField(tr, f.key, value);
    if (f.key === "scale_x") next = setField(next, "scale_y", value);
    edit(clip.id, next, gesture());
  };
  const step = (f: FieldDef, dir: -1 | 1) => {
    const to = neighbourKey(tr?.[PROPS_OF[f.key]![0]!], rel, tol, dir);
    if (to !== undefined) store.setPlayhead(Math.max(0, ticksToFrame(clip.start + to, rate)));
  };
  const field = (f: FieldDef) => {
    const props = PROPS_OF[f.key]!;
    const anim = tr?.[props[0]!];
    const state = keyState(anim, rel, tol);
    const near = keyNear(anim, rel, tol);
    const [lo, hi] = rangeOf(f.key, v);
    const name = t(f.label);
    const shown = Math.round(v[f.key] * f.mul * 100) / 100;
    const atDefault = Math.abs(v[f.key] - DEFAULT_OF[f.key]) < 1e-9;
    // Typing past the range limits the value; say so next to the field (live region) instead of silently changing the number.
    const typed = (raw: number) => {
      const [a, b] = [lo * f.mul, hi * f.mul];
      setClamped(raw > b ? { key: f.key, text: t("inspector.clamp.max", { value: String(b), unit: f.unit }) } : raw < a ? { key: f.key, text: t("inspector.clamp.min", { value: String(a), unit: f.unit }) } : null);
      set(f, raw / f.mul);
    };
    // Drag the label sideways to scrub the value: 4 px = one step, Shift x10, Alt x0.1. One drag is one undo step.
    const scrub = {
      onPointerDown: (e: PointerEvent<HTMLSpanElement>) => {
        if (readOnly || e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, v: shown, moved: false };
        key.current = newGestureKey();
      },
      onPointerMove: (e: PointerEvent<HTMLSpanElement>) => {
        const d = drag.current;
        if (!d || !e.currentTarget.hasPointerCapture(e.pointerId) || (!d.moved && Math.abs(e.clientX - d.x) < 3)) return;
        d.moved = true;
        const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
        typed(Math.round((d.v + ((e.clientX - d.x) / 4) * f.step * mult) * 100) / 100);
      },
      onPointerUp: () => { if (drag.current) key.current = undefined; },
      onClick: (e: React.MouseEvent) => { if (drag.current?.moved) e.preventDefault(); drag.current = null; }, // a drag is not a click: do not focus the field
    };
    return (
      <div key={f.key} className="insp-field" data-keystate={state}>
        <label className="insp-fl">
          <span className="insp-name" {...scrub}>{name}</span>
          <input
            type="number"
            inputMode="decimal"
            disabled={readOnly}
            data-testid={`insp-${f.key}`}
            step={f.step}
            min={lo * f.mul}
            max={hi * f.mul}
            value={shown}
            onFocus={() => (key.current = newGestureKey())}
            onBlur={() => { key.current = undefined; setClamped(null); }}
            onChange={(e) => e.currentTarget.value !== "" && typed(Number(e.currentTarget.value))}
          />
          <em>{f.unit}</em>
        </label>
        <button
          type="button"
          className="insp-kbtn insp-fieldreset"
          data-testid={`insp-resetfield-${f.key}`}
          aria-label={t("inspector.resetField", { name })}
          title={t("inspector.resetField", { name })}
          style={atDefault ? { visibility: "hidden" } : undefined}
          tabIndex={atDefault ? -1 : 0}
          disabled={readOnly || atDefault}
          onClick={() => { setClamped(null); set(f, DEFAULT_OF[f.key]); }}
        >
          <Icon name="reset" size={16} />
        </button>
        <button
          type="button"
          className="insp-kbtn insp-diamond"
          data-testid={`insp-key-${f.key}`}
          aria-pressed={state === "on"}
          aria-label={t(state === "on" ? "inspector.removeKey" : "inspector.addKey", { name })}
          disabled={readOnly || !onClip}
          onClick={() => void store.apply(toggleKeyOps(clip.id, tr, props, relativeTicks(clip, store.getState().playhead, rate), tol, DEFAULT_OF[f.key]), undefined, label)}
        >
          <Diamond filled={state === "on"} />
        </button>
        <span className="insp-note" role="status" aria-live="polite" data-testid={`insp-note-${f.key}`}>{clamped?.key === f.key ? clamped.text : ""}</span>
        {state !== "none" && (
          <div className="insp-sub">
            <button type="button" className="insp-kbtn" data-testid={`insp-prevkey-${f.key}`} aria-label={t("inspector.prevKey", { name })} disabled={neighbourKey(anim, rel, tol, -1) === undefined} onClick={() => step(f, -1)}><Icon name="chevronLeft" size={18} /></button>
            {near ? (
              <select
                className="insp-ease"
                aria-label={t("inspector.easing")}
                data-testid={`insp-ease-${f.key}`}
                disabled={readOnly}
                value={easingId(near.easing)}
                onChange={(e) => {
                  const pick = EASING_CHOICES.find((c) => c.id === e.currentTarget.value);
                  if (pick) void store.apply(easingOps(clip.id, tr, props, rel, tol, pick.easing), undefined, t("inspector.easingLabel"));
                }}
              >
                {easingId(near.easing) === "custom" && <option value="custom">{t("inspector.ease.custom")}</option>}
                {EASING_CHOICES.map((c) => <option key={c.id} value={c.id}>{t(`inspector.ease.${c.id}` as `inspector.ease.${EasingId}`)}</option>)}
              </select>
            ) : (
              <span className="insp-between">{t("inspector.betweenKeys")}</span>
            )}
            <button type="button" className="insp-kbtn" data-testid={`insp-nextkey-${f.key}`} aria-label={t("inspector.nextKey", { name })} disabled={neighbourKey(anim, rel, tol, 1) === undefined} onClick={() => step(f, 1)}><Icon name="chevronRight" size={18} /></button>
          </div>
        )}
      </div>
    );
  };
  return (
    <div className="insp" data-testid="inspector-fields" data-anim={[...FIELDS, ...CROPS].some((f) => tr?.[PROPS_OF[f.key]![0]!]?.keys?.length) || undefined}>
      {!onClip && (
        <div className="insp-hint" data-testid="insp-offclip">
          <p>{t("inspector.offClip")}</p>
          <button type="button" onClick={goToClip} data-testid="insp-goto-clip">{t("inspector.goToClip")}</button>
        </div>
      )}
      {FIELDS.map(field)}
      <details className="insp-more">
        <summary data-testid="insp-more">{t("inspector.more")}</summary>
        <div className="insp-more-body">
          {CROPS.map(field)}
          <div className="insp-row" role="group" aria-label={t("inspector.fit")}>
            {FITS.map((f) => (
              <button key={f} aria-pressed={(tr?.fit ?? "contain") === f} disabled={readOnly} onClick={() => edit(clip.id, setFit(tr, f))} data-testid={`insp-fit-${f}`}>{t(`inspector.fit.${f}`)}</button>
            ))}
          </div>
          <div className="insp-row">
            <button aria-pressed={!!tr?.flip_h} disabled={readOnly} onClick={() => edit(clip.id, toggleFlip(tr, "h"))} data-testid="insp-flip-h">{t("inspector.flipH")}</button>
            <button aria-pressed={!!tr?.flip_v} disabled={readOnly} onClick={() => edit(clip.id, toggleFlip(tr, "v"))} data-testid="insp-flip-v">{t("inspector.flipV")}</button>
          </div>
        </div>
      </details>
      <div className="insp-row">
        <button disabled={readOnly || isIdentity(tr)} onClick={() => edit(clip.id, RESET)} data-testid="insp-reset">{t("inspector.reset")}</button>
      </div>
    </div>
  );
}

const DEFAULT_OF: Record<NumKey, number> = { position_x: 0, position_y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1, crop_left: 0, crop_top: 0, crop_right: 0, crop_bottom: 0 };
