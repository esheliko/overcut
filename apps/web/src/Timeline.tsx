import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editing, Engine, Op, Project } from "@app/engine-client";
import { FakeMediaHost, onlyFixtures } from "./media/host";
import { MediaLayer } from "./timeline/media-layer";
import { announce } from "./a11y/announcer";
import { useI18n } from "./i18n";
import { Icon } from "./icons";
import { FPS, timecode } from "./timecode";
import { clampN, deleteOps, type Say, editable, indicesOf, moveOps, moveRoom, newClipId, snapDelta, splitOps, splittable, trimRange, trimTarget, trimOp } from "./timeline/edit";
import { sampleProject } from "./timeline/fixture";
import { buildScene, TICKS_PER_SECOND } from "./timeline/scene";
import { globalCommand, type Command } from "./timeline/shortcuts";
import { clampPps, ppsToSlider, sliderToPps } from "./timeline/view";
import { TimelineCanvas, type CanvasHandle } from "./timeline/TimelineCanvas";
import { useProject } from "./useProject";

export const TIMELINE_SECONDS = 60;
export const END_FRAME = TIMELINE_SECONDS * FPS;

type Props = {
  frame: number;
  playing: boolean;
  zoom: number;
  onFrame: (f: number) => void;
  onZoom: (z: number) => void;
  /** Short visible message (toast). */
  onNotice: (what: string) => void;
  /** The engine's edit surface; without it the timeline shows the sample project read-only. */
  editing?: Editing;
  /** Changes when the open project was replaced outside the timeline (undo recovery): re-read it. */
  epoch?: number;
  /** Benchmark/dev hook. */
  onReady?: (h: CanvasHandle) => void;
  /** Frames per second and length (frames) of the previewed sequence; defaults are the sample timeline's. */
  fps?: number;
  endFrame?: number;
  /** Engine for waveform extraction; without it the canvas draws placeholders. */
  engine?: Engine | null;
};

const typing = (t: EventTarget | null) => t instanceof HTMLElement && !!t.closest("input, select, textarea, [contenteditable=true]");
const NO_SELECTION: ReadonlySet<string> = new Set();
const KEYS = { undo: "Ctrl+Z", redo: "Ctrl+Shift+Z", split: "S", del: "Del" };
const tip = (label: string, keys: string) => label + " (" + keys + ")";
const DONE = { undo: ["timeline.say.undo", "timeline.say.nothing.undo"], redo: ["timeline.say.redo", "timeline.say.nothing.redo"] } as const;
const say = (key: string, values?: Say["values"]): Say => ({ key, values });

export function Timeline({ frame, playing, zoom, onFrame, onZoom, onNotice, editing, epoch, onReady, fps = FPS, endFrame = END_FRAME, engine }: Props) {
  const { t } = useI18n();
  // Synthetic media serves the sample project only; imported files keep placeholders until they are wired to a real MediaHost (media/engine-host.ts, follow-up).
  const media = useMemo(() => (engine ? new MediaLayer(engine, onlyFixtures(new FakeMediaHost({ seconds: 30 }))) : undefined), [engine]);
  const proj = useProject(editing, epoch);
  const fallback = useMemo(() => sampleProject(), []);
  const source: Project = proj.project ?? fallback;
  const scene = useMemo(() => buildScene(source), [source]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(NO_SELECTION);
  const speak = useCallback((s: Say) => announce(t(s.key, s.values)), [t]);

  // After an edit or undo, forget selected clips that no longer exist.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const alive = new Set(scene.id);
      const kept = [...prev].filter((id) => alive.has(id));
      return kept.length === prev.size ? prev : new Set(kept);
    });
  }, [scene]);

  const live = useRef({ scene, selected, frame, proj });
  live.current = { scene, selected, frame, proj };

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
    (which === "undo" ? p.undo() : p.redo())
      .then((out) => speak(say(DONE[which][out?.changed ? 0 : 1])))
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
        if (hit.length === 0) { speak(locked ?? say("timeline.say.nothingToSplit")); break; }
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
  }, [speak, commit, undoRedo]);

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
  const none = selected.size === 0;
  return (
    <section className="timeline" aria-label={t("timeline.label")} data-testid="panel-timeline">
      <div className="tl-bar">
        <div className="tl-group" role="toolbar" aria-label={t("timeline.edit")}>
          <button className="icon-btn" aria-label={t("timeline.undo")} title={tip(t("timeline.undo"), KEYS.undo)} disabled={off || !proj.canUndo} onClick={() => run({ c: "undo" })}><Icon name="undo" /></button>
          <button className="icon-btn" aria-label={t("timeline.redo")} title={tip(t("timeline.redo"), KEYS.redo)} disabled={off || !proj.canRedo} onClick={() => run({ c: "redo" })}><Icon name="redo" /></button>
          <span className="sep" aria-hidden="true" />
          <button className="icon-btn" aria-label={t("timeline.split")} title={tip(t("timeline.split"), KEYS.split)} disabled={off} onClick={() => run({ c: "split" })}><Icon name="split" /></button>
          <button className="icon-btn" aria-label={t("timeline.delete")} title={tip(t("timeline.delete"), KEYS.del)} disabled={off || none} onClick={() => run({ c: "delete" })}><Icon name="trash" /></button>
          {!none && <span className="tl-sel" data-testid="tl-selected">{t("timeline.selected", { count: selected.size })}</span>}
        </div>
        <label className="zoom">
          <button type="button" className="icon-btn" aria-label={t("timeline.zoomOut")} onClick={() => onZoom(clampPps(zoom / 1.25))}><Icon name="minus" size={18} /></button>
          <input type="range" min={0} max={1} step={0.005} value={ppsToSlider(zoom)} onChange={(e) => onZoom(sliderToPps(Number(e.target.value)))} aria-label={t("timeline.zoom")} />
          <button type="button" className="icon-btn" aria-label={t("timeline.zoomIn")} onClick={() => onZoom(clampPps(zoom * 1.25))}><Icon name="plus" size={18} /></button>
        </label>
      </div>
      <div className="tl-stage">
        <TimelineCanvas scene={scene} fps={fps} frame={frame} endFrame={endFrame} playing={playing} zoom={zoom} onFrame={onFrame} onZoom={onZoom} summary={summary}
          selected={selected} onSelect={setSelected} onEdit={commit} onCommand={run} onAnnounce={speak} onReady={onReady} media={media} />
      </div>
    </section>
  );
}
