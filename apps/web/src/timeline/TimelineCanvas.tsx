import type { Op } from "@app/engine-client";
import { memo, useCallback, useDeferredValue, useEffect, useRef, type KeyboardEvent } from "react";
import { useI18n } from "../i18n";
import { onThemeChange } from "../theme/tokens";
import { DARK, drawBubble, drawPlayheadStrip, drawTimeline, HEAD_W, newOverlay, paletteFromCss, type Bubble, type DrawStats, type Overlay, type Palette } from "./draw";
import { describeClip, flagsOf, indicesOf, nearestClip, neighbour, type Say } from "./edit";
import { handleAt, hitTest, trackAtY } from "./hit";
import { headerPart } from "./header";
import { BIN_DRAG_TYPE } from "../media/sources";
import { snapDrop, SNAP_PX } from "./arrange";
import { applySelect, edgeSpeed, IDLE, longPress, markPreview, sameLayout, pointerDown, pointerMove, pointerUp, scrolled, scrollsAtEdge, type Effects, type Gesture, type PEvent } from "./interact";
import type { MediaLayer } from "./media-layer";
import { canvasCommand, isModifierKey, type Command } from "./shortcuts";
import { markerAt } from "./markers";
import { COMMAND_EVENT } from "../commands/palette";
import { TICKS_PER_SECOND, type Scene } from "./scene";
import type { Tool } from "./ripple";
import { clamp, clampPps, clampScroll, decayVelocity, fitPps, GUTTER_COMPACT, GUTTER_WIDE, gut, LANE, RULER, timeToX, viewForRange, wheelZoomFactor, xToTime, zoomAt, zoomKeeping, type View } from "./view";
import { zoomStore } from "./zoomStore";
import { timecode } from "../timecode";

export type CanvasHandle = { view: View; invalidate: () => void; draw: () => void; stats: DrawStats; el: HTMLCanvasElement; /** Called after a frame whose zoom, scroll or width changed (the overview bar follows it). */ onView?: () => void };
/** Where the playhead (whole frames) comes from when it is not a prop: read on demand and subscribed to, so the timeline's parent does not re-render on every tick (P-3). */
export type PlayheadSource = { get(): number; subscribe(cb: () => void): () => void };
const CLIP_LIST_MAX = 200;
const NO_SEL: ReadonlySet<string> = new Set();

type Props = {
  scene: Scene;
  fps: number;
  /** Playhead, whole frames (a static value: tests and benchmarks). `playhead` replaces it with a live source. */
  frame?: number;
  playhead?: PlayheadSource;
  endFrame: number;
  playing: boolean;
  onFrame: (f: number) => void;
  summary: string;
  /** Selected clip ids (owned by the parent, which also applies edits). */
  selected?: ReadonlySet<string>;
  onSelect?: (ids: ReadonlySet<string>) => void;
  /** Edits to apply as one undo step; `say` describes them for the live region. */
  onEdit?: (ops: Op[], say: Say) => void;
  /** Keyboard edit commands the canvas cannot do alone (need the playhead or the engine). */
  onCommand?: (c: Command) => void;
  onAnnounce?: (say: Say) => void;
  /** A short visible message (status line), for refusals that must be seen. */
  onNotice?: (say: Say) => void;
  /** Dev/benchmark hook: receives the live view and draw function. */
  onReady?: (h: CanvasHandle) => void;
  /** Real waveforms and filmstrips; without it the canvas draws placeholders. */
  media?: MediaLayer;
  /** A media-bin card was dropped on the canvas: put it on the timeline at this tick. */
  onDropMedia?: (id: string, tick: number, track?: string) => void;
  /** A track header was tapped (or right-clicked): open its menu. `at` is the header's rectangle in viewport pixels. */
  onTrackMenu?: (track: number, at: DOMRect) => void;
  /** A marker was long-pressed, right-clicked, or tapped while the playhead was on it: open its menu. `at` is its flag's rectangle in viewport pixels. */
  onMarkerMenu?: (id: string, at: DOMRect) => void;
  /** Right-click (or the context-menu key) on a clip: open its menu. `at` is where the pointer was, or the clip's rectangle, in viewport pixels. */
  onClipMenu?: (at: DOMRect) => void;
  /** The edit tool picked in the toolbar (select when absent). */
  tool?: Tool;
  /** A pointer went down on this track (its id): paste targets it. */
  onLane?: (track: string) => void;
};

const TAP_SLOP = 8;
/** Cursor for a gesture in progress (T-05): a carried clip is grabbed, an edge or the ruler scrub is a horizontal drag, a marquee crosses. */
const cursorFor = (g: Gesture): string => g.k === "move" || g.k === "tdrag" || (g.k === "marker" && g.moved) ? "grabbing" : g.k === "trim" || g.k === "tool" || g.k === "scrub" ? "ew-resize" : g.k === "marquee" ? "crosshair" : "";

/** Canvas timeline: ruler, tracks, clips, playhead. State that changes every frame lives in refs, not React state. */
export function TimelineCanvas({ scene, fps, frame: frameProp = 0, playhead, endFrame, playing, onFrame, summary, selected = NO_SEL, onSelect, onEdit, onCommand, onAnnounce, onNotice, onReady, media, onDropMedia, onTrackMenu, onMarkerMenu, onClipMenu, tool = "select", onLane }: Props) {
  const { t } = useI18n();
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef<View>({ pps: zoomStore.get(), scrollX: 0, scrollY: 0, width: 300, height: 150 });
  const dpr = useRef(1);
  const palette = useRef<Palette>(DARK);
  const stats = useRef<DrawStats>({ clipsDrawn: 0, tracksDrawn: 0 });
  const raf = useRef(0);
  const live = useRef({ scene, fps, endFrame, playing, onFrame, selected, onSelect, onEdit, onCommand, onAnnounce, onNotice, onTrackMenu, onMarkerMenu, onClipMenu, tool, onLane });
  live.current = { scene, fps, endFrame, playing, onFrame, selected, onSelect, onEdit, onCommand, onAnnounce, onNotice, onTrackMenu, onMarkerMenu, onClipMenu, tool, onLane };
  /** The playhead in whole frames, kept current by the subscription below (no React render per tick). */
  const fr = useRef(playhead ? playhead.get() : frameProp);
  const firstFrame = useRef(fr.current);
  const pcv = useRef<HTMLCanvasElement>(null); // the time bubble's layer: a transparent canvas over the timeline, shown only while a bubble is
  const hcv = useRef<HTMLCanvasElement>(null); // the playhead: a thin strip painted once and moved with a CSS transform (it never repaints while panning, zooming or playing)
  const hclip = useRef<HTMLDivElement>(null); // clips the strip at the track-header column
  const headSig = useRef({ h: 0, dpr: 0, pal: null as Palette | null, tx: NaN, vis: true, left: -1, bubble: false, bw: 0, bh: 0 });
  const bubble = useRef<Bubble | null>(null);
  const phRaf = useRef(0);
  const ui = useRef<Overlay>(newOverlay());
  const flags = useRef<Uint8Array>(new Uint8Array(0));
  const gest = useRef<Gesture>(IDLE);
  const appliedSel = useRef<ReadonlySet<string> | null>(null);
  const resetPreview = () => {
    const o = ui.current;
    o.ghosts = null; o.trimClip = -1; o.trimRight = -1; o.marquee = null; o.guideSec = null;
    const f = flags.current;
    for (let i = 0; i < f.length; i++) if (f[i] === 2) f[i] = 1;
  };
  const seen = useRef({ pps: 0, x: -1, w: 0 });
  const handle = useRef<CanvasHandle | null>(null);
  const lengthSec = useCallback(() => Math.max(live.current.endFrame / live.current.fps, live.current.scene.endSec), []);

  const paintPlayhead = useCallback(() => {
    const h = hcv.current, clip = hclip.current, sg = headSig.current, v = view.current;
    if (!h || !clip) return;
    const g = gut(v), d = dpr.current;
    if (sg.left !== g) { sg.left = g; clip.style.left = `${g}px`; }
    if (sg.h !== v.height || sg.dpr !== d || sg.pal !== palette.current) { // repaint the strip only when what it shows changed
      sg.h = v.height; sg.dpr = d; sg.pal = palette.current;
      const w = Math.round(HEAD_W * d), ht = Math.round(v.height * d);
      if (h.width !== w || h.height !== ht) { h.width = w; h.height = ht; }
      h.style.height = `${v.height}px`;
      const ctx = h.getContext("2d");
      if (ctx) drawPlayheadStrip(ctx, v.height, d, palette.current);
    }
    const px = timeToX(v, fr.current / live.current.fps);
    const vis = px >= g - 8 && px <= v.width + 8;
    if (vis !== sg.vis) { sg.vis = vis; h.style.visibility = vis ? "visible" : "hidden"; }
    if (vis) {
      const tx = Math.round((Math.round(px * 2) / 2 - g - HEAD_W / 2) * d) / d; // whole device pixels: the layer is moved, never resampled
      if (tx !== sg.tx) { sg.tx = tx; h.style.transform = `translate3d(${tx}px,0,0)`; }
    }
    const b = bubble.current, bc = pcv.current;
    if (bc && (b || sg.bubble)) { // the time bubble: its own transparent layer, painted only while there is one (and once more to clear it)
      sg.bubble = b !== null;
      if (b) {
        const w = Math.round(v.width * d), ht = Math.round(v.height * d);
        if (bc.width !== w || bc.height !== ht) { bc.width = w; bc.height = ht; }
      }
      bc.style.display = b ? "block" : "none";
      const ctx = bc.getContext("2d");
      if (ctx) drawBubble(ctx, v, d, palette.current, b);
    }
  }, []);
  /** Touch pan: the finger's movement since the last frame, applied once at the start of the next draw (P-16: one pan per frame, however many events arrived). */
  const panPend = useRef({ dx: 0, dy: 0 });
  const flushPan = useCallback(() => { const q = panPend.current; if (q.dx !== 0 || q.dy !== 0) { view.current.scrollX += q.dx; view.current.scrollY += q.dy; q.dx = 0; q.dy = 0; } }, []);
  const draw = useCallback(() => {
    raf.current = 0;
    flushPan();
    const c = canvas.current;
    const ctx = c?.getContext("2d", { alpha: false });
    if (!c || !ctx) return;
    const l = live.current;
    clampScroll(view.current, lengthSec(), l.scene.trackCount);
    c.dataset.pps = view.current.pps.toFixed(view.current.pps < 10 ? 3 : 1); // test hook: the current zoom
    c.dataset.gutter = String(gut(view.current)); // test hook: width of the track-header column
    c.dataset.scrollx = String(Math.round(view.current.scrollX)); // test hook: horizontal scroll (edge auto-scroll)
    // Test/diagnostic hook: how much real media has landed (smoke asserts imported clips leave the placeholder state).
    if (media) { c.dataset.waveTiles = String(media.waveforms.stats.tilesRendered); c.dataset.thumbs = String(media.thumbs.stats.generated + media.thumbs.stats.fromCache); }
    drawTimeline(ctx, l.scene, view.current, fr.current / l.fps, dpr.current, palette.current, stats.current, ui.current, media);
    paintPlayhead();
    const v = view.current, sig = seen.current;
    if (sig.pps !== v.pps || sig.x !== v.scrollX || sig.w !== v.width) { sig.pps = v.pps; sig.x = v.scrollX; sig.w = v.width; handle.current?.onView?.(); }
  }, [lengthSec, media, paintPlayhead, flushPan]);
  const invalidate = useCallback(() => { if (!raf.current) raf.current = requestAnimationFrame(draw); }, [draw]);
  /** Only the playhead layer changed (playback, the time bubble): the clips, ruler and thumbnails are not repainted. */
  const invalidatePlayhead = useCallback(() => {
    if (raf.current || phRaf.current) return; // a full draw is queued: it paints the playhead too
    phRaf.current = requestAnimationFrame(() => { phRaf.current = 0; paintPlayhead(); });
  }, [paintPlayhead]);

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
      const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
      // Phones and touch screens get compact, whole-header-is-a-button track headers, and a backing store capped at 2x: the 3x raster of a full-width canvas is
      // what made busy timelines drop frames on phones, and the difference is not visible on a canvas of flat fills.
      const compact = w < 560 || (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches);
      dpr.current = Math.min(window.devicePixelRatio || 1, compact ? 2 : 4);
      view.current.compact = compact;
      view.current.gutter = compact ? GUTTER_COMPACT : GUTTER_WIDE;
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
    return () => { ro.disconnect(); window.removeEventListener("resize", fit); cancelAnimationFrame(raf.current); raf.current = 0; cancelAnimationFrame(phRaf.current); phRaf.current = 0; };
  }, [invalidate]);

  useEffect(() => {
    const h: CanvasHandle = { view: view.current, invalidate, draw, stats: stats.current, el: canvas.current!, onView: handle.current?.onView };
    handle.current = h;
    onReady?.(h);
    invalidate();
  }, [onReady, invalidate, draw]);

  // Per-clip selection flags for the painter and hit-testing; rebuilt when the selection or the scene changes (never per frame).
  const sceneSeen = useRef<Scene | null>(null);
  useEffect(() => {
    if (sceneSeen.current === scene && appliedSel.current === selected) return; // the canvas itself made this change and already updated the flags
    // The same layout rebuilt mid-gesture (a thumbnail, a save): keep the drag going instead of dropping it.
    if (appliedSel.current === selected && sceneSeen.current !== null && sameLayout(sceneSeen.current, scene)) { sceneSeen.current = scene; return; }
    sceneSeen.current = scene;
    flags.current = flagsOf(scene, indicesOf(scene, selected));
    ui.current.selected = flags.current;
    appliedSel.current = selected;
    gest.current = IDLE;
    resetPreview();
    invalidate();
  }, [scene, selected, invalidate]);

  // Zoom from the slider/buttons (the zoom store): keep the playhead (or the viewport centre) steady.
  useEffect(() => zoomStore.subscribe(() => {
    const v = view.current, z = zoomStore.get();
    if (Math.abs(v.pps - z) < 1e-6) return; // the canvas itself made this change
    zoomKeeping(v, z, fr.current / live.current.fps);
    invalidate();
  }), [invalidate]);
  useEffect(() => { // a zoom set before this canvas existed (an auto-fit that ran first)
    const v = view.current, z = zoomStore.get();
    if (Math.abs(v.pps - z) >= 1e-6) { zoomKeeping(v, z, fr.current / live.current.fps); invalidate(); }
  }, [invalidate]);

  // The playhead: a live source is subscribed to (the parent does not re-render per tick); a static `frame` prop is followed too. While playing the view follows it;
  // only the playhead layer repaints unless the view scrolls. The slider's value for assistive tech is refreshed at most twice a second during playback.
  const ariaAt = useRef(0);
  const tRef = useRef(t);
  tRef.current = t;
  const setAria = useCallback((f: number, force: boolean) => {
    const c = canvas.current, now = performance.now();
    if (!c || (!force && live.current.playing && now - ariaAt.current < 500)) return;
    ariaAt.current = now;
    c.setAttribute("aria-valuenow", String(f));
    c.setAttribute("aria-valuetext", tRef.current("timeline.playheadText", { seconds: Math.round((f / live.current.fps) * 100) / 100 }));
  }, []);
  const moved = useCallback((f: number) => {
    if (fr.current === f && ariaAt.current !== 0) return;
    fr.current = f;
    const v = view.current, l = live.current;
    setAria(f, !l.playing);
    if (gesture.current.mode === "scrub") bubble.current = { sec: f / l.fps, text: timecode(f, l.fps) };
    if (l.playing) {
      const px = timeToX(v, f / l.fps);
      if (px > v.width - 48 || px < gut(v)) { v.scrollX = Math.max(0, (f / l.fps) * v.pps - 96); invalidate(); return; }
      invalidatePlayhead();
    } else invalidate(); // a seek or scrub: the ruler leaves the label under the head out
  }, [invalidate, invalidatePlayhead, setAria]);
  useEffect(() => {
    if (!playhead) { moved(frameProp); return; }
    const sync = () => moved(playhead.get());
    sync();
    return playhead.subscribe(sync);
  }, [playhead, frameProp, moved]);
  useEffect(() => { invalidate(); }, [fps, playing, scene, invalidate]);

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
        zoomAt(v, v.pps * wheelZoomFactor(dy, e.ctrlKey && !e.metaKey), x);
        zoomStore.set(v.pps, "user");
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
  const gesture = useRef({ mode: "none" as "none" | "scrub" | "pan" | "pinch" | "edit", sx: 0, sy: 0, moved: false, vx: 0, vy: 0, lastT: 0, dist: 0, cx: 0, fling: 0 });
  const local = (e: { clientX: number; clientY: number }) => { const r = canvas.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const seekAt = (x: number) => {
    const l = live.current;
    l.onFrame(clamp(Math.round(xToTime(view.current, x) * l.fps), 0, l.endFrame));
  };
  const stopFling = () => { cancelAnimationFrame(gesture.current.fling); gesture.current.fling = 0; };
  const ctxNow = () => ({ scene: live.current.scene, view: view.current, selected: live.current.selected, selFlags: flags.current, tool: live.current.tool, playhead: Math.round((fr.current / live.current.fps) * TICKS_PER_SECOND) });
  /** Drag from the media bin: a guide line shows where the card will land (snapped), the drop puts it there. */
  const dropAt = (e: React.DragEvent) => {
    const l = live.current;
    const x = e.clientX - canvas.current!.getBoundingClientRect().left;
    const raw = Math.max(0, xToTime(view.current, x)) * TICKS_PER_SECOND;
    const row = trackAtY(l.scene, view.current, e.clientY - canvas.current!.getBoundingClientRect().top);
    const ft = TICKS_PER_SECOND / l.fps;
    return { ...snapDrop(l.scene, raw, Math.round((fr.current / l.fps) * TICKS_PER_SECOND), (SNAP_PX / view.current.pps) * TICKS_PER_SECOND, ft), row };
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!onDropMedia || !e.dataTransfer.types.includes(BIN_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const d = dropAt(e);
    ui.current.guideSec = d.delta / TICKS_PER_SECOND;
    ui.current.lane = d.row;
    invalidate();
  };
  const onDragLeave = () => { ui.current.guideSec = null; ui.current.lane = -1; invalidate(); };
  const onDrop = (e: React.DragEvent) => {
    const id = e.dataTransfer.getData(BIN_DRAG_TYPE);
    if (!onDropMedia || !id) return;
    e.preventDefault();
    e.stopPropagation();
    const d = dropAt(e);
    ui.current.guideSec = null; ui.current.lane = -1; invalidate();
    onDropMedia(id, Math.round(d.delta), d.row >= 0 ? live.current.scene.trackId[d.row] : undefined);
  };
  const hold = useRef(0);
  const stopHold = () => { clearTimeout(hold.current); hold.current = 0; };
  const pev = (e: React.PointerEvent, p: { x: number; y: number }): PEvent => ({ x: p.x, y: p.y, kind: e.pointerType === "touch" ? "touch" : e.pointerType === "pen" ? "pen" : "mouse", shift: e.shiftKey, additive: e.ctrlKey || e.metaKey, alt: e.altKey });

  const setSelection = (next: ReadonlySet<string>) => {
    const l = live.current;
    l.selected = next;
    appliedSel.current = next;
    flags.current = flagsOf(l.scene, indicesOf(l.scene, next));
    ui.current.selected = flags.current;
    l.onSelect?.(next);
  };
  /** The header of row `t` in viewport pixels (menu anchor). */
  const headerRect = (t: number) => {
    const r = canvas.current!.getBoundingClientRect(), v = view.current;
    return new DOMRect(r.left, r.top + RULER + t * LANE - v.scrollY, gut(v), LANE);
  };
  /** The flag of marker `id` in viewport pixels (menu anchor). */
  const markerRect = (id: string) => {
    const r = canvas.current!.getBoundingClientRect(), v = view.current, m = live.current.scene.markers.find((x) => x.id === id);
    return new DOMRect(r.left + (m ? timeToX(v, m.sec) : gut(v)) - 12, r.top, 24, RULER);
  };
  const applyFx = (fx: Effects) => {
    const l = live.current;
    if (fx.select) setSelection(applySelect(l.selected, fx.select, l.scene));
    if (fx.seek !== undefined) l.onFrame(clamp(Math.round(fx.seek * l.fps), 0, l.endFrame));
    if (fx.menu !== undefined) l.onTrackMenu?.(fx.menu, headerRect(fx.menu));
    if (fx.markerMenu !== undefined) l.onMarkerMenu?.(fx.markerMenu, markerRect(fx.markerMenu));
    if (fx.ops) l.onEdit?.(fx.ops, fx.say ?? { key: "timeline.say.edited" });
    else if (fx.say) { l.onAnnounce?.(fx.say); if (fx.visible) l.onNotice?.(fx.say); }
  };
  /** Mirrors the gesture into the painter's overlay. */
  const syncPreview = (g: Gesture) => {
    const o = ui.current;
    o.ghosts = null; o.ghostTracks = null; o.ghostLabel = null; o.lane = -1; o.trimClip = -1; o.trimRight = -1; o.marquee = null; o.guideSec = null; o.trackDrag = null; o.markerDrag = g.k === "marker" && g.moved ? { id: g.id, sec: g.value / TICKS_PER_SECOND } : null;
    markPreview(flags.current, g);
    if (g.k === "move") {
      o.ghosts = g.sel; o.ghostDSec = g.delta / TICKS_PER_SECOND; o.ghostTracks = g.to; o.lane = g.mv ? g.track : -1;
      o.guideSec = g.guide != null ? g.guide / TICKS_PER_SECOND : null;
    } else if (g.k === "trim") {
      o.trimClip = g.clip; o.trimEnd = g.edge === "end"; o.trimSec = g.value / TICKS_PER_SECOND;
    } else if (g.k === "tool") {
      const sc = live.current.scene, i = g.clip, d = g.delta / TICKS_PER_SECOND;
      if (g.tool === "ripple") { o.trimClip = i; o.trimEnd = g.edge === "end"; o.trimSec = (g.edge === "end" ? sc.end[i]! : sc.start[i]!) + d; }
      else if (g.tool === "roll") {
        const [l, r] = g.cuts.find((x) => x[0] === g.clip) ?? g.cuts[0]!;
        o.guideSec = sc.start[r]! + d;
        if (g.seam) { o.trimClip = l; o.trimEnd = true; o.trimSec = o.guideSec; o.trimRight = r; } // the two-sided ghost of a seam drag (#105)
      }
      else { o.ghosts = [i]; o.ghostDSec = g.tool === "slide" ? d : 0; o.ghostLabel = t(g.tool === "slide" ? "timeline.tool.slideLabel" : "timeline.tool.slipLabel", { amount: `${d < 0 ? "−" : "+"}${Math.abs(d).toFixed(2)}` }); }
    } else if (g.k === "marquee") o.marquee = { x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1 };
    else if (g.k === "tdrag") o.trackDrag = { from: g.from, to: g.to, y: g.y };
    // The time bubble (T-06): where a carried clip's start or a trimmed edge will land, or the playhead while scrubbing the ruler.
    const fps = live.current.fps;
    let sec = -1;
    if (g.k === "move" && g.sel.length > 0) sec = live.current.scene.start[g.sel[0]!]! + g.delta / TICKS_PER_SECOND;
    else if (g.k === "trim") sec = g.value / TICKS_PER_SECOND;
    else if (g.k === "scrub") sec = fr.current / fps;
    bubble.current = sec >= 0 ? { sec, text: timecode(Math.round(sec * fps), fps) } : null;
    setCursor(cursorFor(g));
    invalidate();
  };
  const setCursor = (c: string) => { const el = canvas.current; if (el && el.style.cursor !== c) el.style.cursor = c; };
  const run = (r: { g: Gesture; fx: Effects }) => { gest.current = r.g; syncPreview(r.g); applyFx(r.fx); };

  // Edge auto-scroll: while an edit gesture is held near an edge of the canvas the view scrolls (and the drag follows), faster the closer to the edge.
  const lastEv = useRef<PEvent | null>(null);
  const edgeRaf = useRef(0);
  const edgeStep = (prev: number) => (now: number) => {
    edgeRaf.current = 0;
    const ev = lastEv.current, v = view.current;
    if (!ev || gesture.current.mode !== "edit" || !scrollsAtEdge(gest.current)) return;
    const dt = Math.min(64, now - prev) / 1000;
    const sx = edgeSpeed(ev.x, gut(v), v.width), sy = edgeSpeed(ev.y, RULER, v.height);
    if (sx !== 0 || sy !== 0) {
      const [x0, y0] = [v.scrollX, v.scrollY];
      v.scrollX += sx * dt; v.scrollY += sy * dt;
      clampScroll(v, lengthSec(), live.current.scene.trackCount);
      const [dx, dy] = [v.scrollX - x0, v.scrollY - y0];
      if (dx !== 0 || dy !== 0) {
        gest.current = scrolled(gest.current, dx, dy);
        run(pointerMove(ctxNow(), gest.current, ev));
        invalidate();
      }
    }
    if (sx !== 0 || sy !== 0) edgeRaf.current = requestAnimationFrame(edgeStep(now));
  };
  const kickEdge = (ev: PEvent) => {
    lastEv.current = ev;
    if (!edgeRaf.current && scrollsAtEdge(gest.current) && (edgeSpeed(ev.x, gut(view.current), view.current.width) !== 0 || edgeSpeed(ev.y, RULER, view.current.height) !== 0))
      edgeRaf.current = requestAnimationFrame(edgeStep(performance.now()));
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return; // a right click opens the track menu (contextmenu), it does not press
    stopFling(); flushPan();
    const c = canvas.current!;
    try { c.setPointerCapture(e.pointerId); } catch { /* synthetic or already-ended pointer: keep working without capture */ }
    const p = local(e);
    ptr.current.set(e.pointerId, p);
    const g = gesture.current;
    const lane = trackAtY(live.current.scene, view.current, p.y);
    if (lane >= 0) live.current.onLane?.(live.current.scene.trackId[lane]!);
    if (ptr.current.size === 2) {
      const [a, b] = [...ptr.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      gest.current = IDLE; syncPreview(IDLE); // a second finger cancels any edit in progress
      g.mode = "pinch"; g.dist = Math.hypot(a.x - b.x, a.y - b.y) || 1; g.cx = (a.x + b.x) / 2; return;
    }
    g.sx = p.x; g.sy = p.y; g.moved = false; g.vx = 0; g.vy = 0; g.lastT = e.timeStamp;
    const r = pointerDown(ctxNow(), pev(e, p));
    g.mode = r.g.k === "scrub" ? "scrub" : r.g.k === "pan" ? "pan" : r.g.k === "idle" ? "none" : "edit";
    run(r);
    stopHold();
    if (e.pointerType === "touch" && ((r.g.k === "press" && r.g.then === "pan") || r.g.k === "hdr")) {
      // Press and hold on a clip picks it up (a short buzz where the device has one); dragging then moves it instead of panning.
      hold.current = window.setTimeout(() => {
        hold.current = 0;
        const lp = longPress(ctxNow(), gest.current);
        if (lp) { run(lp); try { navigator.vibrate?.(12); } catch { /* no haptics */ } }
      }, 380);
    }
    c.dataset.pointer = ""; // focus by pointer: no focus frame (keyboard focus shows it, see .tl-canvas:focus-visible)
    c.focus({ preventScroll: true });
  };
  const onMove = (e: React.PointerEvent) => {
    if (!ptr.current.has(e.pointerId)) {
      if (e.pointerType === "mouse") { // hover: show the resize cursor over any clip edge (a trim handle)
        const p = local(e);
        const sc = live.current.scene, v = view.current;
        const t = trackAtY(sc, v, p.y);
        const part = t >= 0 && p.x < gut(v) ? headerPart(v, p.x, p.y - RULER + v.scrollY - t * LANE, sc.trackKind[t]!) : null;
        const body = !part && t >= 0 && p.x >= gut(v) && !handleAt(sc, v, flags.current, p.x, p.y, false, true) && hitTest(sc, v, p.x, p.y, 0).kind === "clip";
        setCursor(part ? (part === "name" ? "grab" : "pointer") : p.y < RULER && p.x >= gut(v) ? "pointer" : handleAt(sc, v, flags.current, p.x, p.y, false, true) ? "ew-resize" : live.current.tool !== "select" ? "crosshair" : body ? "grab" : "");
      }
      return;
    }
    const prev = ptr.current.get(e.pointerId)!;
    const p = local(e);
    ptr.current.set(e.pointerId, p);
    const g = gesture.current, v = view.current;
    if (hold.current && Math.hypot(p.x - g.sx, p.y - g.sy) > TAP_SLOP) stopHold();
    if (g.mode === "pinch" && ptr.current.size === 2) {
      const [a, b] = [...ptr.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const cx = (a.x + b.x) / 2;
      v.scrollX -= cx - g.cx; // two-finger pan: the content follows the centre of the fingers, then the zoom is taken around it
      zoomAt(v, v.pps * (d / g.dist), cx);
      g.dist = d; g.cx = cx;
      zoomStore.set(v.pps, "user");
      invalidate();
    } else if (g.mode === "pan") {
      if (Math.hypot(p.x - g.sx, p.y - g.sy) > TAP_SLOP) g.moved = true;
      // The events the browser folded into this one (touch can report faster than frames): each feeds the velocity, the position is the last of them; the scroll itself is applied once per frame.
      const co = e.nativeEvent.getCoalescedEvents?.();
      const sub = co && co.length > 1 ? co : [e.nativeEvent];
      const r = canvas.current!.getBoundingClientRect();
      let ax = prev.x, ay = prev.y, at = g.lastT;
      for (const s of sub) {
        const sx = s.clientX - r.left, sy = s.clientY - r.top, dt = Math.max(1, s.timeStamp - at);
        g.vx = 0.8 * g.vx + 0.2 * (-(sx - ax) / dt); g.vy = 0.8 * g.vy + 0.2 * (-(sy - ay) / dt);
        ax = sx; ay = sy; at = s.timeStamp;
      }
      panPend.current.dx -= p.x - prev.x; panPend.current.dy -= p.y - prev.y;
      g.lastT = e.timeStamp;
      invalidate();
    } else if (g.mode === "scrub") seekAt(p.x);
    else if (g.mode === "edit") {
      const pe = pev(e, p);
      const r = pointerMove(ctxNow(), gest.current, pe);
      run(r);
      kickEdge(pe);
      if (r.g.k === "pan") { g.mode = "pan"; g.moved = true; g.vx = 0; g.vy = 0; g.lastT = e.timeStamp; }
    }
  };
  const onUp = (e: React.PointerEvent) => {
    stopHold();
    const g = gesture.current;
    flushPan();
    ptr.current.delete(e.pointerId);
    if (g.mode === "scrub") { bubble.current = null; setCursor(""); invalidatePlayhead(); }
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
    stopHold(); flushPan();
    ptr.current.delete(e.pointerId);
    if (gesture.current.mode === "scrub") { bubble.current = null; setCursor(""); invalidatePlayhead(); }
    gest.current = IDLE; syncPreview(IDLE);
    if (ptr.current.size === 0) gesture.current.mode = "none";
  };

  /** Moves the selection to clip `j` and scrolls it into view. */
  const selectClip = (j: number) => {
    const l = live.current, v = view.current;
    setSelection(new Set([l.scene.id[j]!]));
    const x0 = timeToX(v, l.scene.start[j]!), x1 = timeToX(v, l.scene.end[j]!);
    if (x0 < gut(v)) v.scrollX += x0 - gut(v) - 24;
    else if (x1 > v.width) v.scrollX += Math.min(x1 - v.width + 24, x0 - gut(v) - 24);
    const y = RULER + l.scene.clipTrack[j]! * LANE - v.scrollY;
    if (y < RULER) v.scrollY += y - RULER; else if (y + LANE > v.height) v.scrollY += y + LANE - v.height;
    l.onAnnounce?.(describeClip(l.scene, j));
    invalidate();
  };

  /** Runs a command: the ones that need the view or the selection here, the rest handed to the timeline. Used by the keys and by the command palette. */
  const exec = (cmd: Command) => {
    const l = live.current, v = view.current;
    {
      const sel = indicesOf(l.scene, l.selected);
      switch (cmd.c) {
        case "clear": if (l.tool !== "select") { l.onCommand?.({ c: "tool", tool: "select" }); break; } if (l.selected.size) { setSelection(new Set()); l.onAnnounce?.({ key: "timeline.say.cleared" }); } break;
        case "selectAll": setSelection(new Set(l.scene.id)); l.onAnnounce?.({ key: "timeline.say.selectedCount", values: { count: l.scene.clipCount } }); break;
        case "markerEdit": {
          const m = l.scene.markers.find((x) => x.ticks === Math.round((fr.current / l.fps) * TICKS_PER_SECOND));
          if (m) l.onMarkerMenu?.(m.id, markerRect(m.id)); else l.onNotice?.({ key: "timeline.say.marker.none" });
          break;
        }
        case "playhead": l.onFrame(clamp(fr.current + cmd.frames, 0, l.endFrame)); break;
        case "pick": {
          const sec = fr.current / l.fps;
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
        case "step": {
          const to = cmd.to === "start" ? 0 : cmd.to === "end" ? l.endFrame : fr.current + (cmd.frames ?? 0) + (cmd.seconds ?? 0) * l.fps;
          l.onFrame(clamp(to, 0, l.endFrame));
          break;
        }
        case "zoom": {
          if (cmd.how === "selection") {
            if (sel.length === 0) { l.onNotice?.({ key: "timeline.say.zoomNoSelection" }); break; }
            let a = Infinity, b = 0;
            for (const j of sel) { a = Math.min(a, l.scene.start[j]!); b = Math.max(b, l.scene.end[j]!); }
            const nv = viewForRange(v, a, b);
            if (nv) { v.pps = nv.pps; v.scrollX = nv.scrollX; zoomStore.set(v.pps, "user"); invalidate(); l.onAnnounce?.({ key: "timeline.say.zoomedSelection" }); }
            break;
          }
          zoomStore.set(cmd.how === "fit" ? fitPps(v, lengthSec()) : clampPps(cmd.how === "in" ? v.pps * 1.25 : v.pps / 1.25), cmd.how === "fit" ? "fit" : "user");
          break;
        }
        case "scroll": {
          const page = (v.width - gut(v)) * 0.8;
          if (cmd.how === "pageRight") v.scrollX += page; else if (cmd.how === "pageLeft") v.scrollX -= page;
          else v.scrollY += cmd.how === "down" ? LANE : -LANE;
          invalidate();
          break;
        }
        default: l.onCommand?.(cmd);
      }
    }
  };
  const onKey = (e: KeyboardEvent) => {
    const cmd = canvasCommand(e, live.current.selected.size > 0);
    if (cmd) { e.preventDefault(); exec(cmd); }
  };
  const execRef = useRef(exec);
  execRef.current = exec;
  useEffect(() => {
    const on = (e: Event) => execRef.current((e as CustomEvent<Command>).detail);
    window.addEventListener(COMMAND_EVENT, on);
    return () => window.removeEventListener(COMMAND_EVENT, on);
  }, []);

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
        aria-valuenow={firstFrame.current}
        aria-valuetext={t("timeline.playheadText", { seconds: Math.round((firstFrame.current / fps) * 100) / 100 })}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onCancel}
        onContextMenu={(e) => {
          e.currentTarget.dataset.pointer = ""; // a mouse-opened menu must not leave the keyboard focus frame around the timeline (V-20)
          const p = local(e), v = view.current, t = trackAtY(live.current.scene, v, p.y);
          const h = (e.nativeEvent as PointerEvent).pointerType === "touch" || t < 0 || p.x < gut(v) ? null : hitTest(live.current.scene, v, p.x, p.y, 0);
          if (h && h.kind === "clip" && markerAt(live.current.scene, v, p.x, p.y, false) < 0) { // right-click a clip: pick it (unless it is already part of the selection), then its menu
            e.preventDefault();
            if (!live.current.selected.has(live.current.scene.id[h.clip]!)) setSelection(new Set([live.current.scene.id[h.clip]!]));
            live.current.onClipMenu?.(new DOMRect(e.clientX, e.clientY, 1, 1));
            return;
          }
          const mi = markerAt(live.current.scene, v, p.x, p.y, false);
          if (mi >= 0) { e.preventDefault(); const id = live.current.scene.markers[mi]!.id; live.current.onMarkerMenu?.(id, markerRect(id)); return; }
          if (t >= 0 && p.x < gut(v)) { e.preventDefault(); live.current.onTrackMenu?.(t, headerRect(t)); }
        }}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onKeyDown={(e) => {
          if (!isModifierKey(e.key)) delete e.currentTarget.dataset.pointer;
          if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) { // the keyboard's way to the clip menu: anchored to the first selected clip
            const sel = indicesOf(live.current.scene, live.current.selected);
            if (sel.length === 0) return;
            e.preventDefault();
            const r = canvas.current!.getBoundingClientRect(), v = view.current, sc = live.current.scene, j = sel[0]!;
            const x = Math.max(gut(v), timeToX(v, sc.start[j]!)), y = RULER + sc.clipTrack[j]! * LANE - v.scrollY;
            live.current.onClipMenu?.(new DOMRect(r.left + x + 8, r.top + y + LANE / 2, 1, 1));
            return;
          }
          onKey(e);
        }}
        onBlur={(e) => { delete e.currentTarget.dataset.pointer; }}
      />
      <div ref={hclip} className="tl-playhead-clip" aria-hidden="true"><canvas ref={hcv} className="tl-playhead-head" /></div>
      <canvas ref={pcv} className="tl-playhead-layer" aria-hidden="true" style={{ display: "none" }} />
      <p id="tl-summary" className="sr-only">{summary} {t("timeline.keys")}</p>
      <ClipListDeferred scene={scene} selected={selected} />
    </>
  );
}

/** The list is rebuilt at low priority (after the edit has painted): a screen reader reads it on request, nobody waits for it. */
function ClipListDeferred({ scene, selected }: { scene: Scene; selected: ReadonlySet<string> }) {
  return <ClipList scene={useDeferredValue(scene)} selected={useDeferredValue(selected)} />;
}

/** Text alternative to the canvas: every clip (capped) in reading order, so a screen reader can browse what the picture shows. Memoized: it is rebuilt only when the scene or the selection changes (P-3). */
const ClipList = memo(function ClipList({ scene, selected }: { scene: Scene; selected: ReadonlySet<string> }) {
  const { t } = useI18n();
  if (scene.clipCount === 0) return null;
  return (
    <ul className="sr-only" aria-label={t("timeline.clipList")} data-testid="tl-clip-list">
      {Array.from({ length: Math.min(scene.clipCount, CLIP_LIST_MAX) }, (_, i) => {
        const say = describeClip(scene, i);
        return <li key={scene.id[i]}>{t(say.key, say.values)}{selected.has(scene.id[i]!) ? ` ${t("timeline.clipSelected")}` : ""}</li>;
      })}
    </ul>
  );
});
