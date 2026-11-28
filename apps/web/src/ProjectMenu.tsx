import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { rememberFocus } from "./a11y/restoreFocus";
import { Icon, type IconName } from "./icons";

export type MenuItem = { id: string; label: string; icon: IconName; danger?: boolean; onPick(): void };

/**
 * The "…" menu of one project card (project library, `docs/features/project-library.md`). A fixed popover beside the button, kept inside the
 * viewport; every row is a 44 px button. Arrow keys / Home / End move, Esc and a tap outside close it, and focus goes back to the "…" button.
 * Scrolling the list closes it (the anchor moved).
 */
export function ProjectMenu({ label, items, anchor, onClose }: { label: string; items: MenuItem[]; anchor: DOMRect; onClose(): void }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [back] = useState(rememberFocus);
  const close = () => { onClose(); back(); };

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    const left = Math.max(8, Math.min(anchor.right - w, vw - w - 8));
    const below = anchor.bottom + 4;
    const top = below + h <= vh - 8 ? below : Math.max(8, anchor.top - h - 4);
    setPos({ left, top });
  }, [anchor]);
  useEffect(() => { box.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    const away = (e: Event) => { if (!box.current?.contains(e.target as Node)) onClose(); };
    const scrolled = () => onClose();
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", scrolled);
    return () => { document.removeEventListener("pointerdown", away, true); document.removeEventListener("scroll", scrolled, true); window.removeEventListener("resize", scrolled); };
  }, [onClose]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    const buttons = [...(box.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    const go = e.key === "ArrowDown" ? at + 1 : e.key === "ArrowUp" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : null;
    if (go !== null && buttons.length) { e.preventDefault(); buttons[(go + buttons.length) % buttons.length]!.focus(); }
    if (e.key === "Tab") { e.preventDefault(); close(); }
  };

  return (
    <div ref={box} className="lib-menu" role="menu" aria-label={label} data-testid="project-menu" style={{ left: pos?.left ?? -9999, top: pos?.top ?? 0 }} onKeyDown={onKey}>
      {items.map((it) => (
        <button key={it.id} role="menuitem" className="lib-menu-row" data-danger={it.danger || undefined} data-testid={`project-${it.id}`} onClick={() => { onClose(); it.onPick(); }}>
          <Icon name={it.icon} size={18} /><span>{it.label}</span>
        </button>
      ))}
    </div>
  );
}
