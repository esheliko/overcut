/** Two small native dialogs of the timeline toolbar (TL-02, TL-06): the history list and the numeric clip timing. `<dialog>` + `showModal()` puts them in the
 *  top layer (never clipped by the short timeline panel) and gives Esc, focus trap and focus return for free; the backdrop is clear so the timeline stays visible.
 *  On a phone they are bottom sheets, on a desktop a card at the bottom right. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { rememberFocus } from "../a11y/restoreFocus";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { parseTimecode, timecode } from "../timecode";
import { timingOps, type TimingField } from "./clipboard";
import { trimRange } from "./edit";
import type { Scene } from "./scene";
import { useProjectStore, useStore } from "../store/projectStore";
import type { Op } from "@app/engine-client";

function Sheet({ title, testid, onClose, children }: { title: string; testid: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { t } = useI18n();
  useEffect(() => {
    const d = ref.current;
    const back = rememberFocus(); // the button that opened the sheet (the More menu hands focus on to it)
    if (d && !d.open) d.showModal();
    return () => { if (d?.open) d.close(); back(); };
  }, []);
  return (
    <dialog ref={ref} className="edit-sheet" aria-labelledby={testid + "-title"} data-testid={testid} onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <header><h2 id={testid + "-title"}>{title}</h2><button type="button" className="icon-btn" aria-label={t("timeline.close")} onClick={onClose}><Icon name="close" size={20} /></button></header>
      {children}
    </dialog>
  );
}

/** Every step of the session's history, oldest first; the current state is marked, steps after it are undone (redo). Click or tap a row to go there. */
export function HistoryDialog({ onClose, onJumped }: { onClose: () => void; onJumped: (what: string) => void }) {
  const { t } = useI18n();
  const store = useStore();
  const undo = useProjectStore((s) => s.undoSteps);
  const redo = useProjectStore((s) => s.redoSteps);
  const earlier = useProjectStore((s) => s.earlierEdits);
  const readOnly = useProjectStore((s) => s.readOnly);
  const nowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { nowRef.current?.scrollIntoView?.({ block: "nearest" }); }, [undo.length]);
  const name = (l: string | null) => (l ? l.charAt(0).toUpperCase() + l.slice(1) : t("history.edit"));
  const rows = [{ label: earlier ? t("history.earlier") : t("history.start") }, ...[...undo, ...redo].map((l) => ({ label: name(l) }))];
  const here = undo.length; // row index of the current state (row 0 = before the first listed step)
  const go = (i: number) => {
    if (i === here) return;
    void store.jumpTo(i).then((out) => { if (out?.changed) onJumped(rows[i]!.label); });
  };
  return (
    <Sheet title={t("history.title")} testid="history-dialog" onClose={onClose}>
      <p className="sheet-hint">{t("history.hint")}</p>
      <ol className="history-list" data-testid="history-list">
        {rows.map((r, i) => (
          <li key={i}>
            <button type="button" ref={i === here ? nowRef : undefined} className="history-row" disabled={readOnly} data-state={i === here ? "now" : i < here ? "done" : "undone"}
              aria-current={i === here ? "step" : undefined} onClick={() => go(i)}>
              <span className="history-label">{r.label}</span>
              {i > here && <span className="history-tag">{t("history.undone")}</span>}
              {i === here && <span className="history-tag">{t("history.now")}</span>}
            </button>
          </li>
        ))}
      </ol>
    </Sheet>
  );
}

const FIELDS: TimingField[] = ["start", "end", "duration"];
const FIELD_KEY = { start: "timing.start", end: "timing.end", duration: "timing.duration" } as const;

/** Type a timecode (MM:SS:FF) for the selected clip's start, end or length; each applies as one trim (one undo step). */
export function TimingDialog({ scene, clip, fps, onApply, onClose }: { scene: Scene; clip: number; fps: number; onApply: (ops: Op[], field: TimingField, name: string) => void; onClose: () => void }) {
  const { t } = useI18n();
  const ft = scene.frameTicks;
  const rate = Math.max(1, Math.round(fps));
  const start = scene.tStart[clip]!, dur = scene.tDur[clip]!, end = start + dur;
  const shown: Record<TimingField, string> = { start: timecode(Math.round(start / ft), rate), end: timecode(Math.round(end / ft), rate), duration: timecode(Math.round(dur / ft), rate) };
  const [draft, setDraft] = useState<Partial<Record<TimingField, string>>>({});
  const [error, setError] = useState<{ field: TimingField; text: string } | null>(null);
  const name = scene.name[clip]!;
  const submit = (field: TimingField) => {
    const text = (draft[field] ?? shown[field]).trim();
    const frames = parseTimecode(text, rate);
    if (frames === null) { setError({ field, text: t("timing.invalid") }); return; }
    const r = timingOps(scene.id[clip]!, { start, end }, field, frames * ft, trimRange(scene, clip, "start"), trimRange(scene, clip, "end"));
    if (!r.ok) {
      const lo = field === "duration" ? timecode(Math.ceil((r.min - start) / ft), rate) : timecode(Math.ceil(r.min / ft), rate);
      const hi = field === "duration" ? timecode(Math.floor((r.max - start) / ft), rate) : timecode(Math.floor(r.max / ft), rate);
      setError({ field, text: r.reason === "invalid" ? t("timing.invalid") : t("timing.range", { min: lo, max: hi }) });
      return;
    }
    setError(null);
    setDraft((d) => ({ ...d, [field]: undefined }));
    if (r.ops.length > 0) onApply(r.ops, field, name);
  };
  return (
    <Sheet title={t("timing.title", { name })} testid="timing-dialog" onClose={onClose}>
      <p className="sheet-hint">{t("timing.hint", { fps: rate })}</p>
      <div className="timing-fields">
        {FIELDS.map((f) => (
          <form key={f} className="timing-row" onSubmit={(e) => { e.preventDefault(); submit(f); }}>
            <label htmlFor={"timing-" + f}>{t(FIELD_KEY[f])}</label>
            <input id={"timing-" + f} data-testid={"timing-" + f} type="text" inputMode="text" autoComplete="off" spellCheck={false} aria-invalid={error?.field === f}
              aria-describedby={error?.field === f ? "timing-error" : undefined} value={draft[f] ?? shown[f]} onChange={(e) => { setDraft((d) => ({ ...d, [f]: e.target.value })); if (error?.field === f) setError(null); }}
              onFocus={(e) => e.currentTarget.select()} />
            <button type="submit" className="timing-set" data-testid={"timing-set-" + f}>{t("timing.set")}</button>
          </form>
        ))}
      </div>
      <p id="timing-error" className="sheet-error" role="alert" data-testid="timing-error">{error?.text ?? ""}</p>
    </Sheet>
  );
}
