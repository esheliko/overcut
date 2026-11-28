import { useEffect, useRef, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent, type RefObject } from "react";
import { announce } from "../a11y/announcer";
import { useI18n } from "../i18n";
import { clampPicture, readPictureShare, writePictureShare } from "./split";

/**
 * Phone portrait grab bar between the preview and the timeline (UX r15 D7). A window splitter (role="separator", focusable, 44 px tall touch target):
 * drag it up or down, arrows nudge it, Enter / double tap goes back to the default. It sets `--pv-h` (the picture's height) on the workspace, so the
 * timeline simply takes the rest; dragging re-renders nothing in React (the aria values are written straight to the element). The size is kept as a
 * share of the workspace height, on this device only. The preview keeps at least 30 % of the height and the timeline at least 260 px (`clampPicture`).
 */
export function PhoneSplitter({ workspace }: { workspace: RefObject<HTMLElement | null> }) {
  const { t } = useI18n();
  const bar = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; y0: number; h0: number; other: number } | null>(null);
  const frame = useRef(0);
  const geo = () => {
    const ws = workspace.current;
    const canvas = ws?.querySelector<HTMLElement>(".stage .canvas");
    const tl = ws?.querySelector<HTMLElement>(".timeline");
    if (!ws || !canvas || !tl) return null;
    const stage = ws.querySelector<HTMLElement>(".stage") ?? canvas;
    const room = ws.getBoundingClientRect().height, ch = canvas.getBoundingClientRect().height, sh = stage.getBoundingClientRect().height;
    return { room, ch, chrome: sh - ch, other: room - sh - tl.getBoundingClientRect().height };
  };
  type Geo = NonNullable<ReturnType<typeof geo>>;
  const aria = (g: Geo, now: number) => {
    const el = bar.current;
    if (!el) return;
    el.setAttribute("aria-valuemin", String(clampPicture(0, g.room, g.other, g.chrome)));
    el.setAttribute("aria-valuemax", String(clampPicture(Infinity, g.room, g.other, g.chrome)));
    el.setAttribute("aria-valuenow", String(Math.round(now)));
  };
  const set = (px: number | null, g?: Geo | null) => {
    const ws = workspace.current;
    if (!ws) return;
    if (px === null) ws.style.removeProperty("--pv-h"); else ws.style.setProperty("--pv-h", `${px}px`);
    const now = g ?? geo();
    if (now) aria(now, px ?? now.ch);
  };
  useEffect(() => { // the remembered size, clamped now and whenever the window changes shape
    const ws = workspace.current;
    if (!ws) return;
    const apply = () => {
      const share = readPictureShare();
      const g = geo();
      if (!g) return;
      if (share !== null) set(clampPicture(share * g.room, g.room, g.other, g.chrome), g); else aria(g, g.ch);
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(apply);
    ro.observe(ws);
    return () => ro.disconnect();
  }, [workspace]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const commit = (px: number, g: Geo) => { const v = clampPicture(px, g.room, g.other, g.chrome); set(v, g); writePictureShare(v / g.room); };
  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    const g = geo();
    if (!g) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, y0: e.clientY, h0: g.ch, other: g.other };
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const y = e.clientY;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => { const g = geo(); if (g) set(clampPicture(d.h0 + y - d.y0, g.room, d.other, g.chrome), { ...g, other: d.other }); });
  };
  const onUp = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    cancelAnimationFrame(frame.current);
    const g = geo();
    if (g) commit(d.h0 + e.clientY - d.y0, { ...g, other: d.other });
  };
  const reset = () => { set(null); writePictureShare(null); announce(t("tl.height.reset")); };
  const onKey = (e: RKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter") { e.preventDefault(); reset(); return; }
    const g = geo();
    if (!g) return;
    const step = e.shiftKey ? 96 : 24;
    const next = e.key === "ArrowUp" ? g.ch - step : e.key === "ArrowDown" ? g.ch + step : e.key === "Home" ? 0 : e.key === "End" ? Infinity : null;
    if (next === null) return;
    e.preventDefault();
    commit(next, g);
  };
  return (
    <div ref={bar} className="pv-split" role="separator" aria-orientation="horizontal" aria-label={t("splitter.label")} tabIndex={0} data-testid="phone-splitter" aria-valuemin={0} aria-valuemax={0} aria-valuenow={0}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onDoubleClick={reset} onKeyDown={onKey}>
      <span aria-hidden="true" />
    </div>
  );
}
