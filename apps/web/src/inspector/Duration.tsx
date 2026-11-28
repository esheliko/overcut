import { useState, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { useProjectStore, useStore } from "../store/projectStore";
import { announce } from "../a11y/announcer";
import { MAX_STILL_SECONDS, MIN_STILL_SECONDS, secondsText, stillOps, stillTicks } from "./durationModel";
import { speedTarget } from "./speedModel";
import "./inspector.css";

/** The Duration tab of a photo (UX r16): how long it stays on screen, one number with the usual nudge (arrow keys, Shift x10, Alt x0.1). One edit = one undo step. */
export function DurationSection(): ReactNode {
  const { t } = useI18n();
  const store = useStore();
  const project = useProjectStore((s) => s.project);
  const selection = useProjectStore((s) => s.selection);
  const readOnly = useProjectStore((s) => s.readOnly);
  const [message, setMessage] = useState("");
  const target = speedTarget(project, selection);
  const rate = project?.sequences[0]?.frame_rate;
  if (!target || !target.still || !rate) return <p className="insp-empty">{t("duration.none")}</p>;
  const clip = target.clip;
  const apply = async (seconds: number): Promise<void> => {
    const ticks = stillTicks(seconds, rate);
    if (ticks === null) return void setMessage(t("duration.range", { min: String(MIN_STILL_SECONDS), max: String(MAX_STILL_SECONDS) }));
    if (ticks === clip.duration) return void setMessage("");
    try {
      await store.apply(stillOps(clip, ticks), undefined, t("duration.undoLabel"));
      setMessage("");
      announce(t("duration.announce", { seconds: secondsText(ticks) }));
    } catch (e) {
      setMessage(/Overlap/.test(e instanceof Error ? e.message : String(e)) ? t("duration.noRoom") : t("duration.failed"));
    }
  };
  const nudge = (dir: -1 | 1, mult: number) => void apply(Number(secondsText(clip.duration)) + dir * 0.5 * mult);
  return (
    <div className="insp" data-testid="duration-section">
      <div className="insp-field">
        <label className="insp-fl">
          <span>{t("duration.field")}</span>
          <input
            key={clip.duration}
            type="number"
            inputMode="decimal"
            disabled={readOnly}
            data-testid="duration-field"
            min={MIN_STILL_SECONDS}
            max={MAX_STILL_SECONDS}
            step={0.5}
            defaultValue={secondsText(clip.duration)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && (e.shiftKey || e.altKey)) { e.preventDefault(); nudge(e.key === "ArrowUp" ? 1 : -1, e.shiftKey ? 10 : 0.1); } // the browser's own stepping ignores both
            }}
            onBlur={(e) => e.currentTarget.value !== "" && void apply(Number(e.currentTarget.value))}
          />
          <em>s</em>
        </label>
        <button type="button" className="insp-kbtn" data-testid="duration-less" aria-label={t("duration.less")} title={t("duration.less")} disabled={readOnly} onClick={() => nudge(-1, 1)}>−</button>
        <button type="button" className="insp-kbtn" data-testid="duration-more" aria-label={t("duration.more")} title={t("duration.more")} disabled={readOnly} onClick={() => nudge(1, 1)}>+</button>
      </div>
      <p className="insp-help">{t("duration.help")}</p>
      <p className="insp-help insp-warn" role="status" data-testid="duration-message">{message}</p>
    </div>
  );
}
