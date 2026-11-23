import { useState } from "react";
import { useI18n } from "../i18n";
import { CANVAS_PRESETS, FRAME_RATES, presetSize, rateOf, type PresetId } from "./presets";
import { Sheet } from "./Sheet";
import type { NewSpec } from "../persistence";

/** PM-01: name, canvas (preset chips, "Match first clip" by default) and frame rate. Nothing here is permanent: the canvas can be changed later from the preview. */
export function NewProjectSheet({ onCreate, onClose }: { onCreate(spec: NewSpec): void; onClose(): void }) {
  const { t } = useI18n();
  const [name, setName] = useState(t("app.untitled"));
  const [canvas, setCanvas] = useState<PresetId | "match">("match");
  const [fps, setFps] = useState<number | "match">("match");
  const create = () => onCreate({ name: name.trim() || t("app.untitled"), size: canvas === "match" ? null : presetSize(canvas), rate: fps === "match" ? null : rateOf(fps) });
  return (
    <Sheet title={t("new.title")} onClose={onClose} testid="new-project">
      <label className="field">
        <span>{t("project.name")}</span>
        <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} data-testid="new-name" spellCheck={false} />
      </label>
      <fieldset className="chips" data-testid="new-canvas">
        <legend>{t("new.canvas")}</legend>
        {(["match", ...CANVAS_PRESETS.map((p) => p.id)] as const).map((id) => (
          <label key={id} className="chip-choice" data-checked={canvas === id}>
            <input type="radio" name="canvas" value={id} checked={canvas === id} onChange={() => setCanvas(id)} />
            <strong>{t(`canvas.${id}`)}</strong>
            <span>{id === "match" ? t("canvas.match.hint") : `${presetSize(id).width}×${presetSize(id).height}`}</span>
          </label>
        ))}
      </fieldset>
      <fieldset className="chips" data-testid="new-fps">
        <legend>{t("new.fps")}</legend>
        {(["match", ...FRAME_RATES] as const).map((f) => (
          <label key={f} className="chip-choice small" data-checked={fps === f}>
            <input type="radio" name="fps" value={f} checked={fps === f} onChange={() => setFps(f)} />
            <strong>{f === "match" ? t("fps.match") : f}</strong>
          </label>
        ))}
      </fieldset>
      <p className="export-note">{t("new.later")}</p>
      <button className="primary export-go" onClick={create} data-testid="new-create">{t("new.create")}</button>
    </Sheet>
  );
}
