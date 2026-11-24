import type { Op } from "@app/engine-client";
import { useCallback, useEffect, useRef, type KeyboardEvent } from "react";
import { useI18n } from "../i18n";
import { onThemeChange } from "../theme/tokens";
import { DARK, drawTimeline, newOverlay, paletteFromCss, type DrawStats, type Overlay, type Palette } from "./draw";
import { describeClip, flagsOf, indicesOf, nearestClip, neighbour, type Say } from "./edit";
import { handleAt } from "./hit";
import { applySelect, IDLE, pointerDown, pointerMove, pointerUp, type Effects, type Gesture, type PEvent } from "./interact";
import type { MediaLayer } from "./media-layer";
import { canvasCommand, type Command } from "./shortcuts";
import { TICKS_PER_SECOND, type Scene } from "./scene";
import { clamp, clampPps, clampScroll, decayVelocity, fitPps, GUTTER, LANE, RULER, timeToX, xToTime, zoomAt, type View } from "./view";

export type CanvasHandle = { view: View; invalidate: () => void; draw: () => void; stats: DrawStats; el: HTMLCanvasElement };
const CLIP_LIST_MAX = 200;
const NO_SEL: ReadonlySet<string> = new Set();

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
  /** Selected clip ids (owned by the parent, which also applies edits). */
  selected?: ReadonlySet<string>;
  onSelect?: (ids: ReadonlySet<string>) => void;
  /** Edits to apply as one undo step; `say` describes them for the live region. */
  onEdit?: (ops: Op[], say: Say) => void;
  /** Keyboard edit commands the canvas cannot do alone (need the playhead or the engine). */
  onCommand?: (c: Command) => void;
  onAnnounce?: (say: Say) => void;
  /** Dev/benchmark hook: receives the live view and draw function. */
  onReady?: (h: CanvasHandle) => void;
  /** Real waveforms and filmstrips; without it the canvas draws placeholders. */
  media?: MediaLayer;
};

const TAP_SLOP = 6;

/** Canvas timeline: ruler, tracks, clips, playhead. State that changes every frame lives in refs, not React state. */
export function TimelineCanvas({ scene, fps, frame, endFrame, playing, zoom, onFrame, onZoom, summary, selected = NO_SEL, onSelect, onEdit, onCommand, onAnnounce, onReady, media }: Props) {
  const { t } = useI18n();
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef<View>({ pps: zoom, scrollX: 0, scrollY: 0, width: 300, height: 150 });
  const dpr = useRef(1);
  const palette = useRef<Palette>(DARK);
  const stats = useRef<DrawStats>({ clipsDrawn: 0, tracksDrawn: 0 });
  const raf = useRef(0);
  const live = useRef({ scene, frame, fps, endFrame, onFrame, onZoom, selected, onSelect, onEdit, onCommand, onAnnounce });
  live.current = { scene, frame, fps, endFrame, onFrame, onZoom, selected, onSelect, onEdit, onCommand, onAnnounce };
  const ui = useRef<Overlay>(newOverlay());
  const flags = useRef<Uint8Array>(new Uint8Array(0));
  const gest = useRef<Gesture>(IDLE);
  const appliedSel = useRef<ReadonlySet<string> | null>(null);
  const resetPreview = () => {
    const o = ui.current;
    o.ghosts = null; o.trimClip = -1; o.marquee = null;
    const f = flags.current;
    for (let i = 0; i < f.length; i++) if (f[i] === 2) f[i] = 1;
  };
  const lengthSec = useCallback(() => Math.max(live.current.endFrame / live.current.fps, live.current.scene.endSec), []);

  const draw = useCallback(() => {
    raf.current = 0;
    const c = canvas.current;
    const ctx = c?.getContext("2d", { alpha: false });
    if (!c || !ctx) return;
    const l = live.current;
    clampScroll(view.current, lengthSec(), l.scene.trackCount);
    c.dataset.pps = view.current.pps.toFixed(1); // test hook: the current zoom
    // Test/diagnostic hook: how much real media has landed (smoke asserts imported clips leave the placeholder state).
    if (media) { c.dataset.waveTiles = String(media.waveforms.stats.tilesRendered); c.dataset.thumbs = String(media.thumbs.stats.generated + media.thumbs.stats.fromCache); }
    drawTimeline(ctx, l.scene, view.current, l.frame / l.fps, dpr.current, palette.current, stats.current, ui.current, media);
  }, [lengthSec, media]);
  const invalidate = useCallback(() => { if (!raf.current) raf.current = requestAnimationFrame(draw); }, [draw]);

  // New waveform data or thumbnails: redraw.
  useEffect(() => { if (media) media.onChange = invalidate; }, [media, invalidate]);

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

  useEffect(() => { onReady?.({ view: view.current, invalidate, draw, stats: stats.current, el: canvas.current! }); }, [onReady, invalidate, draw]);

  // Per-clip selection flags for the painter and hit-testing; rebuilt when the selection or the scene changes (never per frame).
  const sceneSeen = useRef<Scene | null>(null);
  useEffect(() => {
    if (sceneSeen.current === scene && appliedSel.current === selected) return; // the canvas itself made this change and already updated the flags
    sceneSeen.current = scene;
    flags.current = flagsOf(scene, indicesOf(scene, selected));
    ui.current.selected = flags.current;
    appliedSel.current = selected;
    gest.current = IDLE;
    resetPreview();
    invalidate();
  }, [scene, selected, invalidate]);

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

  // Pointers. Editing gestures (select, move, trim, marquee, tap) run through the pure state machine in interact.ts; the canvas keeps
  // panning (touch drag), momentum, pinch-zoom and ruler scrubbing. A mouse drag on empty track space is a marquee; a tap seeks and deselects.
  const ptr = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({ mode: "none" as "none" | "scrub" | "pan" | "pinch" | "edit", sx: 0, sy: 0, moved: false, vx: 0, vy: 0, lastT: 0, dist: 0, fling: 0 });
  const local = (e: { clientX: number; clientY: number }) => { const r = canvas.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const seekAt = (x: number) => {
    const l = live.current;
    l.onFrame(clamp(Math.round(xToTime(view.current, x) * l.fps), 0, l.endFrame));
  };
  const stopFling = () => { cancelAnimationFrame(gesture.current.fling); gesture.current.fling = 0; };
  const ctxNow = () => ({ scene: live.current.scene, view: view.current, selected: live.current.selected, selFlags: flags.current });
  const pev = (e: React.PointerEvent, p: { x: number; y: number }): PEvent => ({ x: p.x, y: p.y, kind: e.pointerType === "touch" ? "touch" : e.pointerType === "pen" ? "pen" : "mouse", shift: e.shiftKey, additive: e.ctrlKey || e.metaKey });

  const setSelection = (next: ReadonlySet<string>) => {
    const l = live.current;
    l.selected = next;
    appliedSel.current = next;
    flags.current = flagsOf(l.scene, indicesOf(l.scene, next));
    ui.current.selected = flags.current;
    l.onSelect?.(next);
  };
  const applyFx = (fx: Effects) => {
    const l = live.current;
    if (fx.select) setSelection(applySelect(l.selected, fx.select, l.scene));
    if (fx.seek !== undefined) l.onFrame(clamp(Math.round(fx.seek * l.fps), 0, l.endFrame));
    if (fx.ops) l.onEdit?.(fx.ops, fx.say ?? { key: "timeline.say.edited" });
    else if (fx.say) l.onAnnounce?.(fx.say);
  };
  /** Mirrors the gesture into the painter's overlay. */
  const syncPreview = (g: Gesture) => {
    const o = ui.current, f = flags.current;
    o.ghosts = null; o.trimClip = -1; o.marquee = null;
    if (g.k === "move") {
      o.ghosts = g.sel; o.ghostDSec = g.delta / TICKS_PER_SECOND; o.ghostTrack = g.track !== g.from ? g.track : -1;
      for (const i of g.sel) f[i] = 2;
    } else if (g.k === "trim") {
      o.trimClip = g.clip; o.trimEnd = g.edge === "end"; o.trimSec = g.value / TICKS_PER_SECOND;
      f[g.clip] = 2;
    } else if (g.k === "marquee") o.marquee = { x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1 };
    invalidate();
  };
  const run = (r: { g: Gesture; fx: Effects }) => { gest.current = r.g; syncPreview(r.g); applyFx(r.fx); };

  const onDown = (e: React.PointerEvent) => {
    stopFling();
    const c = canvas.current!;
    try { c.setPointerCapture(e.pointerId); } catch { /* synthetic or already-ended pointer: keep working without capture */ }
    const p = local(e);
    ptr.current.set(e.pointerId, p);
    const g = gesture.current;
    if (ptr.current.size === 2) {
      const [a, b] = [...ptr.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      gest.current = IDLE; syncPreview(IDLE); // a second finger cancels any edit in progress
      g.mode = "pinch"; g.dist = Math.hypot(a.x - b.x, a.y - b.y) || 1; return;
    }
    g.sx = p.x; g.sy = p.y; g.moved = false; g.vx = 0; g.vy = 0; g.lastT = e.timeStamp;
    const r = pointerDown(ctxNow(), pev(e, p));
    g.mode = r.g.k === "scrub" ? "scrub" : r.g.k === "pan" ? "pan" : r.g.k === "idle" ? "none" : "edit";
    run(r);
    c.dataset.pointer = ""; // focus by pointer: no focus frame (keyboard focus shows it, see .tl-canvas:focus-visible)
    c.focus({ preventScroll: true });
  };
  const onMove = (e: React.PointerEvent) => {
    if (!ptr.current.has(e.pointerId)) {
      if (e.pointerType === "mouse") { // hover: show the resize cursor over any clip edge (a trim handle)
        const p = local(e);
        canvas.current!.style.cursor = handleAt(live.current.scene, view.current, flags.current, p.x, p.y, false, true) ? "ew-resize" : "";
      }
      return;
    }
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
    else if (g.mode === "edit") {
      const r = pointerMove(ctxNow(), gest.current, pev(e, p));
      run(r);
      if (r.g.k === "pan") { g.mode = "pan"; g.moved = true; g.vx = 0; g.vy = 0; g.lastT = e.timeStamp; }
    }
  };
  const onUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    ptr.current.delete(e.pointerId);
    if (g.mode === "edit" && ptr.current.size === 0) {
      const r = pointerUp(ctxNow(), gest.current, pev(e, local(e)));
      gest.current = IDLE; syncPreview(IDLE);
      applyFx(r.fx);
    } else if (g.mode === "pan" && ptr.current.size === 0) {
      if (g.moved && Math.hypot(g.vx, g.vy) > 0.05) {
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
  const onCancel = (e: React.PointerEvent) => {
    ptr.current.delete(e.pointerId);
    gest.current = IDLE; syncPreview(IDLE);
    if (ptr.current.size === 0) gesture.current.mode = "none";
  };

  /** Moves the selection to clip `j` and scrolls it into view. */
  const selectClip = (j: number) => {
    const l = live.current, v = view.current;
    setSelection(new Set([l.scene.id[j]!]));
    const x0 = timeToX(v, l.scene.start[j]!), x1 = timeToX(v, l.scene.end[j]!);
    if (x0 < GUTTER) v.scrollX += x0 - GUTTER - 24;
    else if (x1 > v.width) v.scrollX += Math.min(x1 - v.width + 24, x0 - GUTTER - 24);
    const y = RULER + l.scene.clipTrack[j]! * LANE - v.scrollY;
    if (y < RULER) v.scrollY += y - RULER; else if (y + LANE > v.height) v.scrollY += y + LANE - v.height;
    l.onAnnounce?.(describeClip(l.scene, j));
    invalidate();
  };

  const onKey = (e: KeyboardEvent) => {
    const l = live.current, v = view.current;
    const cmd = canvasCommand(e, l.selected.size > 0);
    if (cmd) {
      e.preventDefault();
      const sel = indicesOf(l.scene, l.selected);
      switch (cmd.c) {
        case "clear": if (l.selected.size) { setSelection(new Set()); l.onAnnounce?.({ key: "timeline.say.cleared" }); } break;
        case "selectAll": setSelection(new Set(l.scene.id)); l.onAnnounce?.({ key: "timeline.say.selectedCount", values: { count: l.scene.clipCount } }); break;
        case "playhead": l.onFrame(clamp(l.frame + cmd.frames, 0, l.endFrame)); break;
        case "pick": {
          const sec = l.frame / l.fps;
          for (let t = 0; t < l.scene.trackCount; t++) {
            const j = nearestClip(l.scene, t, sec);
            if (j >= 0) { selectClip(j); break; }
          }
          break;
        }
        case "go": {
          if (sel.length === 0) break;
          const j = neighbour(l.scene, cmd.dir === "left" || cmd.dir === "up" ? sel[0]! : sel[sel.length - 1]!, cmd.dir);
          selectClip(j);
          break;
        }
        default: l.onCommand?.(cmd);
      }
      return;
    }
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
        onPointerCancel={onCancel}
        onKeyDown={(e) => { delete e.currentTarget.dataset.pointer; onKey(e); }}
        onBlur={(e) => { delete e.currentTarget.dataset.pointer; }}
      />
      <p id="tl-summary" className="sr-only">{summary} {t("timeline.keys")}</p>
      {/* Text alternative to the canvas: every clip (capped) in reading order, so a screen reader can browse what the picture shows. */}
      {scene.clipCount > 0 && (
        <ul className="sr-only" aria-label={t("timeline.clipList")} data-testid="tl-clip-list">
          {Array.from({ length: Math.min(scene.clipCount, CLIP_LIST_MAX) }, (_, i) => {
            const say = describeClip(scene, i);
            return <li key={scene.id[i]}>{t(say.key, say.values)}{selected.has(scene.id[i]!) ? ` ${t("timeline.clipSelected")}` : ""}</li>;
          })}
        </ul>
      )}
    </>
  );
}
