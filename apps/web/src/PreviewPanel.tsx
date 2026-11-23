import type { Engine, Project } from "@app/engine-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "./i18n";
import { Icon } from "./icons";
import { clipCount, timelineEnd } from "./media/plan";
import { useImportPicker } from "./media/MediaBin";
import type { Source } from "./media/sources";
import { createWebAudio, performanceClock } from "./preview/audio";
import { createGlRenderer, type Renderer } from "./preview/compositor";
import { canvasBackingSize } from "./preview/layout";
import { Player } from "./preview/player";
import { rateLabel, TICKS_PER_SECOND, timecodeHMS, type Rate } from "./preview/timing";
import { useMediaHandles } from "./preview/useMediaHandles";
import { useProjectStore, useStore } from "./store/projectStore";

const IDLE = { rate: { num: 30, den: 1 } as Rate, size: { width: 1920, height: 1080 }, endTicks: 60 * TICKS_PER_SECOND };

export interface RatioChoice { id: string; value: number }

/** The sequence the editor shows: the project's once it has clips, the idle sample before that. Shared by the preview and the timeline's length. */
export function sequenceView(project: Project | null) {
  const seq = project?.sequences[0];
  const has = !!project && !!seq && clipCount(project) > 0;
  const rate: Rate = has ? seq.frame_rate : IDLE.rate;
  const size = has ? seq.resolution : IDLE.size;
  const endTicks = has ? timelineEnd(project) : IDLE.endTicks;
  return { has, rate, size, endTicks, endFrame: Math.ceil((endTicks * rate.num) / (TICKS_PER_SECOND * rate.den)), sequence: seq?.id ?? "" };
}

interface Props {
  engine: Engine | null;
  /** The file behind a media item (the bin owns them), so the preview can open decoders for what the project uses. */
  fileOf(id: string): Promise<File | null>;
  /** Import files (the same flow as the bin; the empty preview offers it too). */
  onImport(s: Source[]): void;
  playing: boolean;
  ratios: readonly RatioChoice[];
  ratio: string;
  onRatio(id: string): void;
  onPlaying(p: boolean): void;
}

const noRenderer: Renderer = { render: () => undefined, resize: () => undefined, probe: () => [0, 0, 0], dispose: () => undefined };

/**
 * The preview: canvas, transport, timecode, keyboard. It plays the shared project (`store/projectStore.ts`): it never opens a project of its
 * own, and when the project changes (edit, undo, import) the same `Player` is reconfigured, so the new length and clips show without a restart.
 */
export function PreviewPanel({ engine, fileOf, onImport, playing, ratios, ratio, onRatio, onPlaying }: Props) {
  const { t } = useI18n();
  const store = useStore();
  const project = useProjectStore((s) => s.project);
  const frame = useProjectStore((s) => s.playhead);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<Renderer>(noRenderer);
  const playerRef = useRef<Player | null>(null);
  const [speed, setSpeed] = useState(1);
  const [problem, setProblem] = useState<string | null>(null);
  const { open, field } = useImportPicker(onImport, "preview-input");
  const { handles, version } = useMediaHandles(engine, project, fileOf);
  const cb = useRef({ onPlaying });
  cb.current = { onPlaying };
  // Frames the player itself published: the matching prop change is an echo, not a request to seek (state lags the player by a render).
  const echoes = useRef(new Set<number>());
  const emit = useCallback((f: number) => { echoes.current.add(f); store.setPlayhead(f); }, [store]);

  const view = sequenceView(project);
  const { rate, size, endTicks, endFrame } = view;
  const cfg = useRef(view);
  cfg.current = view;

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

  // One player for the preview's lifetime (per engine); project changes reconfigure it below.
  useEffect(() => {
    const audio = createWebAudio(48_000);
    const c = cfg.current;
    const p = new Player({
      rate: c.rate, size: c.size, endTicks: c.endTicks, sequence: c.sequence,
      evaluate: async (ticks, n) => {
        const id = cfg.current.sequence;
        if (!id || !engine) return { time: ticks, frame: 0, video_time: ticks, sample: 0, audio_samples: n, layers: [], audio: [] };
        return engine.editing.evaluate(id, ticks, n);
      },
      media: (id) => handles.current.get(id),
      renderer: { render: (l, s) => rendererRef.current.render(l, s), resize: (w, h) => rendererRef.current.resize(w, h), probe: (x, y) => rendererRef.current.probe(x, y), dispose: () => undefined },
      audio,
      fallbackClock: performanceClock,
      onFrame: emit,
      onState: (pl, r) => { cb.current.onPlaying(pl); setSpeed(r || 1); },
      onError: (m) => setProblem(m),
      raf: (fn) => { const id = requestAnimationFrame(fn); return () => cancelAnimationFrame(id); },
    });
    playerRef.current = p;
    p.seek(store.getState().playhead);
    const hook = window as unknown as { __overcutPreview?: unknown };
    hook.__overcutPreview = {
      player: p,
      stats: () => ({ ...p.stats }),
      probe: (x: number, y: number) => rendererRef.current.probe(x, y),
      media: () => [...handles.current.values()],
    };
    return () => { p.dispose(); if (playerRef.current === p) playerRef.current = null; };
  }, [engine, emit, store, handles]);

  // The shared project (or a decoder handle) changed: the same player takes the new length, rate and clips and redraws the playhead's frame.
  useEffect(() => {
    playerRef.current?.reconfigure({ rate, size, endTicks, sequence: view.sequence });
  }, [project, version, rate.num, rate.den, size.width, size.height, endTicks, view.sequence]);

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
  }, [size.width, size.height, ratio, view.has]);

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
  const ar = view.has ? size.width / size.height : ratios.find((r) => r.id === ratio)!.value;
  const badge = rateLabel(playing ? speed : 1);
  const tcNow = timecodeHMS(frame, rate);
  const total = timecodeHMS(endFrame, rate);

  return (
    <section className="stage" aria-label={t("preview.label")} data-testid="panel-preview">
      <div className="stage-view">
        <div ref={boxRef} className="canvas" style={{ ["--ar" as string]: ar, aspectRatio: String(ar) }} data-loaded={view.has}>
          <canvas ref={canvasRef} className="preview-canvas" data-testid="preview-canvas" aria-label={t("preview.canvas")} role="img" />
          {!view.has && (
            <div className="canvas-hint">
              <Icon name="film" size={30} />
              <span>{t("preview.hint")}</span>
              <button className="chip-btn" disabled={!engine} onClick={open} data-testid="preview-import">
                <Icon name="upload" size={18} /><span>{t("media.import")}</span>
              </button>
            </div>
          )}
          {badge && <span className="rate-badge" aria-live="polite">{badge}</span>}
        </div>
        {field}
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
          <select value={ratio} disabled={view.has} title={view.has ? t("ratio.fixed") : undefined} onChange={(e) => onRatio(e.target.value)}>
            {ratios.map((r) => <option key={r.id} value={r.id}>{r.id === ratio ? r.id : t(`ratio.${r.id}`)}</option>)}
          </select>
        </label>
      </div>
    </section>
  );
}
