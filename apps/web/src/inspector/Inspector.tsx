import { useRef, type ReactNode } from "react";
import type { Clip, ClipTransform, Fit, Project } from "@app/engine-client";
import { useI18n } from "../i18n";
import { useProjectStore, useStore } from "../store/projectStore";
import { isIdentity, newGestureKey, setField, setFit, toggleFlip, valuesOf, RESET, rangeOf, type NumKey } from "./transformModel";
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

/** Sends `set_clip_transform` for `clip`; edits that share a `key` are one undo step. */
export function useTransformEdit() {
  const store = useStore();
  const { t } = useI18n();
  return (clip: string, next: ClipTransform, key?: number) => void store.apply({ op: "set_clip_transform", clip, transform: next }, key, t("inspector.undoLabel"));
}

const PCT = 100;
interface FieldDef { key: NumKey; label: string; unit: "%" | "°"; mul: number; step: number }
const FIELDS: FieldDef[] = [
  { key: "position_x", label: "inspector.x", unit: "%", mul: PCT, step: 1 },
  { key: "position_y", label: "inspector.y", unit: "%", mul: PCT, step: 1 },
  { key: "scale_x", label: "inspector.scale", unit: "%", mul: PCT, step: 5 },
  { key: "rotation", label: "inspector.rotation", unit: "°", mul: 1, step: 1 },
  { key: "opacity", label: "inspector.opacity", unit: "%", mul: PCT, step: 5 },
  { key: "crop_left", label: "inspector.cropLeft", unit: "%", mul: PCT, step: 1 },
  { key: "crop_top", label: "inspector.cropTop", unit: "%", mul: PCT, step: 1 },
  { key: "crop_right", label: "inspector.cropRight", unit: "%", mul: PCT, step: 1 },
  { key: "crop_bottom", label: "inspector.cropBottom", unit: "%", mul: PCT, step: 1 },
];
const FITS: Fit[] = ["contain", "cover", "stretch"];

/** Transform of the selected clip: numeric fields, fit, flip, reset. Every field editing session (focus to blur) is one undo step. */
export function Inspector(): ReactNode {
  const { t } = useI18n();
  const project = useProjectStore((s) => s.project);
  const selection = useProjectStore((s) => s.selection);
  const readOnly = useProjectStore((s) => s.readOnly);
  const edit = useTransformEdit();
  const key = useRef<number | undefined>(undefined);
  const clip = selectedVideoClip(project, selection);
  if (!clip) return <p className="insp-empty">{t("inspector.none")}</p>;
  const tr = clip.transform;
  const v = valuesOf(tr);
  const set = (k: NumKey, value: number) => {
    // Scale is uniform here: both axes move together (the handles also scale uniformly).
    let next = setField(tr, k, value);
    if (k === "scale_x") next = setField(next, "scale_y", value);
    edit(clip.id, next, key.current ?? (key.current = newGestureKey()));
  };
  return (
    <div className="insp" data-testid="inspector-fields">
      {FIELDS.map((f) => {
        const [lo, hi] = rangeOf(f.key, v);
        return (
          <label key={f.key} className="insp-field">
            <span>{t(f.label)}</span>
            <input
              type="number"
              inputMode="decimal"
              disabled={readOnly}
              data-testid={`insp-${f.key}`}
              step={f.step}
              min={lo * f.mul}
              max={hi * f.mul}
              value={Math.round(v[f.key] * f.mul * 100) / 100}
              onFocus={() => (key.current = newGestureKey())}
              onBlur={() => (key.current = undefined)}
              onChange={(e) => e.currentTarget.value !== "" && set(f.key, Number(e.currentTarget.value) / f.mul)}
            />
            <em>{f.unit}</em>
          </label>
        );
      })}
      <div className="insp-row" role="group" aria-label={t("inspector.fit")}>
        {FITS.map((f) => (
          <button key={f} aria-pressed={(tr?.fit ?? "contain") === f} disabled={readOnly} onClick={() => edit(clip.id, setFit(tr, f))} data-testid={`insp-fit-${f}`}>{t(`inspector.fit.${f}`)}</button>
        ))}
      </div>
      <div className="insp-row">
        <button aria-pressed={!!tr?.flip_h} disabled={readOnly} onClick={() => edit(clip.id, toggleFlip(tr, "h"))} data-testid="insp-flip-h">{t("inspector.flipH")}</button>
        <button aria-pressed={!!tr?.flip_v} disabled={readOnly} onClick={() => edit(clip.id, toggleFlip(tr, "v"))} data-testid="insp-flip-v">{t("inspector.flipV")}</button>
        <button disabled={readOnly || isIdentity(tr)} onClick={() => edit(clip.id, RESET)} data-testid="insp-reset">{t("inspector.reset")}</button>
      </div>
    </div>
  );
}
