import { useEffect, useId, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import type { Clip, ClipTransform, Fit, Op, Project } from "@app/engine-client";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { useProjectStore, useStore } from "../store/projectStore";
import { isIdentity, newGestureKey, setField, setFit, toggleFlip, valuesOf, RESET, rangeOf, type NumKey } from "./transformModel";
import { SpeedSection } from "./Speed";
import { speedTarget } from "./speedModel";
import { EASING_CHOICES, PROPS_OF, TRANSFORM_GROUP, easingId, easingOps, groupKeyOps, keyNear, keyState, neighbourKey, relativeTicks, setKeyOps, ticksPerFrame, ticksToFrame, toggleKeyOps, type EasingId } from "./keyframeModel";
import { withKey } from "../commands/keymap";
import { canvasSummary } from "../canvas";
import { clipCount, timelineEnd } from "../media/plan";
import { TICKS_PER_SECOND, timecodeHMS } from "../preview/timing";
import "./inspector.css";

/** The one selected video clip, or null (nothing, several, or an audio clip). */
/** The diamond's tooltip; opacity's also names the keyboard command (`clip.keyframeAtPlayhead`). */
const diamondTitle = (field: string, text: string): string => (field === "opacity" ? withKey(text, "clip.keyframeAtPlayhead") : text);

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
/** `smin`/`smax`: the slider's everyday range in display units (the number field still accepts the whole engine range). */
interface FieldDef { key: NumKey; label: string; unit: "%" | "°"; mul: number; step: number; smin: number; smax: number }
const FIELDS: FieldDef[] = [
  { key: "position_x", label: "inspector.x", unit: "%", mul: PCT, step: 1, smin: -100, smax: 100 },
  { key: "position_y", label: "inspector.y", unit: "%", mul: PCT, step: 1, smin: -100, smax: 100 },
  { key: "scale_x", label: "inspector.scale", unit: "%", mul: PCT, step: 5, smin: 1, smax: 400 },
  { key: "rotation", label: "inspector.rotation", unit: "°", mul: 1, step: 1, smin: -180, smax: 180 },
  { key: "opacity", label: "inspector.opacity", unit: "%", mul: PCT, step: 5, smin: 0, smax: 100 },
];
const CROPS: FieldDef[] = [
  { key: "crop_left", label: "inspector.cropLeft", unit: "%", mul: PCT, step: 1, smin: 0, smax: 95 },
  { key: "crop_top", label: "inspector.cropTop", unit: "%", mul: PCT, step: 1, smin: 0, smax: 95 },
  { key: "crop_right", label: "inspector.cropRight", unit: "%", mul: PCT, step: 1, smin: 0, smax: 95 },
  { key: "crop_bottom", label: "inspector.cropBottom", unit: "%", mul: PCT, step: 1, smin: 0, smax: 95 },
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

/** Details of the selected clip: collapsible sections (Transform, Opacity, Crop & flip, Speed), each value a slider plus a scrubbable number with its keyframe diamond. Every field editing session (focus to blur, or one slider drag) is one undo step. */
export function Inspector(): ReactNode {
  const { t } = useI18n();
  const project = useProjectStore((s) => s.project);
  const selection = useProjectStore((s) => s.selection);
  const clip = selectedVideoClip(project, selection);
  if (clip && project) return <InspectorFields clip={clip} rate={project.sequences[0]!.frame_rate} />;
  const picked = selection.size === 0 || !project ? [] : project.sequences[0]?.tracks.flatMap((tr) => tr.clips.filter((c) => selection.has(c.id)).map((c) => ({ c, kind: tr.kind }))) ?? [];
  if (picked.length > 1) {
    const all = new Set(picked.map((p) => p.kind));
    const state = all.size === 1 && all.has("audio") ? "audio" : "multi";
    return <EmptyCard testId="insp-multi" icon="duplicate" title={t("inspector.multi", { count: picked.length })} text={t(state === "audio" ? "inspector.multiAudio" : "inspector.multiHint")} />;
  }
  if (picked.length === 1) return <EmptyCard testId="insp-audio" icon="audio" title={t("inspector.audio")} text={t("inspector.audioHint")} />;
  return <>{project ? <ProjectInfo project={project} /> : <p className="insp-empty">{t("inspector.none")}</p>}</>;
}

function EmptyCard({ icon, title, text, testId }: { icon: "duplicate" | "audio"; title: string; text: string; testId: string }): ReactNode {
  return (
    <div className="insp-state" data-testid={testId}>
      <span className="insp-state-ic" aria-hidden="true"><Icon name={icon} size={22} /></span>
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  );
}

/** Opens the canvas dialog (size, frame rate, background) that the preview's ratio chip opens; App listens. */
export const CANVAS_EVENT = "overcut:open-canvas";
const openCanvas = (): void => { window.dispatchEvent(new Event(CANVAS_EVENT)); };

/** Nothing selected: what the project is, so the Details panel is never an empty column. */
function ProjectInfo({ project }: { project: Project }) {
  const { t } = useI18n();
  const seq = project.sequences[0];
  if (!seq) return null;
  const frames = Math.round((timelineEnd(project) * seq.frame_rate.num) / (TICKS_PER_SECOND * seq.frame_rate.den));
  return (
    <>
    {/* r15 (customer: "why is it there if I can't change anything"): say what selecting does, and let the project rows that CAN change open their editor. */}
    <div className="insp-pick insp-nothing" data-testid="insp-nothing">
      <strong>{t(clipCount(project) === 0 ? "inspector.noneEmpty.title" : "inspector.none.title")}</strong>
      <p className="insp-empty">{t(clipCount(project) === 0 ? "inspector.noneEmpty" : "inspector.none")}</p>
    </div>
    <dl className="insp-info" data-testid="insp-project-info">
      <div><dt>{t("inspector.info.canvas")}</dt><dd><button type="button" className="insp-info-edit" onClick={openCanvas} data-testid="insp-canvas-edit">{canvasSummary(seq.resolution, seq.frame_rate)}<Icon name="chevronRight" size={14} /></button></dd></div>
      <div><dt>{t("inspector.info.background")}</dt><dd data-testid="insp-background"><button type="button" className="insp-info-edit" onClick={openCanvas}>{t(`canvas.bg.${seq.background?.mode ?? "black"}`)}<Icon name="chevronRight" size={14} /></button></dd></div>
      <div><dt>{t("inspector.info.length")}</dt><dd>{timecodeHMS(frames, seq.frame_rate)}</dd></div>
      <div><dt>{t("inspector.info.clips")}</dt><dd>{clipCount(project)}</dd></div>
    </dl>
    </>
  );
}

/** The fields. Only this part follows the playhead, and only as the clip-relative time clamped to just outside the clip: while the playhead is elsewhere nothing here re-renders. */
function InspectorFields({ clip, rate }: { clip: NonNullable<ReturnType<typeof selectedVideoClip>>; rate: Project["sequences"][number]["frame_rate"] }): ReactNode {
  const { t } = useI18n();
  const store = useStore();
  const readOnly = useProjectStore((s) => s.readOnly);
  const project = useProjectStore((s) => s.project);
  const selection = useProjectStore((s) => s.selection);
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
  const drag = useRef<{ x: number; v: number; moved: boolean; off(): void } | null>(null); // a drag-scrub in progress (`off` removes its Escape listener)
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
    // Drag the label OR the number sideways to scrub the value: 4 px = one step, Shift x10, Alt x0.1, Escape puts the old value back. One drag is one undo step.
    // On the number the drag only starts while the field is not being typed in (a focused field keeps its caret and text selection); a plain click still focuses it.
    const cancel = () => {
      const d = drag.current;
      if (!d) return;
      d.off();
      if (d.moved) typed(d.v);
      key.current = undefined;
      drag.current = null;
    };
    const scrub = (onNumber: boolean) => ({
      onPointerDown: (e: PointerEvent<HTMLElement>) => {
        if (readOnly || e.button !== 0 || (onNumber && document.activeElement === e.currentTarget)) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const esc = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); cancel(); } };
        window.addEventListener("keydown", esc, true);
        drag.current = { x: e.clientX, v: shown, moved: false, off: () => window.removeEventListener("keydown", esc, true) };
        key.current = newGestureKey();
      },
      onPointerMove: (e: PointerEvent<HTMLElement>) => {
        const d = drag.current;
        if (!d || !e.currentTarget.hasPointerCapture(e.pointerId) || (!d.moved && Math.abs(e.clientX - d.x) < 3)) return;
        d.moved = true;
        const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
        typed(Math.round((d.v + ((e.clientX - d.x) / 4) * f.step * mult) * 100) / 100);
      },
      onPointerUp: (e: PointerEvent<HTMLElement>) => {
        const d = drag.current;
        if (!d) return;
        d.off();
        key.current = undefined;
        if (onNumber && !d.moved) { drag.current = null; e.currentTarget.focus(); (e.currentTarget as HTMLInputElement).select(); } // a tap: type a value
      },
      onPointerCancel: cancel,
      onLostPointerCapture: () => { if (drag.current && !drag.current.moved) { drag.current.off(); drag.current = null; } },
      onClick: (e: React.MouseEvent) => { if (drag.current?.moved) e.preventDefault(); drag.current = null; }, // a drag is not a click: do not focus the field
    });
    return (
      <div key={f.key} className="insp-field" data-keystate={state}>
        <label className="insp-fl">
          <span className="insp-name" {...scrub(false)}>{name}</span>
          <input
            type="number"
            inputMode="decimal"
            disabled={readOnly}
            data-testid={`insp-${f.key}`}
            step={f.step}
            min={lo * f.mul}
            max={hi * f.mul}
            value={shown}
            {...scrub(true)}
            onMouseDown={(e) => { if (document.activeElement !== e.currentTarget) e.preventDefault(); }} // no caret flash before we know whether this is a tap or a scrub
            onKeyDown={(e) => {
              // Arrows nudge by the step; Shift x10, Alt x0.1 (the browser's own stepping ignores both).
              if ((e.key === "ArrowUp" || e.key === "ArrowDown") && (e.shiftKey || e.altKey)) {
                e.preventDefault();
                const dir = e.key === "ArrowUp" ? 1 : -1;
                typed(Math.round((Number(e.currentTarget.value) + dir * f.step * (e.shiftKey ? 10 : 0.1)) * 100) / 100);
              }
            }}
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
          title={diamondTitle(f.key, t(state === "on" ? "inspector.removeKey" : "inspector.addKey", { name }))}
          disabled={readOnly || !onClip}
          onClick={() => void store.apply(toggleKeyOps(clip.id, tr, props, relativeTicks(clip, store.getState().playhead, rate), tol, DEFAULT_OF[f.key]), undefined, label)}
        >
          <Diamond filled={state === "on"} />
        </button>
        <input
          type="range"
          className="insp-slider"
          data-testid={`insp-slider-${f.key}`}
          aria-label={name}
          disabled={readOnly}
          min={f.smin}
          max={f.smax}
          step={f.step >= 5 ? 1 : f.step}
          value={Math.min(f.smax, Math.max(f.smin, shown))}
          style={{ "--p": `${((Math.min(f.smax, Math.max(f.smin, shown)) - f.smin) / (f.smax - f.smin)) * 100}%`, "--z": `${((0 - f.smin) / (f.smax - f.smin)) * 100}%` } as CSSProperties}
          // One drag (or one key press) is one undo step: edits share a gesture key from press to release.
          onPointerDown={() => { key.current = newGestureKey(); }}
          onPointerUp={() => { key.current = undefined; }}
          onPointerCancel={() => { key.current = undefined; }}
          onKeyDown={() => { key.current = newGestureKey(); }}
          onKeyUp={() => { key.current = undefined; }}
          onBlur={() => { key.current = undefined; setClamped(null); }}
          onChange={(e) => typed(Number(e.currentTarget.value))}
        />
        <span className="insp-note" role="status" aria-live="polite" data-testid={`insp-note-${f.key}`}>{clamped?.key === f.key ? clamped.text : ""}</span>
        {state !== "none" && (
          <div className="insp-sub">
            <button type="button" className="insp-kbtn" data-testid={`insp-prevkey-${f.key}`} aria-label={t("inspector.prevKey", { name })} title={t("inspector.prevKey", { name })} disabled={neighbourKey(anim, rel, tol, -1) === undefined} onClick={() => step(f, -1)}><Icon name="chevronLeft" size={18} /></button>
            {near ? (
              <EasingMenu
                testId={`insp-ease-${f.key}`}
                value={easingId(near.easing)}
                disabled={readOnly}
                onPick={(pick) => void store.apply(easingOps(clip.id, tr, props, rel, tol, pick), undefined, t("inspector.easingLabel"))}
              />
            ) : (
              <span className="insp-between">{t("inspector.betweenKeys")}</span>
            )}
            <button type="button" className="insp-kbtn" data-testid={`insp-nextkey-${f.key}`} aria-label={t("inspector.nextKey", { name })} title={t("inspector.nextKey", { name })} disabled={neighbourKey(anim, rel, tol, 1) === undefined} onClick={() => step(f, 1)}><Icon name="chevronRight" size={18} /></button>
          </div>
        )}
      </div>
    );
  };
  const byKey = (k: NumKey) => FIELDS.find((f) => f.key === k) ?? CROPS.find((f) => f.key === k)!;
  const atDef = (keys: NumKey[]) => keys.every((k) => Math.abs(v[k] - DEFAULT_OF[k]) < 1e-9);
  const resetKeys = (keys: NumKey[], extra?: Partial<ClipTransform>) => {
    let n: ClipTransform = tr ?? {};
    for (const k of keys) n = setField(n, k, DEFAULT_OF[k]);
    if (keys.includes("scale_x")) n = setField(n, "scale_y", 1);
    setClamped(null);
    edit(clip.id, { ...n, ...extra });
  };
  const animatedAny = [...FIELDS, ...CROPS].some((f) => tr?.[PROPS_OF[f.key]![0]!]?.keys?.length);
  const cropKeys = CROPS.map((f) => f.key);
  const TRANSFORM_KEYS: NumKey[] = ["position_x", "position_y", "scale_x", "rotation", "opacity"];
  const groupOn = TRANSFORM_GROUP.every((p) => keyNear(tr?.[p], rel, tol));
  const speed = speedTarget(project, selection);
  return (
    <div className="insp insp-sections" data-testid="inspector-fields" data-anim={animatedAny || undefined}>
      {!onClip && (
        <div className="insp-hint" data-testid="insp-offclip">
          <span>{t("inspector.offClip")}</span>
          <button type="button" onClick={goToClip} data-testid="insp-goto-clip">{t("inspector.goToClip")}</button>
        </div>
      )}
      <Section
        id="transform"
        title={t("inspector.sec.transform")}
        onReset={() => resetKeys(TRANSFORM_KEYS)}
        resetOff={readOnly || atDef(TRANSFORM_KEYS)}
        extra={
          <button
            type="button"
            className="insp-kbtn insp-sec-key"
            data-testid="insp-key-transform"
            aria-pressed={groupOn}
            aria-label={t(groupOn ? "inspector.removeGroupKey" : "inspector.addGroupKey")}
            title={t(groupOn ? "inspector.removeGroupKey" : "inspector.addGroupKey")}
            disabled={readOnly || !onClip}
            onClick={() => void store.apply(groupKeyOps(clip.id, tr, TRANSFORM_GROUP, relativeTicks(clip, store.getState().playhead, rate), tol), undefined, label)}
          >
            <Diamond filled={groupOn} />
          </button>
        }
      >
        {TRANSFORM_KEYS.map((k) => field(byKey(k)))}
      </Section>
      <Section id="crop" title={t("inspector.more")} testId="insp-more" startClosed onReset={() => resetKeys(cropKeys, { fit: "contain", flip_h: false, flip_v: false })} resetOff={readOnly || (atDef(cropKeys) && !tr?.flip_h && !tr?.flip_v && (tr?.fit ?? "contain") === "contain")}>
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
      </Section>
      {speed && !speed.still && (
        <Section id="speed" title={t("details.tab.speed")} startClosed>
          <SpeedSection />
        </Section>
      )}
      <div className="insp-row">
        <button disabled={readOnly || isIdentity(tr)} onClick={() => edit(clip.id, RESET)} data-testid="insp-reset">{t("inspector.reset")}</button>
      </div>
    </div>
  );
}

// Which sections the person opened or closed, kept while the selection changes (module state: the panel remounts on every new selection).
const openState = new Map<string, boolean>();

/** A collapsible group of values: a sticky header (title, optional reset, chevron) over its fields. Closed sections are not rendered, so they cost nothing. */
function Section({ id, title, testId, startClosed, onReset, resetOff, extra, children }: { id: string; title: string; testId?: string; startClosed?: boolean; onReset?: () => void; resetOff?: boolean; extra?: ReactNode; children: ReactNode }): ReactNode {
  const { t } = useI18n();
  const [open, setOpenState] = useState(() => openState.get(id) ?? !startClosed);
  const body = useId();
  const toggle = () => setOpenState((o) => { openState.set(id, !o); return !o; });
  return (
    <section className="insp-sec" data-open={open} data-testid={`insp-sec-${id}`}>
      <header className="insp-sec-h">
        <button type="button" className="insp-sec-t" aria-expanded={open} aria-controls={body} data-testid={testId} onClick={toggle}>
          <Icon name="chevronDown" size={16} />
          <span>{title}</span>
        </button>
        {extra}
        {onReset && (
          <button type="button" className="insp-kbtn insp-sec-reset" data-testid={`insp-secreset-${id}`} aria-label={t("inspector.sec.reset", { name: title })} title={t("inspector.sec.reset", { name: title })} disabled={resetOff} onClick={onReset}>
            <Icon name="reset" size={16} />
          </button>
        )}
      </header>
      {open && <div id={body} className="insp-sec-b">{children}</div>}
    </section>
  );
}

const DEFAULT_OF: Record<NumKey, number> = { position_x: 0, position_y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1, crop_left: 0, crop_top: 0, crop_right: 0, crop_bottom: 0 };

/** Curve glyphs (20x20) for the easing choices: what the motion between two keys looks like. */
const CURVES: Record<EasingId, string> = {
  linear: "M3 17 17 3",
  "ease-in": "M3 17C8.9 17 17 17 17 3",
  "ease-out": "M3 17C3 3 11.1 3 17 3",
  "ease-in-out": "M3 17C8.9 17 11.1 3 17 3",
  hold: "M3 17H10V3H17",
  custom: "M3 17C6 5 10 19 17 3",
};
function Curve({ id }: { id: EasingId }): ReactNode {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
      <path d={CURVES[id]} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The easing of the key at the playhead: one button showing the curve and its name; it opens a row of curve choices (not a native select). */
function EasingMenu({ value, disabled, onPick, testId }: { value: EasingId; disabled: boolean; onPick: (e: (typeof EASING_CHOICES)[number]["easing"]) => void; testId: string }): ReactNode {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", esc, true);
    return () => { document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", esc, true); };
  }, [open]);
  const name = (id: EasingId) => t(`inspector.ease.${id}` as `inspector.ease.${EasingId}`);
  return (
    <div className="insp-ease" ref={root}>
      <button type="button" className="insp-ease-btn" data-testid={testId} data-value={value} aria-haspopup="menu" aria-expanded={open} aria-label={`${t("inspector.easing")}: ${name(value)}`} disabled={disabled} onClick={() => setOpen((o) => !o)}>
        <Curve id={value} />
        <span>{name(value)}</span>
        <Icon name="chevronDown" size={14} />
      </button>
      {open && (
        <div className="insp-ease-pop" role="menu" aria-label={t("inspector.easing")}>
          {EASING_CHOICES.map((c) => (
            <button key={c.id} type="button" role="menuitemradio" aria-checked={value === c.id} data-testid={`${testId}-${c.id}`} title={name(c.id)} aria-label={name(c.id)} onClick={() => { setOpen(false); onPick(c.easing); }}>
              <Curve id={c.id} />
              <span>{name(c.id)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
