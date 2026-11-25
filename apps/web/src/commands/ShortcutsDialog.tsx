import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { Modal } from "../ProjectDialogs";
import { currentSettings, saveSettings } from "./keymap";
import { useKeymapSettings } from "./useKeymap";
import { COMMANDS, PRESETS, bind, buildKeymap, chordLabel, chordOf, conflictsFor, reset, type CommandDef, type KeymapSettings } from "./registry";

const GROUPS = ["edit", "tool", "track", "select", "clip", "playhead", "view", "transport"] as const;
const isApple = (): boolean => typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

/** Keyboard shortcuts: pick a preset ("like X"), change any command's keys, see and resolve conflicts, reset. Stored on this device only. */
export function ShortcutsDialog({ onClose }: { onClose(): void }) {
  const { t } = useI18n();
  const settings = useKeymapSettings();
  const keymap = buildKeymap(settings);
  const apple = isApple();
  const [listening, setListening] = useState<string | null>(null);
  const [clash, setClash] = useState<{ id: string; chord: string; others: CommandDef[] } | null>(null);
  const [note, setNote] = useState("");
  const change = (next: KeymapSettings) => saveSettings(next);

  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      const chord = chordOf(e);
      if (!chord) return; // a modifier on its own: wait for the key
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && chord === "Escape") { setListening(null); return; }
      const others = conflictsFor(listening, chord, buildKeymap(currentSettings()));
      if (others.length > 0) { setClash({ id: listening, chord, others }); setListening(null); return; }
      change(bind(currentSettings(), listening, chord));
      setNote(t("shortcuts.changed", { name: t(`cmd.${listening}`), keys: chordLabel(chord, apple) }));
      setListening(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [listening, apple, t]);

  const customised = settings.preset !== "default" || Object.keys(settings.overrides).length > 0;
  return (
    <Modal title={t("shortcuts.title")} titleId="shortcuts-title" testId="shortcuts-dialog" onClose={onClose}>
      <label className="sc-preset">
        <span>{t("shortcuts.preset")}</span>
        <select value={settings.preset} data-testid="shortcuts-preset" onChange={(e) => { setClash(null); change({ preset: e.target.value, overrides: {} }); }}>
          {PRESETS.map((p) => <option key={p.id} value={p.id}>{t(p.label)}</option>)}
        </select>
      </label>
      <p className="export-note">{t("shortcuts.hint")}</p>
      <div role="status" aria-live="polite" className="sc-note">{note}</div>
      {clash && (
        <div className="sc-clash" role="alert" data-testid="shortcuts-clash">
          <p>{t("shortcuts.clash", { keys: chordLabel(clash.chord, apple), others: clash.others.map((o) => t(`cmd.${o.id}`)).join(", ") })}</p>
          <div className="export-actions">
            <button className="export-secondary" onClick={() => setClash(null)}>{t("shortcuts.keep")}</button>
            <button className="export-go" data-testid="shortcuts-replace" onClick={() => { change(bind(currentSettings(), clash.id, clash.chord)); setNote(t("shortcuts.changed", { name: t(`cmd.${clash.id}`), keys: chordLabel(clash.chord, apple) })); setClash(null); }}>{t("shortcuts.replace")}</button>
          </div>
        </div>
      )}
      {GROUPS.map((g) => (
        <section key={g} className="sc-group" aria-labelledby={`sc-${g}`}>
          <h3 id={`sc-${g}`}>{t(`shortcuts.group.${g}`)}</h3>
          <ul>
            {COMMANDS.filter((d) => d.id.startsWith(`${g}.`)).map((d) => {
              const keys = keymap.get(d.id) ?? d.keys;
              const name = t(`cmd.${d.id}`);
              const on = listening === d.id;
              return (
                <li key={d.id} className="sc-row" data-testid={`sc-${d.id}`}>
                  <span className="sc-name">{name}</span>
                  <span className="sc-keys">{keys.length ? keys.map((k) => <kbd key={k}>{chordLabel(k, apple)}</kbd>) : <em>{t("shortcuts.none")}</em>}</span>
                  {d.fixed ? <span className="sc-fixed">{t("shortcuts.fixed")}</span> : (
                    <button className="sc-change" aria-label={t("shortcuts.changeFor", { name })} data-testid={`sc-change-${d.id}`} onClick={() => { setClash(null); setNote(""); setListening(on ? null : d.id); }}>
                      {on ? t("shortcuts.press") : t("shortcuts.change")}
                    </button>
                  )}
                  {!d.fixed && settings.overrides[d.id] && <button className="sc-change" aria-label={t("shortcuts.resetFor", { name })} onClick={() => change(reset(currentSettings(), d.id))}>{t("shortcuts.reset")}</button>}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <div className="export-actions">
        <button className="export-secondary" disabled={!customised} data-testid="shortcuts-reset-all" onClick={() => { setClash(null); change({ preset: "default", overrides: {} }); }}>{t("shortcuts.resetAll")}</button>
        <button className="export-go" onClick={onClose}>{t("shortcuts.done")}</button>
      </div>
    </Modal>
  );
}
