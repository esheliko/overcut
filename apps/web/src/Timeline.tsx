import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Engine, Op, Project } from "@app/engine-client";
import { importedMediaHost } from "./media/engine-host";
import { FakeMediaHost, routeMedia } from "./media/host";
import { MediaLayer } from "./timeline/media-layer";
import { announce } from "./a11y/announcer";
import { useI18n } from "./i18n";
import { Icon } from "./icons";
import { FPS, timecode } from "./timecode";
import { copyClips, duplicateAt, planPlacement, selectedTrack, type Held } from "./timeline/clipboard";
import { clampN, closeStartGap, deleteOps, expandLinks, groupReps, linkedTrimOps, mirrorTrims, type Say, editable, indicesOf, moveOps, moveRoom, newClipId, snapDelta, splitOps, splittable, trimRange, trimTarget, unlinkOps } from "./timeline/edit";
import { sampleProject } from "./timeline/fixture";
import { buildScene, TICKS_PER_SECOND } from "./timeline/scene";
import { globalCommand, type Command } from "./timeline/shortcuts";
import { clampPps, fitPps, ppsToSlider, sliderToPps } from "./timeline/view";
import { TimelineCanvas, type CanvasHandle } from "./timeline/TimelineCanvas";
import { TrackMenu, type TrackAction, type TrackMenuTarget } from "./timeline/TrackMenu";
import { addTrack, removeTrack, renameTrack, reorderTrack, toggleTrack, TRACK_SAY_KEYS } from "./timeline/tracks";
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
  /** A media-bin card was dropped on the timeline canvas: place it at this tick. */
  onDropMedia?: (id: string, tick: number) => void;
};

const typing = (t: EventTarget | null) => t instanceof HTMLElement && !!t.closest("input, select, textarea, [contenteditable=true]");
const NO_SELECTION: ReadonlySet<string> = new Set();
const KEYS = { undo: "Ctrl+Z", redo: "Ctrl+Shift+Z", split: "S", del: "Del", dup: "Ctrl+D", copy: "Ctrl+C", cut: "Ctrl+X", paste: "Ctrl+V" };
/** The history step name (lower case, "Undo <name>") for an edit, from the message that announces it. */
const LABELS: Record<string, string> = { "timeline.say.split": "timeline.label.split", "timeline.say.deleted": "timeline.label.deleted", "timeline.say.moved": "timeline.label.moved",
  "timeline.say.nudged": "timeline.label.nudged", "timeline.say.trimmed": "timeline.label.trimmed", "timeline.say.duplicated": "timeline.label.duplicated",
  "timeline.say.cut": "timeline.label.cut", "timeline.say.unlinked": "timeline.label.unlinked", "timeline.say.pasted": "timeline.label.pasted", "timeline.say.timed": "timeline.label.timed",
  "timeline.say.track.added": "timeline.label.track.added", "timeline.say.track.removed": "timeline.label.track.removed", "timeline.say.track.moved": "timeline.label.track.edited", "timeline.say.track.renamed": "timeline.label.track.edited",
  ...Object.fromEntries(TRACK_SAY_KEYS.map((k) => [k, "timeline.label.track.edited"])) };
const tip = (label: string, keys: string) => label + " (" + keys + ")";
const DONE = { undo: ["timeline.say.undo", "timeline.say.nothing.undo"], redo: ["timeline.say.redo", "timeline.say.nothing.redo"] } as const;
const say = (key: string, values?: Say["values"]): Say => ({ key, values });

const HistoryDialog = lazy(() => import("./timeline/EditDialogs").then((m) => ({ default: m.HistoryDialog })));
const TimingDialog = lazy(() => import("./timeline/EditDialogs").then((m) => ({ default: m.TimingDialog })));

export function Timeline({ playing, zoom, onZoom, onNotice, onReady, fps = FPS, endFrame = END_FRAME, engine, fileOf, readyIds = "", onDropMedia }: Props) {
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
  // The in-app clipboard (copies of clips, ADR 0006: pasting inserts new clips through the engine); the dialogs of the second toolbar row.
  const [held, setHeld] = useState<readonly Held[]>([]);
  const heldRef = useRef(held);
  heldRef.current = held;
  const [dialog, setDialog] = useState<"history" | "timing" | null>(null);
  const [menu, setMenu] = useState<{ target: TrackMenuTarget; anchor: DOMRect } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const closeDialog = useCallback(() => setDialog(null), []); // the native dialog hands focus back to the button that opened it
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

  const commit = useCallback((ops: Op[], s: Say, after?: (out: { changed: boolean }) => void) => {
    const p = live.current.proj;
    if (!p.ready) { onNotice(t("timeline.notReady")); return; }
    const labelKey = LABELS[s.key];
    p.apply(closeStartGap(live.current.scene, ops), undefined, labelKey ? t(labelKey, s.values) : undefined).then((out) => { if (out?.changed) after?.(out); return out; }).then((out) => { if (out?.changed) speak(s); }).catch((e: unknown) => {
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
        const reps = groupReps(sc, mine); // a linked picture and sound count as one clip: they trim together
        if (reps.length !== 1) { speak(locked ?? say("timeline.say.selectOne")); break; }
        const i = reps[0]!;
        const r = trimRange(sc, i, cmd.edge);
        const value = cmd.c === "trimBy" ? trimTarget(sc, i, cmd.edge, r.at + cmd.frames * ft) : clampN(tick, r.min, r.max);
        if (value === r.at) { speak(say("timeline.say.cantTrim")); break; }
        commit(linkedTrimOps(sc, i, cmd.edge, value), say("timeline.say.trimmed", { edge: cmd.edge, name: sc.name[i]! }));
        break;
      }
      case "copy": case "cut": case "duplicate": {
        const proj0 = live.current.proj.project;
        const picked0 = proj0 ? copyClips(proj0, new Set(cmd.c === "cut" ? mine.map((i) => sc.id[i]!) : picked.map((i) => sc.id[i]!))) : [];
        if (!proj0 || picked0.length === 0) { speak(locked && cmd.c === "cut" ? locked : say("timeline.say.nothingToCopy")); break; }
        if (cmd.c === "duplicate") {
          const plan = planPlacement(proj0, picked0, duplicateAt(picked0), null, newClipId);
          if (plan.ops.length === 0) { speak(say("timeline.say.pasteSkipped", { count: plan.skipped })); break; }
          commit(plan.ops, say("timeline.say.duplicated", { count: plan.placed }), () => setSelected(new Set(plan.ops.map((o) => (o.op === "insert_clip" ? o.clip.id : "")))));
          break;
        }
        setHeld(picked0);
        if (cmd.c === "copy") { speak(say("timeline.say.copied", { count: picked0.length })); break; }
        commit(picked0.map((h) => ({ op: "delete" as const, clip: h.clip.id })), say("timeline.say.cut", { count: picked0.length }), () => setSelected(NO_SELECTION));
        break;
      }
      case "paste": {
        const proj0 = live.current.proj.project;
        const h = heldRef.current;
        if (!proj0 || h.length === 0) { speak(say("timeline.say.nothingToPaste")); onNotice(t("timeline.say.nothingToPaste")); break; }
        const plan = planPlacement(proj0, h, tick, selectedTrack(proj0, sel), newClipId);
        if (plan.ops.length === 0) { const m = say("timeline.say.pasteSkipped", { count: plan.skipped }); speak(m); onNotice(t(m.key, m.values)); break; }
        commit(plan.ops, say("timeline.say.pasted", { count: plan.placed, time: timecode(Math.round((plan.start * FPS) / TICKS_PER_SECOND)) }), () => setSelected(new Set(plan.ops.map((o) => (o.op === "insert_clip" ? o.clip.id : "")))));
        if (plan.skipped > 0) onNotice(t("timeline.say.pasteSkipped", { count: plan.skipped }));
        break;
      }
      case "unlink": {
        const ops = unlinkOps(sc, mine);
        if (ops.length === 0) break;
        commit(ops, say("timeline.say.unlinked", { count: ops.length }));
        break;
      }
      default: break;
    }
  }, [speak, commit, undoRedo, onNotice, t, setSelected]);

  const trackAction = useCallback((a: TrackAction) => {
    const sc = live.current.scene;
    const r = a.a === "toggle" ? toggleTrack(sc, a.track, a.part)
      : a.a === "rename" ? renameTrack(sc, a.track, a.name)
      : a.a === "remove" ? removeTrack(sc, a.track)
      : a.a === "move" ? reorderTrack(sc, a.track, a.to)
      : addTrack(sc, a.kind, newClipId());
    if (r) commit(r.ops, r.say);
  }, [commit]);
  const openMenu = useCallback((target: TrackMenuTarget, anchor: DOMRect) => setMenu({ target, anchor }), []);

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
  const oneIdx = indicesOf(scene, selected);
  const oneRep = groupReps(scene, oneIdx); // a linked picture and sound are one clip to the timing dialog (its edit is mirrored onto the partner)
  const oneClip = oneRep.length === 1 && !scene.trackLocked[scene.clipTrack[oneRep[0]!]!] ? oneRep : null;
  const anyLinked = oneIdx.some((i) => scene.link[i]);
  // A linked sound is selected with its picture: one click is one clip, so the count is clips, and "+ linked audio" says what came along.
  const clipCount = groupReps(scene, oneIdx).length;
  const withLinked = oneIdx.length > clipCount;
  useEffect(() => { if (dialog === "timing" && !oneClip) setDialog(null); }, [dialog, oneClip]);
  return (
    <section className="timeline" aria-label={t("timeline.label")} data-testid="panel-timeline">
      <div className="tl-bar">
        <div className="tl-group" role="toolbar" aria-label={t("timeline.edit")}>
          <button className="icon-btn" aria-label={undoText} title={tip(undoText, KEYS.undo)} disabled={off || !proj.canUndo} onClick={() => run({ c: "undo" })}><Icon name="undo" /></button>
          <button className="icon-btn" aria-label={redoText} title={tip(redoText, KEYS.redo)} disabled={off || !proj.canRedo} onClick={() => run({ c: "redo" })}><Icon name="redo" /></button>
          <span className="sep" aria-hidden="true" />
          <button className="icon-btn" aria-label={t("timeline.split")} title={tip(t("timeline.split"), KEYS.split)} disabled={off} onClick={() => run({ c: "split" })}><Icon name="split" /></button>
          <button className="icon-btn" aria-label={t("timeline.delete")} title={tip(t("timeline.delete"), KEYS.del)} disabled={off || none} onClick={() => run({ c: "delete" })}><Icon name="trash" /></button>
          <span className={scene.trackCount > 0 ? "sep tl-add-narrow" : "sep"} aria-hidden="true" />
          <button className={scene.trackCount > 0 ? "icon-btn tl-add-narrow" : "icon-btn"} aria-label={t("timeline.track.addButton")} title={t("timeline.track.addButton")} data-testid="tl-add-track" aria-haspopup="menu" disabled={off}
            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openMenu({ kind: "add" }, new DOMRect(r.left, r.bottom, 0, 0)); }}><Icon name="tracks" /></button>
          <button className="icon-btn tl-track-options" aria-label={t("timeline.track.optionsButton")} title={t("timeline.track.optionsButton")} data-testid="tl-track-options" aria-haspopup="menu" disabled={off || oneIdx.length === 0}
            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openMenu({ kind: "track", track: scene.clipTrack[oneIdx[0]!]! }, new DOMRect(r.left, r.bottom, 0, 0)); }}><Icon name="trackOptions" /></button>
          {!none && <span className="tl-sel" data-testid="tl-selected">{withLinked ? t("timeline.selected.linked", { count: clipCount }) : t("timeline.selected", { count: clipCount })}</span>}
        </div>
        <label className="zoom">
          <button type="button" className="icon-btn" aria-label={t("timeline.zoomOut")} onClick={() => onZoom(clampPps(zoom / 1.25))}><Icon name="minus" size={18} /></button>
          <input type="range" min={0} max={1} step={0.005} value={ppsToSlider(zoom)} onChange={(e) => onZoom(sliderToPps(Number(e.target.value)))} aria-label={t("timeline.zoom")} />
          <button type="button" className="icon-btn" aria-label={t("timeline.zoomIn")} onClick={() => onZoom(clampPps(zoom * 1.25))}><Icon name="plus" size={18} /></button>
          <button type="button" className="icon-btn tl-fit" aria-label={t("timeline.fit")} title={tip(t("timeline.fit"), "0")} data-testid="tl-fit" onClick={fit}><Icon name="fit" size={18} /></button>
        </label>
      </div>
      <div className="tl-bar tl-bar2" data-testid="tl-clip-tools">
        <div className="tl-group" role="toolbar" aria-label={t("timeline.clipTools")}>
          <button className="icon-btn" aria-label={t("timeline.duplicate")} title={tip(t("timeline.duplicate"), KEYS.dup)} data-testid="tl-duplicate" disabled={off || none} onClick={() => run({ c: "duplicate" })}><Icon name="duplicate" /></button>
          <button className="icon-btn" aria-label={t("timeline.copy")} title={tip(t("timeline.copy"), KEYS.copy)} data-testid="tl-copy" disabled={off || none} onClick={() => run({ c: "copy" })}><Icon name="copy" /></button>
          <button className="icon-btn" aria-label={t("timeline.cut")} title={tip(t("timeline.cut"), KEYS.cut)} data-testid="tl-cut" disabled={off || none} onClick={() => run({ c: "cut" })}><Icon name="cut" /></button>
          <button className="icon-btn" aria-label={t("timeline.paste")} title={tip(t("timeline.paste"), KEYS.paste)} data-testid="tl-paste" disabled={off || held.length === 0} onClick={() => run({ c: "paste" })}><Icon name="paste" /></button>
          <button className="icon-btn" aria-label={t("timeline.unlink")} title={t("timeline.unlink")} data-testid="tl-unlink" disabled={off || !anyLinked} onClick={() => run({ c: "unlink" })}><Icon name="unlink" /></button>
          <span className="sep" aria-hidden="true" />
          <button className="icon-btn" aria-label={t("timeline.timing")} title={t("timeline.timing")} data-testid="tl-timing" aria-haspopup="dialog" disabled={off || !oneClip} onClick={() => setDialog("timing")}><Icon name="timing" /></button>
          <button className="icon-btn" aria-label={t("timeline.history")} title={t("timeline.history")} data-testid="tl-history" aria-haspopup="dialog" disabled={off} onClick={() => setDialog("history")}><Icon name="history" /></button>
        </div>
      </div>
      {dialog === "history" && <Suspense fallback={null}><HistoryDialog onClose={closeDialog} onJumped={(what) => { speak(say("history.jumped", { what })); onNotice(t("history.jumped", { what })); }} /></Suspense>}
      {dialog === "timing" && oneClip && <Suspense fallback={null}><TimingDialog scene={scene} clip={oneClip[0]!} fps={fps} onClose={closeDialog}
        onApply={(ops, field, name) => commit(mirrorTrims(scene, ops), say("timeline.say.timed", { field, name }))} /></Suspense>}
      {menu && <TrackMenu scene={scene} target={menu.target} anchor={menu.anchor} onAct={trackAction} onClose={closeMenu} />}
      <div className="tl-stage">
        {scene.clipCount === 0 && <p className="tl-empty" data-testid="tl-empty">{t("timeline.empty")}</p>}
        <TimelineCanvas scene={scene} fps={fps} frame={frame} endFrame={endFrame} playing={playing} zoom={zoom} onFrame={onFrame} onZoom={onZoom} summary={summary}
          selected={selected} onSelect={(ids) => { const all = expandLinks(scene, ids); setSelected(all.size === ids.size ? ids : all); }} onEdit={commit} onCommand={run} onAnnounce={speak} onReady={ready} media={media} onDropMedia={onDropMedia} onTrackMenu={(track, at) => openMenu({ kind: "track", track }, at)} />
      </div>
    </section>
  );
}
