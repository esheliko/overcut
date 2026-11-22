import { useCallback, useEffect, useRef, type KeyboardEvent } from "react";
import { useI18n } from "../i18n";
import { onThemeChange } from "../theme/tokens";
import { DARK, drawTimeline, paletteFromCss, type DrawStats, type Palette } from "./draw";
import { hitTest } from "./hit";
import type { Scene } from "./scene";
import { clamp, clampPps, clampScroll, decayVelocity, fitPps, GUTTER, LANE, RULER, timeToX, xToTime, zoomAt, type View } from "./view";

export type CanvasHandle = { view: View; invalidate: () => void; draw: () => void; stats: DrawStats };

type Props = {
  scene: Scene;
  fps: number;
  /** Playhead, whole frames. */
  frame: number;
  endFrame: number;
  playing: boolean;
  /** Pixels per second, owned by the parent so the slider and buttons stay in sync. */
  zoom: number;
  onFrame: (f: number) => void;
  onZoom: (pps: number) => void;
  summary: string;
  /** Dev/benchmark hook: receives the live view and draw function. */
  onReady?: (h: CanvasHandle) => void;
};

const TAP_SLOP = 6;

/** Canvas timeline: ruler, tracks, clips, playhead. State that changes every frame lives in refs, not React state. */
export function TimelineCanvas({ scene, fps, frame, endFrame, playing, zoom, onFrame, onZoom, summary, onReady }: Props) {
  const { t } = useI18n();
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef<View>({ pps: zoom, scrollX: 0, scrollY: 0, width: 300, height: 150 });
  const dpr = useRef(1);
  const palette = useRef<Palette>(DARK);
  const stats = useRef<DrawStats>({ clipsDrawn: 0, tracksDrawn: 0 });
  const raf = useRef(0);
  const live = useRef({ scene, frame, fps, endFrame, onFrame, onZoom });
  live.current = { scene, frame, fps, endFrame, onFrame, onZoom };
  const lengthSec = useCallback(() => Math.max(live.current.endFrame / live.current.fps, live.current.scene.endSec), []);

  const draw = useCallback(() => {
    raf.current = 0;
    const c = canvas.current;
    const ctx = c?.getContext("2d", { alpha: false });
    if (!c || !ctx) return;
    const l = live.current;
    clampScroll(view.current, lengthSec(), l.scene.trackCount);
    drawTimeline(ctx, l.scene, view.current, l.frame / l.fps, dpr.current, palette.current, stats.current);
  }, [lengthSec]);
  const invalidate = useCallback(() => { if (!raf.current) raf.current = requestAnimationFrame(draw); }, [draw]);

  // Re-read the palette tokens and redraw when the theme changes.
  useEffect(() => onThemeChange(() => { if (canvas.current) { palette.current = paletteFromCss(canvas.current); invalidate(); } }), [invalidate]);

  // Size the backing store to the element at the real device pixel ratio.
  useEffect(() => {
    const c = canvas.current!;
    palette.current = paletteFromCss(c);
    const fit = () => {
      const r = c.getBoundingClientRect();
      dpr.current = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
      c.width = Math.round(w * dpr.current);
      c.height = Math.round(h * dpr.current);
      view.current.width = w;
      view.current.height = h;
      invalidate();
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(c);
    window.addEventListener("resize", fit); // devicePixelRatio changes (browser zoom, moving between screens) fire resize
    return () => { ro.disconnect(); window.removeEventListener("resize", fit); cancelAnimationFrame(raf.current); raf.current = 0; };
  }, [invalidate]);

  useEffect(() => { onReady?.({ view: view.current, invalidate, draw, stats: stats.current }); }, [onReady, invalidate, draw]);

  // Zoom from the slider/buttons: keep the playhead (or the viewport centre) steady.
  useEffect(() => {
    const v = view.current;
    if (Math.abs(v.pps - zoom) < 1e-6) return;
    const px = timeToX(v, frame / fps);
    zoomAt(v, zoom, px > GUTTER && px < v.width ? px : GUTTER + (v.width - GUTTER) / 2);
    invalidate();
  }, [zoom]);

  // Redraw on playhead/project change; follow the playhead while playing.
  useEffect(() => {
    const v = view.current;
    if (playing) {
      const px = timeToX(v, frame / fps);
      if (px > v.width - 48 || px < GUTTER) v.scrollX = Math.max(0, (frame / fps) * v.pps - 96);
    }
    invalidate();
  }, [frame, fps, playing, scene, invalidate]);

  // Wheel / trackpad pinch (non-passive so we can prevent page zoom and scroll).
  useEffect(() => {
    const c = canvas.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = view.current;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? v.height : 1;
      const dx = e.deltaX * unit, dy = e.deltaY * unit;
      if (e.ctrlKey || e.metaKey) {
        const x = e.clientX - c.getBoundingClientRect().left;
        zoomAt(v, v.pps * Math.exp(-dy * (e.ctrlKey && !e.metaKey ? 0.01 : 0.0025)), x);
        live.current.onZoom(v.pps);
      } else {
        const vertical = !e.shiftKey && live.current.scene.trackCount * LANE > v.height - RULER && Math.abs(dy) > Math.abs(dx);
        if (vertical) v.scrollY += dy;
        else v.scrollX += e.shiftKey ? dy || dx : dx || dy;
      }
      invalidate();
    };
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => c.removeEventListener("wheel", onWheel);
  }, [invalidate]);

  // Pointers: ruler scrubs; touch drags pan with momentum (tap seeks); two touches pinch-zoom; a mouse drag in the tracks scrubs.
  const ptr = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({ mode: "none" as "none" | "scrub" | "pan" | "pinch", sx: 0, sy: 0, moved: false, vx: 0, vy: 0, lastT: 0, dist: 0, fling: 0 });
  const local = (e: { clientX: number; clientY: number }) => { const r = canvas.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const seekAt = (x: number) => {
    const l = live.current;
    l.onFrame(clamp(Math.round(xToTime(view.current, x) * l.fps), 0, l.endFrame));
  };
  const stopFling = () => { cancelAnimationFrame(gesture.current.fling); gesture.current.fling = 0; };

  const onDown = (e: React.PointerEvent) => {
    stopFling();
    const c = canvas.current!;
    c.setPointerCapture(e.pointerId);
    const p = local(e);
    ptr.current.set(e.pointerId, p);
    const g = gesture.current;
    if (ptr.current.size === 2) {
      const [a, b] = [...ptr.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      g.mode = "pinch"; g.dist = Math.hypot(a.x - b.x, a.y - b.y) || 1; return;
    }
    const h = hitTest(live.current.scene, view.current, p.x, p.y);
    g.sx = p.x; g.sy = p.y; g.moved = false; g.vx = 0; g.vy = 0; g.lastT = e.timeStamp;
    if (e.pointerType === "touch" && h.kind !== "ruler") g.mode = "pan";
    else { g.mode = "scrub"; if (h.kind !== "gutter") seekAt(p.x); }
    c.focus({ preventScroll: true });
  };
  const onMove = (e: React.PointerEvent) => {
    if (!ptr.current.has(e.pointerId)) return;
    const prev = ptr.current.get(e.pointerId)!;
    const p = local(e);
    ptr.current.set(e.pointerId, p);
    const g = gesture.current, v = view.current;
    if (g.mode === "pinch" && ptr.current.size === 2) {
      const [a, b] = [...ptr.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      zoomAt(v, v.pps * (d / g.dist), (a.x + b.x) / 2);
      g.dist = d;
      live.current.onZoom(v.pps);
      invalidate();
    } else if (g.mode === "pan") {
      if (Math.hypot(p.x - g.sx, p.y - g.sy) > TAP_SLOP) g.moved = true;
      const dt = Math.max(1, e.timeStamp - g.lastT);
      v.scrollX -= p.x - prev.x; v.scrollY -= p.y - prev.y;
      g.vx = 0.8 * g.vx + 0.2 * (-(p.x - prev.x) / dt); g.vy = 0.8 * g.vy + 0.2 * (-(p.y - prev.y) / dt);
      g.lastT = e.timeStamp;
      invalidate();
    } else if (g.mode === "scrub") seekAt(p.x);
  };
  const onUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    ptr.current.delete(e.pointerId);
    if (g.mode === "pan" && ptr.current.size === 0) {
      if (!g.moved) seekAt(g.sx);
      else if (Math.hypot(g.vx, g.vy) > 0.05) {
        let last = performance.now();
        const step = (now: number) => {
          const dt = now - last; last = now;
          g.vx = decayVelocity(g.vx, dt); g.vy = decayVelocity(g.vy, dt);
          view.current.scrollX += g.vx * dt; view.current.scrollY += g.vy * dt;
          invalidate();
          g.fling = Math.hypot(g.vx, g.vy) > 0.02 ? requestAnimationFrame(step) : 0;
        };
        g.fling = requestAnimationFrame(step);
      }
    }
    if (ptr.current.size < 2 && g.mode === "pinch") g.mode = "none";
    if (ptr.current.size === 0) g.mode = "none";
  };

  const onKey = (e: KeyboardEvent) => {
    const l = live.current, v = view.current;
    const big = e.shiftKey ? l.fps : 1;
    let to: number | null = null;
    switch (e.key) {
      case "ArrowRight": to = l.frame + big; break;
      case "ArrowLeft": to = l.frame - big; break;
      case "Home": to = 0; break;
      case "End": to = l.endFrame; break;
      case "+": case "=": l.onZoom(clampPps(v.pps * 1.25)); break;
      case "-": case "_": l.onZoom(clampPps(v.pps / 1.25)); break;
      case "0": l.onZoom(fitPps(v, lengthSec())); break;
      case "PageDown": v.scrollX += (v.width - GUTTER) * 0.8; invalidate(); break;
      case "PageUp": v.scrollX -= (v.width - GUTTER) * 0.8; invalidate(); break;
      case "ArrowDown": v.scrollY += LANE; invalidate(); break;
      case "ArrowUp": v.scrollY -= LANE; invalidate(); break;
      default: return;
    }
    e.preventDefault();
    if (to !== null) l.onFrame(clamp(to, 0, l.endFrame));
  };

  return (
    <>
      <canvas
        ref={canvas}
        className="tl-canvas"
        data-testid="timeline-canvas"
        role="slider"
        tabIndex={0}
        aria-label={t("timeline.playhead")}
        aria-describedby="tl-summary"
        aria-valuemin={0}
        aria-valuemax={endFrame}
        aria-valuenow={frame}
        aria-valuetext={t("timeline.playheadText", { seconds: Math.round((frame / fps) * 100) / 100 })}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={onKey}
      />
      <p id="tl-summary" className="sr-only">{summary} {t("timeline.keys")}</p>
    </>
  );
}
