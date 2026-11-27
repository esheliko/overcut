import { useCallback, useEffect, useRef, useState, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent, type RefObject } from "react";
import { announce } from "../a11y/announcer";
import { useI18n } from "../i18n";
import { clampTimelineRow, readTimelineRow, writeTimelineRow } from "./split";

/**
 * The draggable edge between the preview and the timeline (tablet and up). A window splitter (role="separator", focusable): drag it, use the
 * up / down arrow keys (Shift = bigger steps, Home / End = smallest / largest timeline), double-click or Enter to go back to the default.
 * The height is a CSS variable on the workspace (`--tl-row`, read by the grid rows in styles.css), so dragging re-renders nothing in React;
 * it is remembered on this device only. The hit area is 24 px with a mouse (WCAG 2.5.8) and 44 px on touch (styles.css).
 */
export function Splitter({ workspace }: { workspace: RefObject<HTMLElement | null> }) {
  const { t } = useI18n();
  const [now, setNow] = useState<number | null>(null); // the timeline row in px while a user size is set (aria-valuenow); null = default
  const drag = useRef<{ id: number; edge: number } | null>(null);
  const frame = useRef(0);
  const [h, setH] = useState(0); // the timeline row's measured height (aria-valuenow while no user size is set)
  const [r, setR] = useState(0); // the workspace height: read in effects and the observer (clean layout), never in render (that forced a layout on every app render, i.e. after every edit)

  const room = useCallback(() => workspace.current?.getBoundingClientRect().height ?? 0, [workspace]);
  const rowH = useCallback(() => workspace.current?.querySelector<HTMLElement>(".timeline")?.getBoundingClientRect().height ?? 0, [workspace]);
  const apply = useCallback((px: number | null) => {
    const el = workspace.current;
    if (!el) return;
    if (px === null) el.style.removeProperty("--tl-row");
    else el.style.setProperty("--tl-row", `${px}px`);
    setNow(px);
    setR(room());
    setH(rowH());
  }, [workspace, room, rowH]);

  useEffect(() => {
    const saved = readTimelineRow();
    if (saved !== null) apply(clampTimelineRow(saved, room()));
  }, [apply, room]);
  // A window that shrinks keeps the saved size inside the allowed range.
  useEffect(() => {
    const el = workspace.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    setR(room()); setH(rowH());
    const ro = new ResizeObserver(() => { setR(room()); setH(rowH()); setNow((cur) => {
      if (cur === null) return cur;
      const next = clampTimelineRow(cur, room());
      if (next !== cur) el.style.setProperty("--tl-row", `${next}px`);
      return next;
    }); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [workspace, room, rowH]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const ws = workspace.current;
    if (!ws) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, edge: ws.getBoundingClientRect().bottom - parseFloat(getComputedStyle(ws).paddingBottom || "0") };
    e.preventDefault();
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const y = e.clientY;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => apply(clampTimelineRow(d.edge - y, room())));
  };
  const onUp = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    cancelAnimationFrame(frame.current);
    const px = clampTimelineRow(d.edge - e.clientY, room());
    apply(px);
    writeTimelineRow(px);
  };
  const reset = () => { apply(null); writeTimelineRow(null); announce(t("tl.height.reset")); };
  const onKey = (e: RKeyboardEvent<HTMLDivElement>) => {
    const ws = workspace.current;
    if (!ws) return;
    if (e.key === "Enter") { e.preventDefault(); reset(); return; }
    const cur = now ?? ws.querySelector<HTMLElement>(".timeline")?.getBoundingClientRect().height ?? 0;
    const step = e.shiftKey ? 96 : 24;
    let next: number | null = null;
    if (e.key === "ArrowUp") next = cur + step;
    else if (e.key === "ArrowDown") next = cur - step;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = Infinity;
    if (next === null) return;
    e.preventDefault();
    const px = clampTimelineRow(next, room());
    apply(px);
    writeTimelineRow(px);
  };
  const vmin = Math.round(clampTimelineRow(0, r)), vmax = Math.round(clampTimelineRow(Infinity, r));
  return (
    <div className="splitter" role="separator" aria-orientation="horizontal" aria-label={t("splitter.label")} tabIndex={0} data-testid="splitter"
      aria-valuemin={vmin} aria-valuemax={vmax} aria-valuenow={Math.min(vmax, Math.max(vmin, Math.round(now ?? h)))}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onDoubleClick={reset} onKeyDown={onKey}>
      <span aria-hidden="true" />
    </div>
  );
}
