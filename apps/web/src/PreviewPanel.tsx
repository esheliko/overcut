import { MediaDecodeError, type Engine, type MediaHandle, type Project } from "@app/engine-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { announce } from "./a11y/announcer";
import { useI18n } from "./i18n";
import { Icon } from "./icons";
import { createWebAudio, performanceClock } from "./preview/audio";
import { createGlRenderer, type Renderer } from "./preview/compositor";
import { canvasBackingSize } from "./preview/layout";
import { Player } from "./preview/player";
import { quickProject } from "./preview/quickProject";
import { rateLabel, TICKS_PER_SECOND, timecodeHMS, type Rate } from "./preview/timing";

const IDLE = { rate: { num: 30, den: 1 } as Rate, size: { width: 1920, height: 1080 }, endTicks: 60 * TICKS_PER_SECOND };

export interface RatioChoice { id: string; value: number }

/** What the rest of the editor needs to know about the previewed sequence. */
export interface Sequenced { project: Project | null; rate: Rate; endFrame: number }

interface Props {
  engine: Engine | null;
  /** The engine has opened its project (startup / recovery finished): opening a clip before that would be replaced by it. */
  ready: boolean;
  frame: number;
  playing: boolean;
  ratios: readonly RatioChoice[];
  ratio: string;
  onRatio(id: string): void;
  onFrame(f: number): void;
  onPlaying(p: boolean): void;
  onSequence(s: Sequenced): void;
}

type Loaded = { project: Project; handles: Map<string, MediaHandle> };

const noRenderer: Renderer = { render: () => undefined, resize: () => undefined, probe: () => [0, 0, 0], dispose: () => undefined };

/** The preview: canvas, transport, timecode, keyboard. Owns the `Player`; the playhead frame is shared with the timeline through props. */
export function PreviewPanel({ engine, ready, frame, playing, ratios, ratio, onRatio, onFrame, onPlaying, onSequence }: Props) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const rendererRef = useRef<Renderer>(noRenderer);
  const playerRef = useRef<Player | null>(null);
  const loadedRef = useRef<Loaded | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [speed, setSpeed] = useState(1);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const cb = useRef({ onFrame, onPlaying });
  cb.current = { onFrame, onPlaying };
  // Frames the player itself published: the matching prop change is an echo, not a request to seek (state lags the player by a render).
  const echoes = useRef(new Set<number>());
  const emit = useCallback((f: number) => { echoes.current.add(f); cb.current.onFrame(f); }, []);

  const seqOf = loaded?.project.sequences[0];
  const rate: Rate = seqOf?.frame_rate ?? IDLE.rate;
  const size = seqOf?.resolution ?? IDLE.size;
  const endTicks = seqOf ? Math.max(0, ...seqOf.tracks.flatMap((tr) => tr.clips.map((c) => c.start + c.duration))) : IDLE.endTicks;
  const endFrame = Math.ceil((endTicks * rate.num) / (TICKS_PER_SECOND * rate.den));

  // A renderer per canvas (WebGL2); without it the preview stays black and says so.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    try {
      rendererRef.current = createGlRenderer(c);
    } catch {
      rendererRef.current = noRenderer;
      setProblem(t("preview.noGpu"));
    }
    return () => { rendererRef.current.dispose(); rendererRef.current = noRenderer; };
  }, [t]);

  // A player per sequence: the idle one plays the empty (black) sample timeline, the loaded one the opened clip.
  useEffect(() => {
    const seq = loaded?.project.sequences[0];
    const handles = loaded?.handles;
    const audio = createWebAudio(48_000);
    const p = new Player({
      rate, size, endTicks,
      sequence: seq?.id ?? "",
      evaluate: async (ticks, n) => {
        if (!seq || !engine) return { time: ticks, frame: 0, video_time: ticks, sample: 0, audio_samples: n, layers: [], audio: [] };
        return engine.editing.evaluate(seq.id, ticks, n);
      },
      media: (id) => handles?.get(id),
      renderer: { render: (l, s) => rendererRef.current.render(l, s), resize: (w, h) => rendererRef.current.resize(w, h), probe: (x, y) => rendererRef.current.probe(x, y), dispose: () => undefined },
      audio,
      fallbackClock: performanceClock,
      onFrame: emit,
      onState: (pl, r) => { cb.current.onPlaying(pl); setSpeed(r || 1); },
      onError: (m) => setProblem(m),
      raf: (fn) => { const id = requestAnimationFrame(fn); return () => cancelAnimationFrame(id); },
    });
    playerRef.current = p;
    p.seek(0);
    const hook = window as unknown as { __overcutPreview?: unknown };
    hook.__overcutPreview = {
      player: p,
      stats: () => ({ ...p.stats }),
      probe: (x: number, y: number) => rendererRef.current.probe(x, y),
      media: () => [...(handles?.values() ?? [])],
    };
    return () => { p.dispose(); if (playerRef.current === p) playerRef.current = null; };
  }, [loaded, engine]);

  useEffect(() => { onSequence({ project: loaded?.project ?? null, rate, endFrame }); }, [loaded, rate.num, rate.den, endFrame]);

  // The timeline (or anything else) moved the playhead: show that frame.
  useEffect(() => {
    const echo = echoes.current;
    if (echo.has(frame)) {
      for (const f of echo) if (f <= frame) echo.delete(f);
      return;
    }
    playerRef.current?.seek(frame);
  }, [frame]);

  // Canvas backing store follows the panel at real device pixels.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const fit = () => {
      const r = box.getBoundingClientRect();
      const s = canvasBackingSize(r.width, r.height, window.devicePixelRatio || 1, size);
      rendererRef.current.resize(s.width, s.height);
      const p = playerRef.current;
      if (p && !p.isPlaying) p.seek(p.frame);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => ro.disconnect();
  }, [size.width, size.height, ratio, loaded]);

  const open = useCallback(async (file: File) => {
    if (!engine) return;
    setBusy(true);
    setProblem(null);
    try {
      const handle = await engine.media.open(file, { audioRate: 48_000 });
      const project = quickProject(file.name, handle.info, file.name);
      await engine.editing.open(project);
      const prev = loadedRef.current;
      const next = { project, handles: new Map([[project.media[0]!.id, handle]]) };
      loadedRef.current = next;
      emit(0);
      setLoaded(next);
      for (const h of prev?.handles.values() ?? []) void h.close();
      announce(t("preview.opened", { name: file.name }));
    } catch (e) {
      setProblem(e instanceof MediaDecodeError || e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [engine, t, emit]);

  // Transport keys. Space and the shuttle keys also work with the timeline focused; arrows/Home/End leave a focused slider alone (it handles them itself).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement;
      const typing = !!el.closest("input:not([type=range]), select, textarea, [contenteditable=true]");
      const onButton = !!el.closest("button");
      const onSlider = !!el.closest("[role=slider], input[type=range]");
      const p = playerRef.current;
      if (!p || typing) return;
      const k = e.key;
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

  const p = () => playerRef.current;
  const ar = seqOf ? size.width / size.height : ratios.find((r) => r.id === ratio)!.value;
  const badge = rateLabel(playing ? speed : 1);
  const tcNow = timecodeHMS(frame, rate);
  const total = timecodeHMS(endFrame, rate);

  return (
    <section className="stage" aria-label={t("preview.label")} data-testid="panel-preview">
      <div className="stage-view">
        <div ref={boxRef} className="canvas" style={{ ["--ar" as string]: ar, aspectRatio: String(ar) }} data-loaded={!!loaded}>
          <canvas ref={canvasRef} className="preview-canvas" data-testid="preview-canvas" aria-label={t("preview.canvas")} role="img" />
          {!loaded && (
            <div className="canvas-hint">
              <Icon name="film" size={30} />
              <span>{t("preview.hint")}</span>
              <button className="chip-btn" disabled={!engine || !ready || busy} onClick={() => fileRef.current?.click()} data-testid="preview-open">
                <Icon name="upload" size={18} /><span>{busy ? t("preview.opening") : t("preview.open")}</span>
              </button>
            </div>
          )}
          {badge && <span className="rate-badge" aria-live="polite">{badge}</span>}
        </div>
        <input ref={fileRef} type="file" hidden accept="video/*,audio/*,.mp4,.mov,.m4v,.webm,.mkv" data-testid="preview-file"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void open(f); }} />
      </div>
      {problem && <p className="preview-problem" role="alert" data-testid="preview-problem">{problem}</p>}
      <div className="player-bar">
        <div className="tc" aria-label={t("player.time")} data-testid="timecode"><span>{tcNow}</span><span className="tc-total"> / {total}</span></div>
        <div className="transport" role="toolbar" aria-label={t("player.toolbar")}>
          <button className="icon-btn" aria-label={t("player.start")} onClick={() => p()?.seek(0)}><Icon name="back" size={20} /></button>
          <button className="icon-btn" aria-label={t("player.stepBack")} onClick={() => p()?.step(-1)}><Icon name="stepBack" size={20} /></button>
          <button className="play" aria-label={playing ? t("player.pause") : t("player.play")} onClick={() => p()?.toggle()}><Icon name={playing ? "pause" : "play"} size={22} /></button>
          <button className="icon-btn" aria-label={t("player.stepForward")} onClick={() => p()?.step(1)}><Icon name="stepForward" size={20} /></button>
          <button className="icon-btn" aria-label={t("player.end")} onClick={() => p()?.seek(p()!.endFrame)}><Icon name="forward" size={20} /></button>
        </div>
        <label className="ratio">
          <span className="sr-only">{t("ratio.label")}</span>
          <select value={ratio} disabled={!!seqOf} title={seqOf ? t("ratio.fixed") : undefined} onChange={(e) => onRatio(e.target.value)}>
            {ratios.map((r) => <option key={r.id} value={r.id}>{r.id === ratio ? r.id : t(`ratio.${r.id}`)}</option>)}
          </select>
        </label>
      </div>
    </section>
  );
}
