import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useI18n } from "../i18n";
import { onThemeChange } from "../theme/tokens";
import type { Palette } from "./draw";
import { DARK, paletteFromCss } from "./draw";
import { fitsView, overviewSpan, panTo, partAt, resizeTo, windowOf, type Win } from "./overview";
import type { Scene } from "./scene";
import type { CanvasHandle } from "./TimelineCanvas";
import { zoomStore } from "./zoomStore";

type Drag = { part: "left" | "right" | "body"; grab: number; win: Win };

/** A thin strip with the whole project and a window for what the timeline shows: drag the window to pan, its edges to zoom, press outside it to jump.
 *  Hidden while the project has no clips and when everything already fits. The clip layer is cached; a scroll or zoom only repaints the window, and a playhead tick
 *  does not reach it at all (memoized, and the timeline above it no longer re-renders per tick). */
export const Overview = memo(function Overview({ scene, lengthSec, handle }: { scene: Scene; lengthSec: number; handle: () => CanvasHandle | null }) {
  const { t } = useI18n();
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const layer = useRef<{ scene: Scene | null; key: string; bmp: HTMLCanvasElement | null }>({ scene: null, key: "", bmp: null });
  const pal = useRef<Palette>(DARK);
  const drag = useRef<Drag | null>(null);
  const [shown, setShown] = useState(false);
  const live = useRef({ scene, lengthSec });
  live.current = { scene, lengthSec };

  const paint = useCallback(() => {
    const c = cv.current, h = handle();
    if (!c || !h) return;
    const { scene: sc, lengthSec: len } = live.current, v = h.view;
    // The content that decides whether the bar is useful: the clips' end, not the sequence's nominal length (an empty project, or a few seconds of clips, needs no overview).
    const hide = sc.clipCount === 0 || fitsView(v, Math.min(len, Math.max(sc.endSec, 1)));
    setShown((s) => (s === !hide ? s : !hide));
    if (hide) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2), H = Math.max(16, Math.round(c.clientHeight));
    const band = Math.min(H, 32), top = Math.round((H - band) / 2); // the visible bar is 28-32 px; on touch the canvas around it is the 44 px hit area
    const w = Math.max(1, Math.round(c.clientWidth));
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(H * dpr); }
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const p = pal.current;
    // The clip layer: one rect per clip (at least 1 px), rows = tracks. Rebuilt only when the scene, the width or the length changes.
    const l = layer.current, key = `${w}|${H}|${len}|${dpr}`;
    if (l.scene !== sc || l.key !== key || !l.bmp) {
      const bmp = l.bmp ?? document.createElement("canvas");
      bmp.width = Math.round(w * dpr); bmp.height = Math.round(H * dpr);
      const b = bmp.getContext("2d")!;
      b.setTransform(dpr, 0, 0, dpr, 0, 0);
      const span = overviewSpan(v, len);
      const rows = Math.max(1, sc.trackCount), rh = Math.max(1, (band - 8) / rows);
      for (let k = 0; k < 2; k++) {
        b.fillStyle = k === 0 ? p.videoStrip : p.audioStrip;
        for (let i = 0; i < sc.clipCount; i++) {
          if ((sc.trackKind[sc.clipTrack[i]!] === 1 ? 1 : 0) !== k) continue;
          const x = (sc.start[i]! / span) * w, cw = Math.max(1, ((sc.end[i]! - sc.start[i]!) / span) * w);
          b.fillRect(x, top + 4 + sc.clipTrack[i]! * rh, cw, Math.max(1, rh - 0.5));
        }
      }
      layer.current = { scene: sc, key, bmp };
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = p.surface; ctx.fillRect(0, 0, w, H);
    ctx.fillStyle = p.bg; ctx.beginPath(); roundRect(ctx, 0, top, w, band, 4); ctx.fill(); // the track the window slides in
    ctx.globalAlpha = 0.7; ctx.drawImage(layer.current.bmp!, 0, 0, w, H); ctx.globalAlpha = 1;
    const win = windowOf(v, len, w);
    // The window: a 1 px accent outline over a light accent wash (rounded 4 px); the grips at its ends show on touch and when focused only as a subtle tick.
    ctx.fillStyle = p.accent; ctx.globalAlpha = 0.14;
    ctx.beginPath(); roundRect(ctx, win.x0, top, win.x1 - win.x0, band, 4); ctx.fill();
    ctx.globalAlpha = 1; ctx.strokeStyle = p.accent; ctx.lineWidth = 1;
    ctx.beginPath(); roundRect(ctx, win.x0 + 0.5, top + 0.5, Math.max(2, win.x1 - win.x0 - 1), band - 1, 4); ctx.stroke();
    ctx.fillStyle = p.accent;
    ctx.fillRect(win.x0 + 2, top + band / 2 - 5, 2, 10); ctx.fillRect(win.x1 - 4, top + band / 2 - 5, 2, 10);
    const total = overviewSpan(v, len);
    c.setAttribute("aria-valuenow", String(Math.round(((v.scrollX / v.pps) / total) * 100)));
    c.dataset.win0 = String(Math.round(win.x0)); c.dataset.win1 = String(Math.round(win.x1)); // test hook
  }, [handle]);

  // Follow the timeline's zoom and scroll.
  useEffect(() => {
    const h = handle();
    if (h) h.onView = paint;
    paint();
    return () => { const g = handle(); if (g && g.onView === paint) g.onView = undefined; };
  }, [handle, paint, scene, lengthSec]);
  useEffect(() => { if (cv.current) pal.current = paletteFromCss(cv.current); return onThemeChange(() => { if (cv.current) { pal.current = paletteFromCss(cv.current); layer.current.bmp = null; paint(); } }); }, [paint]);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => paint());
    ro.observe(el);
    return () => ro.disconnect();
  }, [paint, shown]);

  const apply = (nx: { pps?: number; scrollX: number }) => {
    const h = handle();
    if (!h) return;
    if (nx.pps !== undefined) { h.view.pps = nx.pps; zoomStore.set(nx.pps, "user"); }
    h.view.scrollX = nx.scrollX;
    h.invalidate();
  };
  const local = (e: PointerEvent) => e.clientX - cv.current!.getBoundingClientRect().left;
  const onDown = (e: PointerEvent) => {
    const h = handle();
    if (!h || (e.pointerType === "mouse" && e.button !== 0)) return;
    const w = cv.current!.clientWidth, v = h.view, len = live.current.lengthSec, x = local(e);
    const win = windowOf(v, len, w);
    let part = partAt(win, x);
    let grab = x - win.x0;
    if (part === "outside") { part = "body"; grab = (win.x1 - win.x0) / 2; apply({ scrollX: panTo(v, len, w, x, grab) }); } // a press outside the window centres it there
    try { cv.current!.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    drag.current = { part, grab, win };
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current, h = handle();
    if (!d || !h) return;
    const w = cv.current!.clientWidth, v = h.view, len = live.current.lengthSec, x = local(e);
    if (d.part === "body") apply({ scrollX: panTo(v, len, w, x, d.grab) });
    else apply(resizeTo(v, len, w, d.win, d.part, x));
  };
  const end = () => { drag.current = null; };
  const onKey = (e: KeyboardEvent) => {
    const h = handle();
    if (!h) return;
    const step = (h.view.width * 0.5) * (e.shiftKey ? 2 : 1);
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); apply({ scrollX: Math.max(0, h.view.scrollX + (e.key === "ArrowLeft" ? -step : step)) }); }
  };

  return (
    <div ref={wrap} className="tl-overview" data-testid="tl-overview" hidden={!shown}>
      <canvas ref={cv} role="scrollbar" aria-orientation="horizontal" aria-label={t("timeline.overview")} aria-controls="tl-summary" aria-valuemin={0} aria-valuemax={100} aria-valuenow={0} tabIndex={0}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={end} onPointerCancel={end} onKeyDown={onKey} />
    </div>
  );
});

/** A rounded rectangle path (a plain one where `roundRect` is missing). */
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
  else ctx.rect(x, y, w, h);
}
