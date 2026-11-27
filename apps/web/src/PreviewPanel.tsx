import type { Engine, Project } from "@app/engine-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { announce } from "./a11y/announcer";
import { useI18n } from "./i18n";
import { Icon } from "./icons";
import { clipCount, timelineEnd } from "./media/plan";
import { useImportPicker } from "./media/MediaBin";
import type { Source } from "./media/sources";
import { setPosterSource } from "./posterSource";
import { canvasSummary, ratioLabel } from "./canvas";
import { canvasBackingSize } from "./preview/layout";
import { COMMAND_EVENT, PLAY_RANGE_EVENT, type PlayRange } from "./commands/palette";
import { currentKeymap } from "./commands/keymap";
import { resolveKey } from "./commands/registry";
import { setPlaybackBusy } from "./media/pace";
import { projectToJson } from "./preview/projectJson";
import { acquirePreviewHost, type PlayerProxy, type PreviewHost } from "./preview/host";
import { rateLabel, TICKS_PER_SECOND, timecodeHMS, type Rate } from "./preview/timing";
import { TransformHandles } from "./preview/TransformHandles";
import { selectedVideoClip, useTransformEdit } from "./inspector/Inspector";
import { relativeTicks } from "./inspector/keyframeModel";
import { useWorkerMedia } from "./preview/useWorkerMedia";
import { useProjectStore, useStore } from "./store/projectStore";
import type { Clip } from "@app/engine-client";

const IDLE = { rate: { num: 30, den: 1 } as Rate, size: { width: 1920, height: 1080 }, endTicks: 60 * TICKS_PER_SECOND };

/** The sequence the editor shows: the project's once it has clips, the idle sample before that. Shared by the preview and the timeline's length. */
/** A tooltip with its shortcut: "Back to start (Home)". */
const tip = (label: string, keys: string): string => `${label} (${keys})`;

export function sequenceView(project: Project | null) {
  const seq = project?.sequences[0];
  const has = !!project && !!seq && clipCount(project) > 0;
  // The canvas the user chose counts before the first clip; "match first clip" (not fixed) shows the idle sample until a clip arrives.
  const rate: Rate = has || seq?.rate_fixed ? seq!.frame_rate : IDLE.rate;
  const size = has || seq?.size_fixed ? seq!.resolution : IDLE.size;
  const endTicks = has ? timelineEnd(project) : IDLE.endTicks;
  return { has, rate, size, endTicks, endFrame: Math.ceil((endTicks * rate.num) / (TICKS_PER_SECOND * rate.den)), sequence: seq?.id ?? "" };
}

interface Props {
  engine: Engine | null;
  /** The file behind a media item (the bin owns them), so the preview can open decoders for what the project uses. */
  fileOf(id: string): Promise<File | null>;
  /** Ids (comma separated) of the media readable right now; a change makes the preview ask for files that were offline before. */
  readyIds?: string;
  /** The bin already holds media: the Media panel's "Import media" is the one import control, so this hint offers none. */
  hasMedia?: boolean;
  /** Import files (the same flow as the bin; the empty preview offers it too). */
  onImport(s: Source[]): void;
  playing: boolean;
  /** Opens the canvas settings (the project's shape, size and frame rate). */
  onCanvas(): void;
  onPlaying(p: boolean): void;
  /** Upright pixel size of a media item once probed (the transform handles need the picture's shape). */
  pictureOf?(id: string): { width: number; height: number } | undefined;
  /** Whether the transform handles may show. On a phone they only do while the Edit sheet is open (they cover the picture otherwise). Default true. */
  handlesOn?: boolean;
}

/** The playhead time. Not a React subscription: a tick writes the text node directly (P-3: playback was ~29 React commits/s for this one string). It re-renders only when the rate or the length change. */
function Timecode({ rate, endFrame, label }: { rate: Rate; endFrame: number; label: string }) {
  const store = useStore();
  const now = useRef<HTMLSpanElement>(null);
  const rateRef = useRef(rate);
  rateRef.current = rate;
  useEffect(() => {
    let shown = Number.NaN;
    const show = () => {
      const f = store.getState().playhead;
      if (f === shown && rateRef.current === rate) return;
      shown = f;
      if (now.current) now.current.textContent = timecodeHMS(f, rateRef.current);
    };
    show();
    return store.subscribe(show);
  }, [store, rate]);
  return (
    <div className="tc" aria-label={label} data-testid="timecode"><span ref={now}>{timecodeHMS(store.getState().playhead, rate)}</span><span className="tc-total"> / {timecodeHMS(endFrame, rate)}</span></div>
  );
}

/** The drag handles of the selected clip. Hidden while playing and for a moment after the playhead moved (scrubbing), so they never cover the picture being watched. */
function HandlesLayer({ clip, rate, size, boxRef, picture, hidden, onEdit }: { clip: Clip; rate: Rate; size: { width: number; height: number }; boxRef: { current: HTMLElement | null }; picture?: { width: number; height: number }; hidden: boolean; onEdit(next: Parameters<ReturnType<typeof useTransformEdit>>[1], key: number): void }) {
  const frame = useProjectStore((s) => s.playhead);
  const [moving, setMoving] = useState(false);
  const last = useRef(frame);
  useEffect(() => {
    if (frame === last.current) return;
    last.current = frame;
    setMoving(true);
    const id = window.setTimeout(() => setMoving(false), 220);
    return () => window.clearTimeout(id);
  }, [frame]);
  if (hidden || moving) return null;
  return <TransformHandles clip={clip} canvas={size} rel={relativeTicks(clip, frame, rate)} picture={picture} boxRef={boxRef} onEdit={onEdit} />;
}

/** Whether the playhead is on `clip` (a boolean selector: the panel re-renders when it flips, not on every tick). */
const onClipAt = (clip: Clip | null, frame: number, rate: Rate): boolean => {
  if (!clip) return false;
  const now = (frame * TICKS_PER_SECOND * rate.den) / rate.num;
  return now >= clip.start && now < clip.start + clip.duration;
};

/**
 * The preview: canvas, transport, timecode, keyboard. It plays the shared project (`store/projectStore.ts`): it never opens a project of its
 * own, and when the project changes (edit, undo, import) the same `Player` is reconfigured, so the new length and clips show without a restart.
 * The player, the GPU compositor and the decoders live in the preview Worker (`preview/worker.ts`); this component sends it the project, the files and
 * the transport commands, and shows the playhead it reports.
 */
export function PreviewPanel({ engine, fileOf, readyIds, hasMedia, onImport, playing, onCanvas, onPlaying, pictureOf, handlesOn = true }: Props) {
  const { t } = useI18n();
  const store = useStore();
  const project = useProjectStore((s) => s.project);
  const selection = useProjectStore((s) => s.selection);
  const readOnly = useProjectStore((s) => s.readOnly);
  const editTransform = useTransformEdit();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<PreviewHost | null>(null);
  const playerRef = useRef<PlayerProxy | null>(null);
  const [hostVersion, setHostVersion] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [problem, setProblem] = useState<string | null>(null);
  const [prep, setPrep] = useState<number | null>(null);
  const stageRef = useRef<HTMLElement>(null);
  const [fs, setFs] = useState<"off" | "native" | "overlay">("off");
  const [loop, setLoop] = useState(false);
  const loopRef = useRef(false);
  loopRef.current = loop;
  const { open, field } = useImportPicker(onImport, "preview-input");
  const noGpu = useRef(t("preview.noGpu"));
  noGpu.current = t("preview.noGpu");
  const cb = useRef({ onPlaying });
  cb.current = { onPlaying };
  // Frames the player itself published: the matching prop change is an echo, not a request to seek (state lags the player by a render).
  const echoes = useRef(new Set<number>());
  // Playing the in/out range (M2-046): the timeline asks with PLAY_RANGE_EVENT; the player runs from the range's start and stops at its end (or loops).
  const rangeRun = useRef<(PlayRange & { seen: boolean }) | null>(null);
  // A seek the timeline asked for that the player has not answered yet: frames it published before that (it was still on the old position, or just re-configured) are stale and must not move the playhead back.
  const pendingSeek = useRef<{ frame: number; until: number } | null>(null);
  const emit = useCallback((f: number) => {
    const ps = pendingSeek.current;
    if (ps) {
      if (f === ps.frame || performance.now() > ps.until) pendingSeek.current = null;
      else return;
    }
    echoes.current.add(f);
    store.setPlayhead(f);
    const r = rangeRun.current, p = playerRef.current;
    if (r && p && f >= r.end) { if (r.loop) p.seek(r.start); else { rangeRun.current = null; p.pause(); p.seek(r.end); } }
  }, [store]);
  useEffect(() => {
    const on = (e: Event) => {
      const p = playerRef.current, d = (e as CustomEvent<PlayRange>).detail;
      if (!p || !d) return;
      rangeRun.current = { ...d, seen: false };
      p.seek(d.start);
      if (!p.isPlaying) p.toggle();
    };
    window.addEventListener(PLAY_RANGE_EVENT, on);
    return () => window.removeEventListener(PLAY_RANGE_EVENT, on);
  }, []);

  const view = sequenceView(project);
  const { rate, size, endTicks, endFrame } = view;
  const cfg = useRef(view);
  cfg.current = view;

  // One preview Worker per canvas (a canvas can be handed over once): the Rust GPU compositor (WebGPU, else WebGL2), the player loop and the decoders
  // run there; this thread only sends commands and receives the playhead.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const { host, release } = acquirePreviewHost(c, { onFrame: emit, onState: (pl, r) => {
      cb.current.onPlaying(pl); setSpeed(r || 1); setPlaybackBusy(pl);
      const rr = rangeRun.current; if (rr) { if (pl) rr.seen = true; else if (rr.seen) rangeRun.current = null; }
      // Loop playback: the player stopped at the end, so start over.
      const pp = playerRef.current;
      if (!pl && !rangeRun.current && loopRef.current && pp && pp.endFrame > 0 && pp.frame >= pp.endFrame) { pp.seek(0); pp.toggle(); }
    }, onError: (m) => setProblem(m), onStrip: (p) => setPrep(p === null ? null : Math.min(99, Math.floor(p * 100))) });
    hostRef.current = host;
    playerRef.current = host.player;
    setPosterSource(() => host.rpc<Blob | null>({ name: "poster" }));
    setHostVersion((v) => v + 1);
    void host.ready.catch(() => setProblem(noGpu.current));
    const hook = window as unknown as { __overcutPreview?: unknown };
    hook.__overcutPreview = {
      player: host.player,
      stats: () => host.rpc({ name: "stats" }),
      probe: (x: number, y: number) => host.rpc({ name: "probe", x, y }),
      position: () => host.rpc({ name: "position" }),
      media: () => host.rpc({ name: "frames" }),
      gpu: () => host.rpc({ name: "gpu" }),
      parity: (f: number) => host.rpc({ name: "parity", frame: f }),
      bench: (width: number, height: number, frames: number) => host.rpc({ name: "bench", width, height, frames }),
      strip: () => host.rpc({ name: "strip" }),
      rpc: (r: Parameters<typeof host.rpc>[0]) => host.rpc(r),
    };
    return () => { setPosterSource(null); release(); if (hostRef.current === host) { hostRef.current = null; playerRef.current = null; } };
  }, [emit]);

  // The decoders the player reads: the Worker opens its own, from the bin's files.
  useWorkerMedia(hostRef.current, project, fileOf, hostVersion, readyIds);

  // The shared project (or the sequence settings) changed: the Worker re-reads it and the same player takes the new length, rate and clips.
  // At most one message per animation frame (a drag sends many edits; only the last one is shown), and the project JSON is built from
  // cached per-clip/per-track pieces (`projectToJson`), so an edit costs what it changed, not the size of the project.
  const pending = useRef<{ host: PreviewHost; project: Project | null; has: boolean; sequence: string; rate: Rate; size: { width: number; height: number }; endTicks: number } | null>(null);
  const flushTimers = useRef<{ raf: number; timer: number }>({ raf: 0, timer: 0 });
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    pending.current = { host, project, has: view.has, sequence: view.sequence, rate, size, endTicks };
    const t = flushTimers.current;
    if (t.raf || t.timer) return;
    const flush = () => {
      window.cancelAnimationFrame(t.raf); window.clearTimeout(t.timer);
      t.raf = 0; t.timer = 0;
      const c = pending.current;
      pending.current = null;
      if (c) c.host.configure({ project: c.has && c.project ? projectToJson(c.project) : "", sequence: c.sequence, rate: c.rate, size: c.size, endTicks: c.endTicks });
    };
    // After the frame that shows the edit has painted (animation frame, then a task), so stringifying and posting the project never delays that paint.
    t.raf = window.requestAnimationFrame(() => { t.timer = window.setTimeout(flush, 0); });
    t.timer = window.setTimeout(flush, 80); // a hidden tab has no animation frames
  }, [project, hostVersion, rate.num, rate.den, size.width, size.height, endTicks, view.sequence, view.has]);
  useEffect(() => () => { const t = flushTimers.current; window.cancelAnimationFrame(t.raf); window.clearTimeout(t.timer); t.raf = 0; t.timer = 0; pending.current = null; }, []);

  // The timeline (or anything else) moved the playhead: show that frame. A store subscription, not a render dependency: a tick does not re-render this panel.
  useEffect(() => {
    let seen: number | null = null;
    const follow = () => {
      const frame = store.getState().playhead;
      if (frame === seen) return;
      seen = frame;
      const echo = echoes.current;
      const p = playerRef.current;
      if (echo.has(frame)) {
        for (const f of echo) if (f <= frame) echo.delete(f);
        // A stale echo (the player published this frame earlier, while the playhead already was there) must not swallow a real request such as Home:
        // it is an echo only while the player really shows that frame, or is playing (state then lags the player).
        if (!p || p.isPlaying || p.frame === frame) return;
      }
      if (p) pendingSeek.current = { frame, until: performance.now() + 400 };
      p?.seek(frame);
    };
    follow();
    return store.subscribe(follow);
  }, [store]);

  // Canvas backing store follows the panel at real device pixels.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const fit = () => {
      const r = box.getBoundingClientRect();
      const s = canvasBackingSize(r.width, r.height, window.devicePixelRatio || 1, size);
      hostRef.current?.resize(s.width, s.height);
    };
    fit();
    // The box animates when the shape changes (and while a splitter is dragged): resize the backing store once it settles, not on every frame of it.
    let timer = 0;
    const ro = new ResizeObserver(() => { window.clearTimeout(timer); timer = window.setTimeout(fit, 120); });
    ro.observe(box);
    return () => { window.clearTimeout(timer); ro.disconnect(); };
  }, [size.width, size.height, view.has, hostVersion]);

  // Transport keys. Space and the shuttle keys also work with the timeline focused; arrows/Home/End leave a focused slider alone (it handles them itself).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement;
      if (e.key === "Escape" && fsRef.current === "overlay") { setFs("off"); e.preventDefault(); return; }
      const typing = !!el.closest("input:not([type=range]), select, textarea, [contenteditable=true]");
      const onButton = !!el.closest("button");
      const onSlider = !!el.closest("[role=slider], input[type=range]");
      const p = playerRef.current;
      if (!p || typing) return;
      const k = e.key;
      const pv = resolveKey(e, "global", currentKeymap())?.command;
      if (pv?.c === "preview") { if (!e.repeat && !(onButton && e.code === "Space")) { e.preventDefault(); doPreview(pv.what); } return; }
      let handled = true;
      if (e.code === "Space") { if (onButton || e.repeat) return; p.toggle(); }
      else if (/^[jkl]$/i.test(k)) { if (e.repeat) return; p.key(k.toUpperCase() as "J" | "K" | "L"); }
      else if (k === "," || (k === "ArrowLeft" && !onSlider && !onButton)) p.step(-1);
      else if (k === "." || (k === "ArrowRight" && !onSlider && !onButton)) p.step(1);
      else if (k === "Home" && !onSlider) p.seek(0);
      else if (k === "End" && !onSlider) p.seek(p.endFrame);
      else handled = false;
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const fsRef = useRef(fs);
  fsRef.current = fs;
  const toggleFullscreen = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) { void document.exitFullscreen().catch(() => undefined); return; }
    if (fsRef.current === "overlay") { setFs("off"); return; }
    // iPhone has no element fullscreen: a fixed overlay over the whole app does the same job.
    if (el.requestFullscreen && document.fullscreenEnabled) el.requestFullscreen().catch(() => setFs("overlay"));
    else setFs("overlay");
  }, []);
  const toggleLoop = useCallback(() => { const next = !loopRef.current; setLoop(next); announce(t(next ? "preview.loop.on" : "preview.loop.off")); }, [t]);
  const doPreview = (what: "fullscreen" | "loop") => (what === "fullscreen" ? toggleFullscreen() : toggleLoop());
  const doPreviewRef = useRef(doPreview);
  doPreviewRef.current = doPreview;
  useEffect(() => {
    const sync = () => setFs(document.fullscreenElement && document.fullscreenElement === stageRef.current ? "native" : fsRef.current === "overlay" ? "overlay" : "off");
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  // The palette (and the shortcuts dialog's rows) run the same two commands.
  useEffect(() => {
    const on = (e: Event) => {
      const c = (e as CustomEvent<{ c?: string; what?: "fullscreen" | "loop" }>).detail;
      if (c?.c === "preview" && c.what) doPreviewRef.current(c.what);
      else if (c?.c === "play") playerRef.current?.toggle(); // the phone Edit sheet's mini transport
    };
    window.addEventListener(COMMAND_EVENT, on);
    return () => window.removeEventListener(COMMAND_EVENT, on);
  }, []);

  const p = () => playerRef.current;
  const ar = size.width / size.height;
  // Handles only while the playhead is on the selected video clip (otherwise there is no picture to grab).
  const sel = view.has ? selectedVideoClip(project, selection) : null;
  const onSel = useProjectStore((s) => onClipAt(sel, s.playhead, rate));
  const handled = sel && onSel ? sel : null;
  const showHandles = !!handled && !readOnly && handlesOn;
  const canvasText = canvasSummary(size, rate);
  const badge = rateLabel(playing ? speed : 1);

  return (
    <section className="stage" ref={stageRef} data-fs={fs === "off" ? undefined : fs} data-handles={showHandles && !playing ? "on" : undefined} aria-label={t("preview.label")} data-testid="panel-preview">
      <div className="stage-view">
        <div ref={boxRef} className={showHandles && !playing ? "canvas framed" : "canvas"} style={{ ["--ar" as string]: ar, aspectRatio: String(ar) }} data-loaded={view.has} onDoubleClick={view.has ? toggleFullscreen : undefined}>
          <canvas ref={canvasRef} className="preview-canvas" data-testid="preview-canvas" aria-label={t("preview.canvas")} role="img" />
          {!view.has && (
            <div className="canvas-hint">
              <Icon name="film" size={30} />
              <span>{t("preview.hint")}</span>
              {!hasMedia && (
                <button className="chip-btn" disabled={!engine} onClick={open} data-testid="preview-import">
                  <Icon name="upload" size={18} /><span>{t("media.import")}</span>
                </button>
              )}
            </div>
          )}
          {showHandles && handled && <HandlesLayer clip={handled} rate={rate} size={size} boxRef={boxRef} picture={pictureOf?.(handled.media)} hidden={playing} onEdit={(next, key) => editTransform(handled.id, next, key)} />}
          {badge && <span className="rate-badge" aria-live="polite">{badge}</span>}
          {prep !== null && <span className="scrub-prep" role="status" data-testid="scrub-prep">{t("scrub.preparing", { percent: prep })}</span>}
        </div>
        {field}
      </div>
      {problem && <p className="preview-problem" role="alert" data-testid="preview-problem">{problem}</p>}
      <div className="player-bar">
        <Timecode rate={rate} endFrame={endFrame} label={t("player.time")} />
        <div className="transport" role="toolbar" aria-label={t("player.toolbar")}>
          <button className="icon-btn" aria-label={t("player.start")} title={tip(t("player.start"), "Home")} onClick={() => p()?.seek(0)}><Icon name="back" size={20} /></button>
          <button className="icon-btn" aria-label={t("player.stepBack")} title={tip(t("player.stepBack"), ",")} onClick={() => p()?.step(-1)}><Icon name="stepBack" size={20} /></button>
          <button className="play" aria-label={playing ? t("player.pause") : t("player.play")} title={tip(playing ? t("player.pause") : t("player.play"), "Space · J K L")} onClick={() => p()?.toggle()}><Icon name={playing ? "pause" : "play"} size={22} /></button>
          <button className="icon-btn" aria-label={t("player.stepForward")} title={tip(t("player.stepForward"), ".")} onClick={() => p()?.step(1)}><Icon name="stepForward" size={20} /></button>
          <button className="icon-btn" aria-label={t("player.end")} title={tip(t("player.end"), "End")} onClick={() => p()?.seek(p()!.endFrame)}><Icon name="forward" size={20} /></button>
        </div>
        <div className="player-extras">
          <button className="icon-btn loop-btn" aria-pressed={loop} aria-label={t("preview.loop")} title={`${t("preview.loop")} (R)`} onClick={toggleLoop} data-testid="loop-toggle"><Icon name="loop" size={20} /></button>
          <button className="icon-btn fs-btn" aria-pressed={fs !== "off"} aria-label={t(fs === "off" ? "preview.fullscreen" : "preview.fullscreen.exit")} title={`${t("preview.fullscreen")} (F)`} onClick={toggleFullscreen} data-testid="fullscreen-toggle"><Icon name={fs === "off" ? "fullscreen" : "fullscreenExit"} size={20} /></button>
          <button className="ratio chip-btn" onClick={onCanvas} aria-label={t("canvas.open", { summary: canvasText })} title={t("canvas.hint")} data-testid="canvas-open">
            <Icon name="canvas" size={18} /><span>{ratioLabel(size)}</span>
          </button>
        </div>
      </div>
    </section>
  );
}
