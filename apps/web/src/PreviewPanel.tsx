import type { Engine, Project } from "@app/engine-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "./i18n";
import { Icon } from "./icons";
import { clipCount, timelineEnd } from "./media/plan";
import { useImportPicker } from "./media/MediaBin";
import type { Source } from "./media/sources";
import { canvasSummary, shapeOf } from "./canvas";
import { canvasBackingSize } from "./preview/layout";
import { acquirePreviewHost, type PlayerProxy, type PreviewHost } from "./preview/host";
import { rateLabel, TICKS_PER_SECOND, timecodeHMS, type Rate } from "./preview/timing";
import { useWorkerMedia } from "./preview/useWorkerMedia";
import { useProjectStore, useStore } from "./store/projectStore";

const IDLE = { rate: { num: 30, den: 1 } as Rate, size: { width: 1920, height: 1080 }, endTicks: 60 * TICKS_PER_SECOND };

/** The sequence the editor shows: the project's once it has clips, the idle sample before that. Shared by the preview and the timeline's length. */
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
}

/**
 * The preview: canvas, transport, timecode, keyboard. It plays the shared project (`store/projectStore.ts`): it never opens a project of its
 * own, and when the project changes (edit, undo, import) the same `Player` is reconfigured, so the new length and clips show without a restart.
 * The player, the GPU compositor and the decoders live in the preview Worker (`preview/worker.ts`); this component sends it the project, the files and
 * the transport commands, and shows the playhead it reports.
 */
export function PreviewPanel({ engine, fileOf, readyIds, hasMedia, onImport, playing, onCanvas, onPlaying }: Props) {
  const { t } = useI18n();
  const store = useStore();
  const project = useProjectStore((s) => s.project);
  const frame = useProjectStore((s) => s.playhead);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<PreviewHost | null>(null);
  const playerRef = useRef<PlayerProxy | null>(null);
  const [hostVersion, setHostVersion] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [problem, setProblem] = useState<string | null>(null);
  const [prep, setPrep] = useState<number | null>(null);
  const { open, field } = useImportPicker(onImport, "preview-input");
  const noGpu = useRef(t("preview.noGpu"));
  noGpu.current = t("preview.noGpu");
  const cb = useRef({ onPlaying });
  cb.current = { onPlaying };
  // Frames the player itself published: the matching prop change is an echo, not a request to seek (state lags the player by a render).
  const echoes = useRef(new Set<number>());
  const emit = useCallback((f: number) => { echoes.current.add(f); store.setPlayhead(f); }, [store]);

  const view = sequenceView(project);
  const { rate, size, endTicks, endFrame } = view;
  const cfg = useRef(view);
  cfg.current = view;

  // One preview Worker per canvas (a canvas can be handed over once): the Rust GPU compositor (WebGPU, else WebGL2), the player loop and the decoders
  // run there; this thread only sends commands and receives the playhead.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const { host, release } = acquirePreviewHost(c, { onFrame: emit, onState: (pl, r) => { cb.current.onPlaying(pl); setSpeed(r || 1); }, onError: (m) => setProblem(m), onStrip: (p) => setPrep(p === null ? null : Math.min(99, Math.floor(p * 100))) });
    hostRef.current = host;
    playerRef.current = host.player;
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
    return () => { release(); if (hostRef.current === host) { hostRef.current = null; playerRef.current = null; } };
  }, [emit]);

  // The decoders the player reads: the Worker opens its own, from the bin's files.
  useWorkerMedia(hostRef.current, project, fileOf, hostVersion, readyIds);

  // The shared project (or the sequence settings) changed: the Worker re-reads it and the same player takes the new length, rate and clips.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.configure({ project: view.has && project ? JSON.stringify(project) : "", sequence: view.sequence, rate, size, endTicks });
  }, [project, hostVersion, rate.num, rate.den, size.width, size.height, endTicks, view.sequence, view.has]);

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
      hostRef.current?.resize(s.width, s.height);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => ro.disconnect();
  }, [size.width, size.height, view.has, hostVersion]);

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
  const ar = size.width / size.height;
  const canvasText = canvasSummary(size, rate);
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
              {!hasMedia && (
                <button className="chip-btn" disabled={!engine} onClick={open} data-testid="preview-import">
                  <Icon name="upload" size={18} /><span>{t("media.import")}</span>
                </button>
              )}
            </div>
          )}
          {badge && <span className="rate-badge" aria-live="polite">{badge}</span>}
          {prep !== null && <span className="scrub-prep" role="status" data-testid="scrub-prep">{t("scrub.preparing", { percent: prep })}</span>}
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
        <button className="ratio chip-btn" onClick={onCanvas} aria-label={t("canvas.open", { summary: canvasText })} title={t("canvas.hint")} data-testid="canvas-open">
          <Icon name="canvas" size={18} /><span>{shapeOf(size)}</span>
        </button>
      </div>
    </section>
  );
}
