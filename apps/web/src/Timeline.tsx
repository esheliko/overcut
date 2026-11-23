import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Engine, Op, Project } from "@app/engine-client";
import { importedMediaHost } from "./media/engine-host";
import { FakeMediaHost, routeMedia } from "./media/host";
import { MediaLayer } from "./timeline/media-layer";
import { announce } from "./a11y/announcer";
import { useI18n } from "./i18n";
import { Icon } from "./icons";
import { FPS, timecode } from "./timecode";
import { clampN, deleteOps, type Say, editable, indicesOf, moveOps, moveRoom, newClipId, snapDelta, splitOps, splittable, trimRange, trimTarget, trimOp } from "./timeline/edit";
import { sampleProject } from "./timeline/fixture";
import { buildScene, TICKS_PER_SECOND } from "./timeline/scene";
import { globalCommand, type Command } from "./timeline/shortcuts";
import { clampPps, fitPps, ppsToSlider, sliderToPps } from "./timeline/view";
import { TimelineCanvas, type CanvasHandle } from "./timeline/TimelineCanvas";
import { useProjectStore, useStore } from "./store/projectStore";

export const TIMELINE_SECONDS = 60;
export const END_FRAME = TIMELINE_SECONDS * FPS;

type Props = {
  playing: boolean;
  zoom: number;
  onZoom: (z: number) => void;
  /** Short visible message (toast). */
  onNotice: (what: string) => void;
  /** Benchmark/dev hook. */
  onReady?: (h: CanvasHandle) => void;
  /** Frames per second and length (frames) of the previewed sequence; defaults are the sample timeline's. */
  fps?: number;
  endFrame?: number;
  /** Engine for waveform extraction; without it the canvas draws placeholders. */
  engine?: Engine | null;
  /** The file behind an imported media id (the bin's), for real waveforms and filmstrips; without it imported clips show placeholders. */
  fileOf?: (id: string) => Promise<File | null>;
  /** Ids (comma separated) of the media whose file is readable right now: media that turns up here after being offline is requested again. */
  readyIds?: string;
};

const typing = (t: EventTarget | null) => t instanceof HTMLElement && !!t.closest("input, select, textarea, [contenteditable=true]");
const NO_SELECTION: ReadonlySet<string> = new Set();
const KEYS = { undo: "Ctrl+Z", redo: "Ctrl+Shift+Z", split: "S", del: "Del" };
const tip = (label: string, keys: string) => label + " (" + keys + ")";
const DONE = { undo: ["timeline.say.undo", "timeline.say.nothing.undo"], redo: ["timeline.say.redo", "timeline.say.nothing.redo"] } as const;
const say = (key: string, values?: Say["values"]): Say => ({ key, values });

export function Timeline({ playing, zoom, onZoom, onNotice, onReady, fps = FPS, endFrame = END_FRAME, engine, fileOf, readyIds = "" }: Props) {
  const { t } = useI18n();
  // The sample project uses synthetic media; imported files are decoded by the engine from the bin's files (placeholders while extracting or offline).
  const fileOfRef = useRef(fileOf);
  fileOfRef.current = fileOf;
  const media = useMemo(() => {
    if (!engine) return undefined;
    const real = importedMediaHost(engine, async (id) => (await fileOfRef.current?.(id)) ?? null);
    return new MediaLayer(engine, routeMedia(new FakeMediaHost({ seconds: 30 }), real));
  }, [engine]);
  // The one shared project (M1-024): read here, changed only through the store's engine ops. Without a project the sample is shown read-only.
  const store = useStore();
  const project = useProjectStore((s) => s.project);
  const canUndo = useProjectStore((s) => s.canUndo);
  const canRedo = useProjectStore((s) => s.canRedo);
  const selected = useProjectStore((s) => s.selection);
  const frame = useProjectStore((s) => s.playhead);
  const undoLabel = useProjectStore((s) => s.undoLabel);
  const redoLabel = useProjectStore((s) => s.redoLabel);
  // Media that became readable (relink, permission restored) is asked for again; media that left the project closes its decoder handle.
  const known = useRef(new Set<string>());
  const readyBefore = useRef(new Set<string>());
  useEffect(() => {
    if (!media) return;
    const inProject = new Set((project?.media ?? []).map((m) => m.id));
    for (const id of [...known.current]) if (!inProject.has(id)) { known.current.delete(id); readyBefore.current.delete(id); void media.release(id); }
    for (const id of inProject) known.current.add(id);
    const ready = new Set(readyIds ? readyIds.split(",") : []);
    for (const id of ready) if (!readyBefore.current.has(id)) { readyBefore.current.add(id); void media.refresh(id); }
    for (const id of [...readyBefore.current]) if (!ready.has(id)) readyBefore.current.delete(id);
  }, [media, project, readyIds]);
  const proj = useMemo(() => ({ ready: project !== null, project, canUndo, canRedo, apply: store.apply, undo: store.undo, redo: store.redo }), [store, project, canUndo, canRedo]);
  const fallback = useMemo(() => sampleProject(), []);
  const source: Project = project ?? fallback;
  const scene = useMemo(() => buildScene(source), [source]);
  const setSelected = store.setSelection;
  const onFrame = store.setPlayhead;
  const speak = useCallback((s: Say) => announce(t(s.key, s.values)), [t]);

  const live = useRef({ scene, selected, frame, proj });
  live.current = { scene, selected, frame, proj };
  const undoLabelRef = useRef(undoLabel);
  const redoLabelRef = useRef(redoLabel);
  undoLabelRef.current = undoLabel;
  redoLabelRef.current = redoLabel;
  const canvasHandle = useRef<CanvasHandle | null>(null);
  const lengthSec = Math.max(endFrame / fps, scene.endSec);
  const lengthRef = useRef(lengthSec);
  lengthRef.current = lengthSec;
  const fit = useCallback(() => { if (canvasHandle.current) onZoom(fitPps(canvasHandle.current.view, lengthRef.current)); }, [onZoom]);
  const ready = useCallback((h: CanvasHandle) => { canvasHandle.current = h; onReady?.(h); }, [onReady]);
  // The first clips on an empty timeline fill the width: a 1 s clip must not be 40 px on a 30 s ruler.
  const hasClips = project !== null && scene.clipCount > 0;
  const hadClips = useRef<boolean | null>(null); // null until the project is open: opening a project with clips keeps the zoom
  useEffect(() => {
    if (project === null) return;
    if (hasClips && hadClips.current === false) fit();
    hadClips.current = hasClips;
  }, [project, hasClips, fit]);

  const commit = useCallback((ops: Op[], s: Say) => {
    const p = live.current.proj;
    if (!p.ready) { onNotice(t("timeline.notReady")); return; }
    p.apply(ops).then((out) => { if (out?.changed) speak(s); }).catch((e: unknown) => {
      const m = t("timeline.notPossible", { message: e instanceof Error ? e.message : String(e) });
      onNotice(m);
      announce(m);
    });
  }, [speak, onNotice, t]);

  const undoRedo = useCallback((which: "undo" | "redo") => {
    const p = live.current.proj;
    if (!p.ready) return;
    const what = which === "undo" ? undoLabelRef.current : redoLabelRef.current;
    (which === "undo" ? p.undo() : p.redo())
      .then((out) => {
        if (out?.changed && what) { const s = say(which === "undo" ? "timeline.say.undid" : "timeline.say.redid", { what }); speak(s); onNotice(t(s.key, s.values)); } // a visible hint too: "Undid import of clip.mp4"
        else speak(say(DONE[which][out?.changed ? 0 : 1]));
      })
      .catch(() => onNotice(t("timeline.say.failed")));
  }, [speak, onNotice, t]);

  const run = useCallback((cmd: Command) => {
    const { scene: sc, selected: sel, frame: f } = live.current;
    const ft = sc.frameTicks;
    const picked = indicesOf(sc, sel);
    const mine = editable(sc, picked);
    const locked = picked.length > 0 && mine.length === 0 ? say("timeline.locked") : null;
    const tick = Math.round((f * TICKS_PER_SECOND) / FPS);
    switch (cmd.c) {
      case "undo": case "redo": undoRedo(cmd.c); break;
      case "split": {
        const hit = splittable(sc, tick, picked.length ? picked : null);
        if (hit.length === 0) {
          const s = locked ?? say("timeline.say.nothingToSplit");
          speak(s);
          if (!locked) onNotice(t(s.key, s.values)); // not only for screen readers: a sighted user must see why nothing happened
          break;
        }
        commit(splitOps(sc, hit, tick, newClipId), say("timeline.say.split", { count: hit.length, time: timecode(f) }));
        break;
      }
      case "delete": {
        if (mine.length === 0) { speak(locked ?? say("timeline.say.nothingToDelete")); break; }
        commit(deleteOps(sc, mine), say("timeline.say.deleted", { count: mine.length }));
        setSelected(NO_SELECTION);
        break;
      }
      case "nudge": {
        if (mine.length === 0) { speak(locked ?? say("timeline.say.selectFirst")); break; }
        const room = moveRoom(sc, mine);
        const d = snapDelta(cmd.frames * ft, -room.left, room.right, ft);
        if (d === 0) { speak(say("timeline.say.cantMove")); break; }
        commit(moveOps(sc, mine, d), say("timeline.say.nudged", { count: mine.length, frames: Math.abs(d / ft), dir: d < 0 ? "earlier" : "later" }));
        break;
      }
      case "trimToPlayhead": case "trimBy": {
        if (mine.length !== 1) { speak(locked ?? say("timeline.say.selectOne")); break; }
        const i = mine[0]!;
        const r = trimRange(sc, i, cmd.edge);
        const value = cmd.c === "trimBy" ? trimTarget(sc, i, cmd.edge, r.at + cmd.frames * ft) : clampN(tick, r.min, r.max);
        if (value === r.at) { speak(say("timeline.say.cantTrim")); break; }
        commit([trimOp(sc, i, cmd.edge, value)], say("timeline.say.trimmed", { edge: cmd.edge, name: sc.name[i]! }));
        break;
      }
      default: break;
    }
  }, [speak, commit, undoRedo, onNotice, t]);

  // Shortcuts that work anywhere except while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || e.defaultPrevented) return;
      const cmd = globalCommand(e);
      if (!cmd || (e.repeat && cmd.c !== "undo" && cmd.c !== "redo")) return;
      e.preventDefault();
      run(cmd);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run]);

  const summary = t("timeline.summary", { name: source.name, tracks: scene.trackCount, clips: scene.clipCount, seconds: Math.round(scene.endSec), sample: proj.project ? "no" : "yes" });
  const off = !proj.ready;
  const undoText = undoLabel && proj.canUndo ? t("timeline.undo.what", { what: undoLabel }) : t("timeline.undo");
  const redoText = redoLabel && proj.canRedo ? t("timeline.redo.what", { what: redoLabel }) : t("timeline.redo");
  const none = selected.size === 0;
  return (
    <section className="timeline" aria-label={t("timeline.label")} data-testid="panel-timeline">
      <div className="tl-bar">
        <div className="tl-group" role="toolbar" aria-label={t("timeline.edit")}>
          <button className="icon-btn" aria-label={undoText} title={tip(undoText, KEYS.undo)} disabled={off || !proj.canUndo} onClick={() => run({ c: "undo" })}><Icon name="undo" /></button>
          <button className="icon-btn" aria-label={redoText} title={tip(redoText, KEYS.redo)} disabled={off || !proj.canRedo} onClick={() => run({ c: "redo" })}><Icon name="redo" /></button>
          <span className="sep" aria-hidden="true" />
          <button className="icon-btn" aria-label={t("timeline.split")} title={tip(t("timeline.split"), KEYS.split)} disabled={off} onClick={() => run({ c: "split" })}><Icon name="split" /></button>
          <button className="icon-btn" aria-label={t("timeline.delete")} title={tip(t("timeline.delete"), KEYS.del)} disabled={off || none} onClick={() => run({ c: "delete" })}><Icon name="trash" /></button>
          {!none && <span className="tl-sel" data-testid="tl-selected">{t("timeline.selected", { count: selected.size })}</span>}
        </div>
        <label className="zoom">
          <button type="button" className="icon-btn" aria-label={t("timeline.zoomOut")} onClick={() => onZoom(clampPps(zoom / 1.25))}><Icon name="minus" size={18} /></button>
          <input type="range" min={0} max={1} step={0.005} value={ppsToSlider(zoom)} onChange={(e) => onZoom(sliderToPps(Number(e.target.value)))} aria-label={t("timeline.zoom")} />
          <button type="button" className="icon-btn" aria-label={t("timeline.zoomIn")} onClick={() => onZoom(clampPps(zoom * 1.25))}><Icon name="plus" size={18} /></button>
          <button type="button" className="icon-btn tl-fit" aria-label={t("timeline.fit")} title={tip(t("timeline.fit"), "0")} data-testid="tl-fit" onClick={fit}><Icon name="fit" size={18} /></button>
        </label>
      </div>
      <div className="tl-stage">
        <TimelineCanvas scene={scene} fps={fps} frame={frame} endFrame={endFrame} playing={playing} zoom={zoom} onFrame={onFrame} onZoom={onZoom} summary={summary}
          selected={selected} onSelect={setSelected} onEdit={commit} onCommand={run} onAnnounce={speak} onReady={ready} media={media} />
      </div>
    </section>
  );
}
