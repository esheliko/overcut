import { useEffect, useRef, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent } from "react";
import { useI18n } from "../i18n";
import { DETENTS, detentHeights, settle, stepDetent, type Detent } from "./sheet";

/**
 * The grab handle of the phone tool sheet: drag it to any height (the sheet follows the finger), let go and it snaps to the detent the motion was
 * heading for (small / half / full; flick down from small to close). Keyboard: up / down arrows change the detent, Escape closes. The parent
 * `.library` carries the height in `--sheet-h` and the detent in `data-detent` (styles.css); the transition is off while dragging.
 */
export function SheetHandle({ detent, onDetent, onClose }: { detent: Detent; onDetent(d: Detent): void; onClose(): void }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; y: number; h: number; samples: { y: number; t: number }[]; moved: boolean } | null>(null);
  const sheet = () => ref.current?.parentElement ?? null;
  const heights = () => detentHeights(window.innerHeight);

  // The detent sets the height (a pixel value, so the drag can start from it and CSS can transition between detents).
  useEffect(() => {
    // The workspace (the sheet's parent) gets the same height, so the picture and the timeline reflow into what is left above the sheet (it follows the detent, not every drag frame).
    const set = () => { const px = `${heights()[detent]}px`; const el = sheet(); if (el) { el.style.setProperty("--sheet-h", px); el.parentElement?.style.setProperty("--sheet-h", px); } };
    set();
    window.addEventListener("resize", set);
    return () => { const el = sheet(); window.removeEventListener("resize", set); el?.style.removeProperty("--sheet-h"); el?.parentElement?.style.removeProperty("--sheet-h"); };
  }, [detent]);
  // Escape closes the sheet from anywhere (a dialog or menu that is open handles its own Escape first: it stops the event).
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector("dialog[open]")) onClose(); };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose]);

  const down = (e: RPointerEvent<HTMLDivElement>) => {
    const el = sheet();
    if (!el) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, y: e.clientY, h: el.getBoundingClientRect().height, samples: [{ y: e.clientY, t: e.timeStamp }], moved: false };
  };
  const move = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current, el = sheet();
    if (!d || !el || d.id !== e.pointerId) return;
    if (Math.abs(e.clientY - d.y) > 3) { d.moved = true; el.dataset.dragging = "true"; }
    const hs = heights();
    el.style.setProperty("--sheet-h", `${Math.min(hs.full, Math.max(hs.peek * 0.6, d.h - (e.clientY - d.y)))}px`);
    d.samples.push({ y: e.clientY, t: e.timeStamp });
    if (d.samples.length > 6) d.samples.shift();
  };
  const up = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current, el = sheet();
    if (!d || !el || d.id !== e.pointerId) return;
    drag.current = null;
    delete el.dataset.dragging;
    if (!d.moved) { onDetent(detent === "full" ? "half" : DETENTS[DETENTS.indexOf(detent) + 1] ?? "half"); return; } // a tap steps up (full goes back to half)
    const first = d.samples[0]!;
    const dt = Math.max(1, e.timeStamp - first.t);
    const v = (e.clientY - first.y) / dt;
    const h = el.getBoundingClientRect().height;
    const to = settle(h, v, heights());
    if (to === "close") onClose();
    else { el.style.setProperty("--sheet-h", `${heights()[to]}px`); el.parentElement?.style.setProperty("--sheet-h", `${heights()[to]}px`); onDetent(to); }
  };
  const key = (e: RKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const to = stepDetent(detent, e.key === "ArrowUp" ? 1 : -1);
      if (to) onDetent(to); else if (e.key === "ArrowDown") onClose();
    }
  };
  return (
    <div ref={ref} className="sheet-handle" role="slider" tabIndex={0} aria-label={t("sheet.handle")} aria-orientation="vertical"
      aria-valuemin={0} aria-valuemax={DETENTS.length - 1} aria-valuenow={DETENTS.indexOf(detent)} aria-valuetext={t(`sheet.detent.${detent}`)}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={key} data-testid="sheet-handle">
      <span aria-hidden="true" />
    </div>
  );
}
