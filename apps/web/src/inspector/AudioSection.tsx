import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { announce } from "../a11y/announcer";
import { useProjectStore, useStore } from "../store/projectStore";
import { newGestureKey } from "./transformModel";
import { audioOf, audioOp, maxFadeTicks, muteOps, mutableSounds, percent, seconds, soundTarget, TICKS, MAX_VOLUME, type AudioValues } from "./audioModel";

type Field = "volume" | "fadeIn" | "fadeOut";

/** The Audio tab of Details (`docs/features/clip-audio.md`): Volume (0-200%), Fade in and Fade out (seconds, up to half the clip) and Mute clip.
 *  Each field is a slider plus a number; one slider drag or one typing session is one undo step; double-click on a field puts it back. For a picture
 *  with sound, the edit lands on its linked sound. */
export function AudioSection(): ReactNode {
  const { t } = useI18n();
  const store = useStore();
  const project = useProjectStore((s) => s.project);
  const selection = useProjectStore((s) => s.selection);
  const readOnly = useProjectStore((s) => s.readOnly);
  const key = useRef<number | undefined>(undefined);
  const [note, setNote] = useState("");
  const target = soundTarget(project, selection);
  if (!target) return <p className="insp-empty" data-testid="audio-none">{t("audio.none")}</p>;
  const clip = target.clip;
  const cur = audioOf(clip);
  const maxFade = maxFadeTicks(clip.duration);
  const send = (patch: Partial<AudioValues>, label: string) => {
    const now = audioOf(store.getState().project?.sequences[0]?.tracks.flatMap((x) => x.clips).find((c) => c.id === clip.id) ?? clip);
    void store.apply(audioOp(clip, { ...now, ...patch }), key.current, label);
  };
  const set = (f: Field, v: number) => {
    if (!Number.isFinite(v)) return;
    if (f === "volume") send({ volume: v / 100 }, t("audio.undoLabel"));
    else send({ [f]: Math.min(maxFade, Math.max(0, v * TICKS)) }, t("audio.fadeUndoLabel"));
    setNote("");
  };
  const muted = cur.volume === 0;
  const sounds = mutableSounds(project, selection);
  const toggleMute = () => {
    const { ops, muting } = muteOps(sounds);
    if (ops.length === 0) return;
    void store.apply(ops, undefined, t(muting ? "audio.muteUndoLabel" : "audio.unmuteUndoLabel"));
    announce(t(muting ? "timeline.say.muted" : "timeline.say.unmuted", { name: project?.media.find((m) => m.id === clip.media)?.name ?? "" }), "polite");
  };
  const rows: { f: Field; label: string; unit: string; value: number; min: number; max: number; step: number; reset: number }[] = [
    { f: "volume", label: t("audio.volume"), unit: "%", value: percent(cur.volume), min: 0, max: MAX_VOLUME * 100, step: 1, reset: 100 },
    { f: "fadeIn", label: t("audio.fadeIn"), unit: t("audio.seconds"), value: seconds(cur.fadeIn), min: 0, max: seconds(maxFade), step: 0.1, reset: 0 },
    { f: "fadeOut", label: t("audio.fadeOut"), unit: t("audio.seconds"), value: seconds(cur.fadeOut), min: 0, max: seconds(maxFade), step: 0.1, reset: 0 },
  ];
  return (
    <div className="insp" data-testid="audio-section" data-muted={muted || undefined}>
      <div className="insp-row">
        <button type="button" aria-pressed={muted} disabled={readOnly || sounds.length === 0} data-testid="audio-mute" onClick={toggleMute}>
          <Icon name="audio" size={16} /> {t(muted ? "audio.unmute" : "audio.mute")}
        </button>
      </div>
      {rows.map((r) => {
        const shown = Math.min(r.max, Math.max(r.min, r.value));
        const atDefault = r.value === r.reset;
        const disabled = readOnly || (r.f !== "volume" && r.max === 0);
        const again = () => { key.current = undefined; set(r.f, r.reset); };
        return (
          <div className="insp-field" key={r.f}>
            <label className="insp-fl">
              <span onDoubleClick={again}>{r.label}</span>
              <input
                type="number"
                inputMode="decimal"
                disabled={disabled}
                data-testid={`audio-${r.f}`}
                min={r.min}
                max={r.max}
                step={r.step}
                value={r.value}
                onFocus={() => { key.current = newGestureKey(); }}
                onBlur={() => { key.current = undefined; setNote(""); }}
                onDoubleClick={again}
                onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                onChange={(e) => {
                  if (e.currentTarget.value === "") return;
                  const raw = Number(e.currentTarget.value);
                  if (raw > r.max) setNote(t("inspector.clamp.max", { value: String(r.max), unit: r.unit }));
                  else if (raw < r.min) setNote(t("inspector.clamp.min", { value: String(r.min), unit: r.unit }));
                  set(r.f, Math.min(r.max, Math.max(r.min, raw)));
                }}
              />
              <em>{r.unit}</em>
            </label>
            <button type="button" className="insp-kbtn insp-fieldreset" data-testid={`audio-reset-${r.f}`} aria-label={t("audio.reset", { name: r.label })} title={t("audio.reset", { name: r.label })} style={atDefault ? { visibility: "hidden" } : undefined} tabIndex={atDefault ? -1 : 0} disabled={disabled || atDefault} onClick={again}>
              <Icon name="reset" size={16} />
            </button>
            <input
              type="range"
              className="insp-slider"
              data-testid={`audio-slider-${r.f}`}
              aria-label={r.label}
              disabled={disabled}
              min={r.min}
              max={r.max}
              step={r.step}
              value={shown}
              style={{ "--p": `${r.max > r.min ? ((shown - r.min) / (r.max - r.min)) * 100 : 0}%`, "--z": `${r.f === "volume" ? 50 : 0}%` } as CSSProperties}
              onPointerDown={() => { key.current = newGestureKey(); }}
              onPointerUp={() => { key.current = undefined; }}
              onPointerCancel={() => { key.current = undefined; }}
              onKeyDown={() => { key.current = newGestureKey(); }}
              onKeyUp={() => { key.current = undefined; }}
              onDoubleClick={again}
              onChange={(e) => set(r.f, Number(e.currentTarget.value))}
            />
            <span className="insp-note" role="status" aria-live="polite">{note && document.activeElement?.getAttribute("data-testid") === `audio-${r.f}` ? note : ""}</span>
          </div>
        );
      })}
      {muted ? <p className="insp-help" data-testid="audio-muted-note">{t("audio.muted")}</p> : <p className="insp-help">{t("audio.fadeHint")}</p>}
    </div>
  );
}
