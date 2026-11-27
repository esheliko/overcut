import { useState, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { useProjectStore, useStore } from "../store/projectStore";
import { announce } from "../a11y/announcer";
import { clipSpan, formatSpeed, MAX_SPEED, MIN_SPEED, speedOf, speedOps, speedTarget, SPEED_PRESETS, toRational } from "./speedModel";
import { withKey } from "../commands/keymap";
import "./inspector.css";

const PRESET_COMMAND: Partial<Record<number, string>> = { 0.5: "clip.speedHalf", 1: "clip.speedNormal", 2: "clip.speed2x" };

/** The Speed tab: presets, a number field, "move later clips" (ripple), a note that the sound keeps its pitch. One edit = one undo step. */
export function SpeedSection(): ReactNode {
  const { t } = useI18n();
  const store = useStore();
  const project = useProjectStore((s) => s.project);
  const selection = useProjectStore((s) => s.selection);
  const readOnly = useProjectStore((s) => s.readOnly);
  const [ripple, setRipple] = useState(false);
  const [message, setMessage] = useState("");
  const target = speedTarget(project, selection);
  if (!target) return <p className="insp-empty">{t("speed.none")}</p>;
  if (target.still) return <p className="insp-empty">{t("speed.still")}</p>;
  const current = speedOf(target.clip);
  const apply = async (x: number): Promise<void> => {
    const r = toRational(x);
    if (!r) return void setMessage(t("speed.range", { min: String(MIN_SPEED), max: String(MAX_SPEED) }));
    if (r.num * target.clip.speed!.den === r.den * target.clip.speed!.num) return void setMessage("");
    try {
      await store.apply(speedOps(target.group, r, ripple), undefined, t("speed.undoLabel"));
      setMessage("");
      const span = clipSpan(store.getState().project, target.clip.id); // the status line must read the new length, not the old one
      if (span) announce(t("speed.announce", { speed: formatSpeed(x), ...span }));
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      setMessage(/Overlap/.test(why) ? t("speed.noRoom") : /BadSpeed/.test(why) ? t("speed.range", { min: String(MIN_SPEED), max: String(MAX_SPEED) }) : t("speed.failed"));
    }
  };
  return (
    <div className="insp" data-testid="speed-section">
      <div className="insp-row" role="group" aria-label={t("speed.presets")}>
        {SPEED_PRESETS.map((p) => (
          <button key={p} aria-pressed={current === p} disabled={readOnly} data-testid={`speed-preset-${p}`} title={PRESET_COMMAND[p] ? withKey(formatSpeed(p), PRESET_COMMAND[p]!) : undefined} onClick={() => void apply(p)}>{formatSpeed(p)}</button>
        ))}
      </div>
      <div className="insp-field">
        <label className="insp-fl">
          <span>{t("speed.field")}</span>
          <input
            key={current}
            type="number"
            inputMode="decimal"
            disabled={readOnly}
            data-testid="speed-field"
            min={MIN_SPEED}
            max={MAX_SPEED}
            step={0.05}
            defaultValue={Number(current.toFixed(2))}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            onBlur={(e) => e.currentTarget.value !== "" && void apply(Number(e.currentTarget.value))}
          />
          <em>×</em>
        </label>
      </div>
      <label className="insp-check">
        <input type="checkbox" checked={ripple} disabled={readOnly} data-testid="speed-ripple" onChange={(e) => setRipple(e.currentTarget.checked)} />
        <span>{t("speed.ripple")}</span>
      </label>
      <p className="insp-help" data-testid="speed-pitch">{t("speed.pitch")}</p>
      <p className="insp-help insp-warn" role="status" data-testid="speed-message">{message}</p>
    </div>
  );
}
