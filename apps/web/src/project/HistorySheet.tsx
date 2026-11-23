import { useRef } from "react";
import { useI18n } from "../i18n";
import { useProjectStore, useStore } from "../store/projectStore";
import type { HistoryEntry } from "../store/history";
import { Sheet } from "./Sheet";

/** TL-06: the edits of this session by name. Click (or Enter) a step to go back or forward to it: each step is a normal undo/redo. */
export function HistorySheet({ onClose }: { onClose(): void }) {
  const { t } = useI18n();
  const store = useStore();
  const h = useProjectStore((s) => s.history);
  const list = useRef<HTMLOListElement>(null);
  const now = h.past.length;
  const rows: { target: number; label: string; future: boolean }[] = [{ target: 0, label: t("history.start"), future: false }];
  const name = (e: HistoryEntry) => t(e.label.key, e.label.params);
  h.past.forEach((e, i) => rows.push({ target: i + 1, label: name(e), future: false }));
  h.future.forEach((e, i) => rows.push({ target: now + i + 1, label: name(e), future: true }));
  // Up and Down move between steps (the list can be long); Enter / Space activate the focused one like any button.
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const buttons = Array.from(list.current?.querySelectorAll("button") ?? []);
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons[at + (e.key === "ArrowDown" ? 1 : -1)];
    if (next) { e.preventDefault(); next.focus(); }
  };
  return (
    <Sheet title={t("history.title")} onClose={onClose} testid="history">
      <p className="export-note">{t("history.hint")}</p>
      {h.earlier && <p className="export-note" data-testid="history-earlier">{t("history.earlier")}</p>}
      <ol className="history-list" ref={list} onKeyDown={onKey} aria-label={t("history.title")} data-testid="history-list">
        {rows.map((r) => (
          <li key={r.target}>
            <button className="history-row" data-future={r.future} data-current={r.target === now} aria-current={r.target === now ? "step" : undefined} onClick={() => void store.jumpTo(r.target)}>
              <span className="history-n" aria-hidden="true">{r.target}</span>
              <span>{r.label}</span>
            </button>
          </li>
        ))}
      </ol>
    </Sheet>
  );
}
