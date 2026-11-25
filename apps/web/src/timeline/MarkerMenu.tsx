import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { rememberFocus } from "../a11y/restoreFocus";
import { useI18n } from "../i18n";
import { MARKER_COLOURS } from "./markers";
import type { SceneMarker } from "./scene";

export type MarkerAction =
  | { a: "rename"; id: string; name: string }
  | { a: "colour"; id: string; colour: string | null }
  | { a: "chapter"; id: string; chapter: boolean }
  | { a: "delete"; id: string };

type Props = { marker: SceneMarker; anchor: DOMRect; onAct: (a: MarkerAction) => void; onClose: () => void };

/** A marker's small menu (tap on the marker at the playhead, long press, right click, or the "Edit marker" command): rename, colour, chapter, delete.
 *  Every control is 44 px; arrow keys move between rows, Escape closes and hands focus back. */
export function MarkerMenu({ marker, anchor, onAct, onClose }: Props) {
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(marker.name);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [back] = useState(rememberFocus);
  const close = () => { onClose(); back(); };
  const closeRef = useRef(close);
  closeRef.current = close;
  const act = (a: MarkerAction, keepOpen = false) => { onAct(a); if (!keepOpen) { onClose(); back(); } };
  const valid = draft.length <= 120 && draft === draft.trim();

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    setPos({ left: Math.max(8, Math.min(anchor.left, vw - w - 8)), top: Math.max(8, Math.min(anchor.bottom + 4, vh - h - 8)) });
  }, [anchor]);
  useEffect(() => { box.current?.querySelector<HTMLElement>("input")?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    const away = (e: Event) => { if (!box.current?.contains(e.target as Node)) onClose(); };
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); closeRef.current(); } };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", esc, true);
    return () => { document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", esc, true); };
  }, [onClose]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...(box.current?.querySelectorAll<HTMLElement>("input, button:not(:disabled)") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };

  return (
    <div ref={box} className="menu-pop tl-menu marker-menu" role="menu" aria-label={t("marker.menu", { name: marker.name || t("marker.unnamed") })}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden" }} onKeyDown={onKey} data-testid="marker-menu">
      <form className="tl-rename" onSubmit={(e) => { e.preventDefault(); if (valid) act({ a: "rename", id: marker.id, name: draft }); }}>
        <label>{t("marker.name")}<input value={draft} maxLength={120} onChange={(e) => setDraft(e.target.value)} onFocus={(e) => e.currentTarget.select()} data-testid="marker-name-input" /></label>
        <button type="submit" className="menu-row" disabled={!valid}>{t("marker.rename.apply")}</button>
      </form>
      <div className="menu-group" role="presentation">{t("marker.colour")}</div>
      <div className="marker-swatches" role="group" aria-label={t("marker.colour")}>
        <button className="swatch" role="menuitemradio" aria-checked={marker.colour === null} aria-label={t("marker.colour.default")} data-testid="marker-colour-default" onClick={() => act({ a: "colour", id: marker.id, colour: null })}><span className="swatch-dot default" /></button>
        {MARKER_COLOURS.map((c) => (
          <button key={c} className="swatch" role="menuitemradio" aria-checked={marker.colour === c} aria-label={t("marker.colour.pick", { colour: c })} data-testid={`marker-colour-${c.slice(1)}`} onClick={() => act({ a: "colour", id: marker.id, colour: c })}><span className="swatch-dot" style={{ background: c }} /></button>
        ))}
      </div>
      <button className="menu-row" role="menuitemcheckbox" aria-checked={marker.chapter} data-testid="marker-chapter" onClick={() => act({ a: "chapter", id: marker.id, chapter: !marker.chapter })}>
        <span className="menu-check" aria-hidden="true">{marker.chapter ? "✓" : ""}</span><span>{t("marker.chapter")}</span>
      </button>
      <button className="menu-row" role="menuitem" data-danger="true" data-testid="marker-delete" onClick={() => act({ a: "delete", id: marker.id })}>{t("marker.delete")}</button>
    </div>
  );
}
