import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { rememberFocus } from "../a11y/restoreFocus";
import { useI18n } from "../i18n";
import { useProjectStore } from "../store/projectStore";
import { clipboardState, whyNot } from "./availability";
import { currentKeymap } from "./keymap";
import { COMMAND_EVENT, loadRecent, pushRecent, saveRecent, searchCommands } from "./palette";
import { chordLabel, type CommandDef } from "./registry";

const isApple = (): boolean => typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

/** Command palette (M2-041): type to find any editing command, Enter runs it. Recently used commands come first. A full-width sheet on phones. */
export function Palette({ onClose }: { onClose(): void }) {
  const { t } = useI18n();
  const dlg = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const [recent] = useState(loadRecent);
  const canUndo = useProjectStore((s) => s.canUndo), canRedo = useProjectStore((s) => s.canRedo), selected = useProjectStore((s) => s.selection.size);
  const avail = useMemo(() => ({ canUndo, canRedo, selected, copied: clipboardState.copied }), [canUndo, canRedo, selected]);
  const hits = useMemo(() => searchCommands(q, (id) => t(`cmd.${id}`), recent, undefined, (d) => whyNot(d, avail)), [q, recent, t, avail]);
  const touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches; // no keyboard: the shortcut hints would be noise
  const apple = isApple();
  // Layout effect: the dialog is open (and focused) before the browser paints, so a key pressed right after the rows appear already reaches it.
  useLayoutEffect(() => {
    const d = dlg.current;
    const back = rememberFocus();
    if (d && !d.open) d.showModal();
    return () => { if (d?.open) d.close(); back(); };
  }, []);
  useEffect(() => { setAt(0); }, [q]);
  useEffect(() => { list.current?.children[at]?.scrollIntoView?.({ block: "nearest" }); }, [at]);

  const run = (d: CommandDef) => {
    if (whyNot(d, avail)) return; // a disabled row says why instead of doing nothing
    saveRecent(pushRecent(recent, d.id));
    onClose();
    // After the dialog has gone: the canvas runs what it owns and hands the rest to the timeline.
    setTimeout(() => window.dispatchEvent(new CustomEvent(COMMAND_EVENT, { detail: d.command })), 0);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setAt((i) => Math.min(hits.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setAt((i) => Math.max(0, i - 1)); }
    else if (e.key === "Home" && e.ctrlKey) { e.preventDefault(); setAt(0); }
    else if (e.key === "Enter") { e.preventDefault(); const d = hits[at]; if (d) run(d); }
  };
  const keyOf = (d: CommandDef) => { const k = (currentKeymap().get(d.id) ?? d.keys)[0]; return k ? chordLabel(k, apple) : ""; };

  return (
    <dialog ref={dlg} className="palette" aria-label={t("palette.title")} data-testid="palette" onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === dlg.current) onClose(); }}>
      <input className="palette-input" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={hits[at] ? `pal-${hits[at]!.id}` : undefined} aria-autocomplete="list"
        autoFocus value={q} placeholder={t("palette.placeholder")} aria-label={t("palette.title")} data-testid="palette-input" onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} />
      <ul id="palette-list" ref={list} role="listbox" className="palette-list" aria-label={t("palette.results")}>
        {hits.map((d, i) => (
          <li key={d.id} id={`pal-${d.id}`} role="option" aria-selected={i === at} aria-disabled={whyNot(d, avail) ? true : undefined} className={`${i === at ? "palette-row on" : "palette-row"}${whyNot(d, avail) ? " off" : ""}`} data-testid={`pal-${d.id}`}
            onPointerMove={() => setAt(i)} onClick={() => run(d)}>
            <span>{t(`cmd.${d.id}`)}</span>
            {whyNot(d, avail) ? <small className="palette-why">{t(whyNot(d, avail)!)}</small> : !touch && keyOf(d) && <kbd>{keyOf(d)}</kbd>}
          </li>
        ))}
      </ul>
      {hits.length === 0 && <p className="palette-empty" role="status">{t("palette.empty")}</p>}
    </dialog>
  );
}
