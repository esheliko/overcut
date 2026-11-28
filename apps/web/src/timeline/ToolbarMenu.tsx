import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { rememberFocus } from "../a11y/restoreFocus";
import { useI18n } from "../i18n";
import { Icon } from "../icons";

export interface MenuItem {
  id: string;
  label: string;
  /** Section heading shown above the first item of each section. */
  section?: string;
  /** A plain-language line under the label (what the row does, for someone who has never met the word). */
  sub?: string;
  /** Keys, shown at the end of the row. */
  hint?: string;
  /** Why the item is unavailable (shown under it; the row stays focusable so a keyboard user can hear it). */
  reason?: string;
  disabled?: boolean;
  /** Radio / check state; omitted for a plain action. */
  checked?: boolean;
  /** An on/off switch (menuitemcheckbox): its state is written at the end of the row ("On" / "Off") and picking it leaves the menu open so the change is seen. */
  toggle?: boolean;
  testid?: string;
  onSelect(): void;
}

type Props = { name: string; items: readonly MenuItem[]; anchor: DOMRect; onClose(): void; testid?: string };

/** A toolbar menu (tool picker, "More"): a popover under its button on wide screens, a bottom sheet on phones. Every row is a 44 px button;
 *  arrows, Home and End move, Escape closes and hands focus back, and a disabled row says why instead of silently doing nothing. */
export function ToolbarMenu({ name, items, anchor, onClose, testid }: Props) {
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const sheet = typeof window !== "undefined" && window.innerWidth <= 480;
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [back] = useState(rememberFocus);
  const close = () => { onClose(); back(); };

  useLayoutEffect(() => {
    const el = box.current;
    if (!el || sheet) return;
    const w = el.offsetWidth, h = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    // Under the button when it fits, else above it (the toolbar sits low on the screen), always inside the viewport.
    const below = anchor.bottom + 4, top = below + h <= vh - 8 ? below : anchor.top - h - 4;
    setPos({ left: Math.max(8, Math.min(anchor.left, vw - w - 8)), top: Math.max(8, Math.min(top, vh - h - 8)) });
  }, [anchor, sheet]);
  const placed = sheet || pos !== null; // a hidden (not yet placed) menu cannot take focus
  useEffect(() => {
    if (!placed) return;
    box.current?.querySelector<HTMLElement>('[aria-checked="true"], button')?.focus({ preventScroll: true });
  }, [placed]);
  useEffect(() => {
    const away = (e: Event) => { if (!box.current?.contains(e.target as Node)) onClose(); };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [onClose]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    const rows = [...(box.current?.querySelectorAll<HTMLElement>("button") ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const go = e.key === "ArrowDown" ? at + 1 : e.key === "ArrowUp" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : null;
    if (go !== null && rows.length) { e.preventDefault(); rows[(go + rows.length) % rows.length]!.focus(); }
    if (e.key === "Tab") { e.preventDefault(); close(); }
  };

  const radio = items.some((i) => i.checked !== undefined && !i.toggle);
  let section: string | undefined;
  return (
    <div ref={box} className={sheet ? "menu-pop tl-menu tl-sheet" : "menu-pop tl-menu"} role="menu" aria-label={name} data-testid={testid ?? "toolbar-menu"} onKeyDown={onKey}
      style={sheet ? undefined : { left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden" }}>
      {sheet && <div className="tl-sheet-title">{name}<button className="icon-btn" role="menuitem" aria-label={t("timeline.close")} onClick={close}><Icon name="close" size={18} /></button></div>}
      {items.map((it) => {
        const head = it.section && it.section !== section ? <div key={`s-${it.id}`} className="menu-group" role="presentation">{it.section}</div> : null;
        section = it.section ?? section;
        const why = it.disabled ? it.reason : undefined;
        return (
          <div key={it.id} role="none">
            {head}
            <button className="menu-row" role={it.toggle ? "menuitemcheckbox" : radio ? "menuitemradio" : "menuitem"} aria-checked={it.toggle ? !!it.checked : radio ? !!it.checked : undefined} aria-disabled={it.disabled || undefined}
              title={why} data-testid={it.testid} onClick={() => { if (it.disabled) return; it.onSelect(); if (!it.toggle) { onClose(); back(); } }}>
              {radio && !it.toggle && <span className="menu-check" aria-hidden="true">{it.checked && <Icon name="check" size={16} />}</span>}
              <span className="menu-label">{it.label}{why ? <small className="menu-why menu-reason">{why}</small> : it.sub && <small className="menu-why">{it.sub}</small>}</span>
              {it.toggle && <span className="menu-state" data-on={it.checked ? "true" : "false"}>{t(it.checked ? "timeline.toggle.on" : "timeline.toggle.off")}</span>}
              {it.hint && <kbd className="menu-hint">{it.hint}</kbd>}
            </button>
          </div>
        );
      })}
    </div>
  );
}
