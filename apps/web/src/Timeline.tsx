import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Engine, Op, Project } from "@app/engine-client";
import { importedMediaHost } from "./media/engine-host";
import { FakeMediaHost, routeMedia } from "./media/host";
import { MediaLayer } from "./timeline/media-layer";
import { announce } from "./a11y/announcer";
import { useI18n } from "./i18n";
import { Icon } from "./icons";
import { FPS, timecode } from "./timecode";
import { copyClips, duplicateAt, planPlacement, selectedTrack, type Held } from "./timeline/clipboard";
import { clampN, closeStartGap, deleteOps, laneStepOps, expandLinks, groupReps, linkedTrimOps, mirrorTrims, type Say, editable, indicesOf, moveOps, moveRoom, newClipId, snapDelta, splitOps, splittable, trimRange, trimTarget, unlinkOps } from "./timeline/edit";
import { closeGapOps, rollCuts, rollRangeAll, rollOps, rippleDeleteOps, slideOps, slideRange, slipOps, slipRange, snapTo, TOOLS, type Tool } from "./timeline/ripple";
import { clipboardState } from "./commands/availability";
import { COMMAND_EVENT, PALETTE_EVENT, PLAY_RANGE_EVENT } from "./commands/palette";
import { addMarkerPlan, clearRangePlan, loopPlan, rangePlan } from "./timeline/markers";
import { MarkerMenu, type MarkerAction } from "./timeline/MarkerMenu";
import { deleteMarkerOp, newProject, setMarkerPropsOp } from "@app/engine-client";
import { hopStep } from "./timeline/arrange";
import { ToolbarMenu } from "./timeline/ToolbarMenu";
import { chordLabel } from "./commands/registry";
import { currentKeymap } from "./commands/keymap";
import { buildScene, TICKS_PER_SECOND } from "./timeline/scene";
import { globalCommand, type Command } from "./timeline/shortcuts";
import { clampPps, fitPps, gut, ppsToSlider, shouldAutoFit, sliderToPps } from "./timeline/view";
import { zoomStore } from "./timeline/zoomStore";
import { clipMenuItems } from "./timeline/clipMenu";
import { clipSpan, speedOps, speedTarget, toRational, SPEED_PRESETS, formatSpeed } from "./inspector/speedModel";
import { TimelineCanvas, type CanvasHandle, type PlayheadSource } from "./timeline/TimelineCanvas";
import { Overview } from "./timeline/Overview";
import { TrackMenu, type TrackAction, type TrackMenuTarget } from "./timeline/TrackMenu";
import { addTrack, removeTrack, renameTrack, reorderTrack, toggleTrack, TRACK_SAY_KEYS } from "./timeline/tracks";
import { useProjectStore, useStore } from "./store/projectStore";

export const TIMELINE_SECONDS = 60;
export const END_FRAME = TIMELINE_SECONDS * FPS;

type Props = {
  playing: boolean;
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
  onDropMedia?: (id: string, tick: number, track?: string) => void;
  /** "Add media at playhead" / "Add as overlay on a new track" (the palette, the More menu): the app picks the media (the bin's concern) and puts it at `tick`. */
  onAddMedia?: (overlay: boolean, tick: number) => void;
};

const typing = (t: EventTarget | null) => t instanceof HTMLElement && !!t.closest("input, select, textarea, [contenteditable=true]");
const NO_SELECTION: ReadonlySet<string> = new Set();
const KEYS = { rippleDel: "Shift+Del", closeGap: "Ctrl+Del", undo: "Ctrl+Z", redo: "Ctrl+Shift+Z", split: "S", del: "Del", dup: "Ctrl+D", copy: "Ctrl+C", cut: "Ctrl+X", paste: "Ctrl+V" };
/** The history step name (lower case, "Undo <name>") for an edit, from the message that announces it. */
const LABELS: Record<string, string> = { "timeline.say.split": "timeline.label.split", "timeline.say.deleted": "timeline.label.deleted", "timeline.say.moved": "timeline.label.moved",
  "timeline.say.nudged": "timeline.label.nudged", "timeline.say.trimmed": "timeline.label.trimmed", "timeline.say.duplicated": "timeline.label.duplicated",
  "timeline.say.cut": "timeline.label.cut", "timeline.say.unlinked": "timeline.label.unlinked", "timeline.say.pasted": "timeline.label.pasted", "timeline.say.timed": "timeline.label.timed",
  "timeline.say.laneMoved": "timeline.label.laneMoved",  "timeline.say.rippled": "timeline.label.rippled", "timeline.say.rolled": "timeline.label.rolled", "timeline.say.slipped": "timeline.label.slipped", "timeline.say.slid": "timeline.label.slid",
  "timeline.say.rippleDeleted": "timeline.label.rippleDeleted", "timeline.say.gapClosed": "timeline.label.gapClosed",
  "timeline.say.track.added": "timeline.label.track.added", "timeline.say.track.removed": "timeline.label.track.removed", "timeline.say.track.moved": "timeline.label.track.edited", "timeline.say.track.renamed": "timeline.label.track.edited",
  ...Object.fromEntries(TRACK_SAY_KEYS.map((k) => [k, "timeline.label.track.edited"])) };
/** The first key of a registry command as shown to the user ("" when it has none). */
const keyHint = (id: string): string => { const k = currentKeymap().get(id)?.[0]; return k ? chordLabel(k) : ""; };
const tip = (label: string, keys: string) => label + " (" + keys + ")";
const DONE = { undo: ["timeline.say.undo", "timeline.say.nothing.undo"], redo: ["timeline.say.redo", "timeline.say.nothing.redo"] } as const;
const say = (key: string, values?: Say["values"]): Say => ({ key, values });

const HistoryDialog = lazy(() => import("./timeline/EditDialogs").then((m) => ({ default: m.HistoryDialog })));
const TimingDialog = lazy(() => import("./timeline/EditDialogs").then((m) => ({ default: m.TimingDialog })));

export function Timeline({ playing, onNotice, onReady, fps = FPS, endFrame = END_FRAME, engine, fileOf, readyIds = "", onDropMedia, onAddMedia }: Props) {
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
  const fallback = useMemo(() => newProject(""), []); // while the project opens the timeline is empty, not a placeholder sample (it flashed 14 fake clips and the overview bar)
  const source: Project = project ?? fallback;
  const scene = useMemo(() => buildScene(source), [source]);
  const setSelected = store.setSelection;
  const onFrame = store.setPlayhead;
  const speak = useCallback((s: Say) => announce(t(s.key, s.values)), [t]);

  const live = useRef({ scene, selected, proj });
  live.current = { scene, selected, proj };
  // The playhead is read on demand and handed to the canvas as a subscription: this component does not re-render on every tick of playback (P-3).
  const playhead = useMemo<PlayheadSource>(() => ({ get: () => store.getState().playhead, subscribe: (cb) => store.subscribe(cb) }), [store]);
  const undoLabelRef = useRef(undoLabel);
  const redoLabelRef = useRef(redoLabel);
  undoLabelRef.current = undoLabel;
  redoLabelRef.current = redoLabel;
  const canvasHandle = useRef<CanvasHandle | null>(null);
  // The in-app clipboard (copies of clips, ADR 0006: pasting inserts new clips through the engine); the dialogs of the second toolbar row.
  const [held, setHeld] = useState<readonly Held[]>([]);
  const heldRef = useRef(held);
  heldRef.current = held;
  clipboardState.copied = held.length > 0;
  clipboardState.range = scene.range !== null;
  const [tool, setTool] = useState<Tool>("select");
  /** The track last clicked: where a paste lands when no clip is selected. */
  const armed = useRef<string | null>(null);
  const [menuOpen, setMenuOpen] = useState<"tool" | "more" | null>(null);
  const [bar, setBar] = useState<DOMRect | null>(null);
  const openBar = (which: "tool" | "more", el: HTMLElement) => { setBar(el.getBoundingClientRect()); setMenuOpen(menuOpen === which ? null : which); };
  const closeBar = useCallback(() => setMenuOpen(null), []);
  const barName = menuOpen === "tool" ? t("timeline.tools") : t("timeline.more");
  const [dialog, setDialog] = useState<"history" | "timing" | null>(null);
  const [menu, setMenu] = useState<{ target: TrackMenuTarget; anchor: DOMRect } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [markerMenu, setMarkerMenu] = useState<{ id: string; anchor: DOMRect } | null>(null);
  const closeMarkerMenu = useCallback(() => setMarkerMenu(null), []);
  const openMarkerMenu = useCallback((id: string, anchor: DOMRect) => setMarkerMenu({ id, anchor }), []);
  const [clipMenu, setClipMenu] = useState<DOMRect | null>(null);
  const closeClipMenu = useCallback(() => setClipMenu(null), []);
  const closeDialog = useCallback(() => setDialog(null), []); // the native dialog hands focus back to the button that opened it
  const lengthSec = Math.max(endFrame / fps, scene.endSec);
  const lengthRef = useRef(lengthSec);
  lengthRef.current = lengthSec;
  const fitTo = useCallback((source: "fit" | "auto") => { if (canvasHandle.current) zoomStore.set(fitPps(canvasHandle.current.view, lengthRef.current), source); }, []);
  const fit = useCallback(() => fitTo("fit"), [fitTo]);
  const getHandle = useCallback(() => canvasHandle.current, []);
  const ready = useCallback((h: CanvasHandle) => { canvasHandle.current = h; onReady?.(h); }, [onReady]);
  // The first clips on an empty timeline fill the width (a 1 s clip must not be 40 px on a 30 s ruler), and an import or add that runs past the right edge
  // fits once more, unless the person set the zoom by hand (L-06). Opening a project keeps its zoom.
  const seen = useRef<{ clips: number; end: number } | null>(null);
  useEffect(() => {
    if (project === null) { seen.current = null; return; }
    const prev = seen.current;
    seen.current = { clips: scene.clipCount, end: scene.endSec };
    const h = canvasHandle.current;
    if (!prev || !h) return;
    const v = h.view;
    if (shouldAutoFit({ prevClips: prev.clips, clips: scene.clipCount, prevEndSec: prev.end, endSec: scene.endSec, visibleEndSec: (v.scrollX + v.width - gut(v)) / v.pps, userZoomed: zoomStore.userZoomed() })) fitTo("auto");
  }, [project, scene, fitTo]);

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
    const { scene: sc, selected: sel } = live.current;
    const f = store.getState().playhead;
    const ft = sc.frameTicks;
    const picked = indicesOf(sc, sel);
    const mine = editable(sc, picked);
    const locked = picked.length > 0 && mine.length === 0 ? say("timeline.locked") : null;
    const tick = Math.round((f * TICKS_PER_SECOND) / FPS);
    switch (cmd.c) {
      case "palette": window.dispatchEvent(new Event(PALETTE_EVENT)); break;
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
      case "rippleDelete": {
        if (mine.length === 0) { speak(locked ?? say("timeline.say.nothingToDelete")); break; }
        commit(rippleDeleteOps(sc, mine), say("timeline.say.rippleDeleted", { count: mine.length }));
        setSelected(NO_SELECTION);
        break;
      }
      case "closeGap": {
        const ops = closeGapOps(sc, mine);
        if (ops.length === 0) { const m = say(mine.length === 0 ? "timeline.say.selectFirst" : "timeline.say.noGap"); speak(locked ?? m); onNotice(t((locked ?? m).key)); break; }
        commit(ops, say("timeline.say.gapClosed", { count: ops.length }));
        break;
      }
      case "lane": {
        if (mine.length === 0) { speak(locked ?? say("timeline.say.selectFirst")); break; }
        const step = laneStepOps(sc, mine, cmd.dir);
        if (!step) { const m = say("timeline.say.noLane"); speak(m); onNotice(t(m.key)); break; }
        commit(step.ops, say("timeline.say.laneMoved", { track: sc.trackName[step.track]! }));
        break;
      }
      case "hop": {
        const ops = mine.length ? hopStep(sc, mine, cmd.dir) : [];
        if (ops.length === 0) { const m = say(mine.length === 0 ? "timeline.say.selectFirst" : "timeline.say.cantHop"); speak(locked ?? m); onNotice(t((locked ?? m).key)); break; }
        commit(ops, say("timeline.say.moved", { count: mine.length, name: sc.name[mine[0]!]! }));
        break;
      }
      case "addMedia": onAddMedia?.(cmd.overlay, tick); break;
      case "trackToggle": {
        const row = mine.length ? sc.clipTrack[mine[0]!]! : sc.trackId.indexOf(armed.current ?? "");
        if (row < 0) { const m = say("timeline.say.noTrack"); speak(m); onNotice(t(m.key)); break; }
        const r = toggleTrack(sc, row, cmd.part);
        if (r.ops.length === 0) { speak(r.say); onNotice(t(r.say.key, r.say.values)); break; }
        commit(r.ops, r.say);
        break;
      }
      case "tool": setTool(cmd.tool); speak(say("timeline.say.tool", { tool: cmd.tool })); break;
      case "slip": case "slide": case "roll": {
        const reps = groupReps(sc, mine);
        if (reps.length !== 1) { speak(locked ?? say("timeline.say.selectOne")); break; }
        const i = reps[0]!;
        const bad = () => { const m = say("timeline.say.cantMove"); speak(m); onNotice(t(m.key)); };
        const name = sc.name[i]!;
        if (cmd.c === "roll") {
          const cuts = rollCuts(sc, i, "end");
          if (cuts.length === 0) { const m = say("timeline.say.noCut"); speak(m); onNotice(t(m.key)); break; }
          const d = snapTo(sc, cmd.frames * ft, rollRangeAll(sc, cuts));
          if (d === 0) { bad(); break; }
          commit(rollOps(sc, cuts, d), say("timeline.say.rolled", { name, frames: Math.abs(d / ft) }));
          break;
        }
        const r = cmd.c === "slip" ? slipRange(sc, i) : slideRange(sc, i);
        const d = r ? snapTo(sc, cmd.frames * ft, r) : 0;
        if (d === 0) { bad(); break; }
        commit(cmd.c === "slip" ? slipOps(sc, i, d) : slideOps(sc, i, d), say(cmd.c === "slip" ? "timeline.say.slipped" : "timeline.say.slid", { name, frames: Math.abs(d / ft) }));
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
        const plan = planPlacement(proj0, h, tick, selectedTrack(proj0, sel) ?? armed.current, newClipId, true);
        if (plan.ops.length === 0) { const m = say("timeline.say.pasteSkipped", { count: plan.skipped }); speak(m); onNotice(t(m.key, m.values)); break; }
        commit(plan.ops, say("timeline.say.pasted", { count: plan.placed, time: timecode(Math.round((plan.start * FPS) / TICKS_PER_SECOND)) }), () => setSelected(new Set(plan.ops.map((o) => (o.op === "insert_clip" ? o.clip.id : "")))));
        if (plan.skipped > 0) onNotice(t("timeline.say.pasteSkipped", { count: plan.skipped }));
        break;
      }
      case "markerEdit": window.dispatchEvent(new CustomEvent(COMMAND_EVENT, { detail: cmd })); break; // the canvas knows where the marker's flag is
      case "marker": {
        const plan = addMarkerPlan(sc, tick, newClipId());
        if (plan.ops.length === 0) { speak(plan.say); onNotice(t(plan.say.key, plan.say.values)); break; }
        commit(plan.ops, plan.say);
        break;
      }
      case "range": {
        if (cmd.what === "play") {
          const r = sc.range ?? { start: 0, end: Math.round(sc.endSec * TICKS_PER_SECOND) };
          if (r.end <= r.start) break;
          speak(say("timeline.say.range.playing"));
          window.dispatchEvent(new CustomEvent(PLAY_RANGE_EVENT, { detail: { start: Math.ceil(r.start / ft), end: Math.floor(r.end / ft), loop: sc.loop } }));
          break;
        }
        const plan = cmd.what === "clear" ? clearRangePlan(sc) : cmd.what === "loop" ? loopPlan(sc) : rangePlan(sc, cmd.what === "in" ? "start" : "end", tick);
        if (plan.ops.length === 0) { speak(plan.say); onNotice(t(plan.say.key, plan.say.values)); break; }
        commit(plan.ops, plan.say);
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
  }, [speak, commit, undoRedo, onNotice, t, setSelected, store, onAddMedia]);

  /** A speed preset from the clip menu: the same edit as the Speed inspector (one undo step, a linked sound follows). */
  const setSpeed = useCallback((x: number) => {
    const target = speedTarget(live.current.proj.project, live.current.selected), r = toRational(x);
    if (!target || target.still || !r) return;
    const label = t("speed.undoLabel");
    live.current.proj.apply(speedOps(target.group, r, false), undefined, label)
      .then(() => { const span = clipSpan(store.getState().project, target.clip.id); if (span) announce(t("speed.announce", { speed: formatSpeed(x), ...span })); })
      .catch(() => onNotice(t("speed.failed")));
  }, [store, onNotice, t]);
  const trackAction = useCallback((a: TrackAction) => {
    const sc = live.current.scene;
    const r = a.a === "toggle" ? toggleTrack(sc, a.track, a.part)
      : a.a === "rename" ? renameTrack(sc, a.track, a.name)
      : a.a === "remove" ? removeTrack(sc, a.track)
      : a.a === "move" ? reorderTrack(sc, a.track, a.to)
      : addTrack(sc, a.kind, newClipId());
    if (r && r.ops.length === 0) { speak(r.say); onNotice(t(r.say.key, r.say.values)); return; }
    if (r) commit(r.ops, r.say);
  }, [commit, speak, onNotice, t]);
  const markerAction = useCallback((a: MarkerAction) => {
    const op = a.a === "rename" ? setMarkerPropsOp(a.id, { name: a.name }) : a.a === "colour" ? setMarkerPropsOp(a.id, { colour: a.colour }) : a.a === "chapter" ? setMarkerPropsOp(a.id, { kind: a.chapter ? "chapter" : "marker" }) : deleteMarkerOp(a.id);
    commit([op], say(a.a === "delete" ? "timeline.say.marker.deleted" : "timeline.say.marker.edited"));
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
      <div className="tl-bar" data-testid="tl-bar">
        <div className="tl-group" role="toolbar" aria-label={t("timeline.edit")}>
          <button className="icon-btn" aria-label={undoText} title={tip(undoText, KEYS.undo)} disabled={off || !proj.canUndo} onClick={() => run({ c: "undo" })}><Icon name="undo" /></button>
          <button className="icon-btn" aria-label={redoText} title={tip(redoText, KEYS.redo)} disabled={off || !proj.canRedo} onClick={() => run({ c: "redo" })}><Icon name="redo" /></button>
          <span className="sep" aria-hidden="true" />
          <button className="icon-btn" aria-label={t("timeline.split")} title={tip(t("timeline.split"), KEYS.split)} disabled={off} onClick={() => run({ c: "split" })}><Icon name="split" /></button>
          <span className="sep" aria-hidden="true" />
          <button className="icon-btn" aria-label={t("timeline.delete")} title={tip(t("timeline.delete"), KEYS.del)} disabled={off || none} onClick={() => run({ c: "delete" })}><Icon name="trash" /></button>
          <button className="icon-btn tl-wide" aria-label={t("timeline.rippleDelete")} title={tip(t("timeline.rippleDelete"), KEYS.rippleDel)} data-testid="tl-ripple-delete" disabled={off || none} onClick={() => run({ c: "rippleDelete" })}><Icon name="rippleDelete" /></button>
          <span className="sep tl-wide" aria-hidden="true" />
          <button className={tool === "select" ? "tl-pick" : "tl-pick on"} aria-haspopup="menu" aria-expanded={menuOpen === "tool"} data-testid="tl-tool" data-tool={tool} title={t("timeline.tool.pick")}
            aria-label={t("timeline.tool.current", { tool: t(`timeline.tool.${tool}`) })} onClick={(e) => openBar("tool", e.currentTarget)}>
            <span>{t(`timeline.tool.${tool}`)}</span><Icon name="chevronDown" size={14} className="tl-caret" />
          </button>
          <button className="tl-pick" aria-haspopup="menu" aria-expanded={menuOpen === "more"} data-testid="tl-more" title={t("timeline.more")} onClick={(e) => openBar("more", e.currentTarget)}>
            <span>{t("timeline.more")}</span><Icon name="chevronDown" size={14} className="tl-caret" />
          </button>
        </div>
        <div className="tl-right">
          {!none && <span className="tl-sel" data-testid="tl-selected">{withLinked ? t("timeline.selected.linked", { count: clipCount }) : t("timeline.selected", { count: clipCount })}</span>}
          <ZoomBar onFit={fit} />
        </div>
      </div>
      {menuOpen && bar && <ToolbarMenu name={barName} anchor={bar} onClose={closeBar} testid={menuOpen === "tool" ? "tl-tool-menu" : "tl-more-menu"}
        items={menuOpen === "tool" ? TOOLS.map((k) => ({ id: k, label: t(`timeline.tool.${k}`), hint: keyHint(`tool.${k}`), checked: tool === k, testid: `tl-tool-${k}`, onSelect: () => run({ c: "tool", tool: k }) }))
          : [
            { id: "duplicate", section: t("timeline.more.clip"), label: t("timeline.duplicate"), hint: KEYS.dup, disabled: off || none, reason: t("timeline.why.select"), testid: "tl-duplicate", onSelect: () => run({ c: "duplicate" }) },
            { id: "copy", label: t("timeline.copy"), hint: KEYS.copy, disabled: off || none, reason: t("timeline.why.select"), testid: "tl-copy", onSelect: () => run({ c: "copy" }) },
            { id: "cut", label: t("timeline.cut"), hint: KEYS.cut, disabled: off || none, reason: t("timeline.why.select"), testid: "tl-cut", onSelect: () => run({ c: "cut" }) },
            { id: "paste", label: t("timeline.paste"), hint: KEYS.paste, disabled: off || held.length === 0, reason: t("timeline.why.copied"), testid: "tl-paste", onSelect: () => run({ c: "paste" }) },
            { id: "unlink", label: t("timeline.unlink"), disabled: off || !anyLinked, reason: t("timeline.why.linked"), testid: "tl-unlink", onSelect: () => run({ c: "unlink" }) },
            { id: "rdel", label: t("timeline.rippleDelete"), hint: KEYS.rippleDel, disabled: off || none, reason: t("timeline.why.select"), testid: "tl-ripple-delete-menu", onSelect: () => run({ c: "rippleDelete" }) },
            { id: "gap", label: t("timeline.closeGap"), hint: KEYS.closeGap, disabled: off || none, reason: t("timeline.why.select"), testid: "tl-close-gap", onSelect: () => run({ c: "closeGap" }) },
            { id: "timing", label: t("timeline.timing"), disabled: off || !oneClip, reason: t("timeline.why.one"), testid: "tl-timing", onSelect: () => setDialog("timing") },
            { id: "history", disabled: off, label: t("timeline.history"), testid: "tl-history", onSelect: () => setDialog("history") },
            ...(onAddMedia ? [
              { id: "addm", section: t("timeline.more.media"), disabled: off, label: t("timeline.addMedia.atPlayhead"), testid: "tl-add-media", onSelect: () => run({ c: "addMedia", overlay: false }) },
              { id: "addo", disabled: off, label: t("timeline.addMedia.overlay"), testid: "tl-add-overlay", onSelect: () => run({ c: "addMedia", overlay: true }) },
            ] : []),
            { id: "addv", section: t("timeline.more.tracks"), disabled: off, label: t("timeline.track.addVideo"), testid: "track-add-video", onSelect: () => trackAction({ a: "add", kind: "video" }) },
            { id: "adda", disabled: off, label: t("timeline.track.addAudio"), testid: "track-add-audio", onSelect: () => trackAction({ a: "add", kind: "audio" }) },
            { id: "topts", label: t("timeline.track.optionsButton"), disabled: off || oneIdx.length === 0, reason: t("timeline.why.select"), testid: "tl-track-options", onSelect: () => openMenu({ kind: "track", track: scene.clipTrack[oneIdx[0]!]! }, bar!) },
            { id: "mark", section: t("timeline.more.markers"), disabled: off, label: t("timeline.marker.add"), hint: keyHint("marker.add"), testid: "tl-marker-add", onSelect: () => run({ c: "marker" }) },
            { id: "medit", label: t("timeline.marker.edit"), disabled: off || !scene.markers.some((m) => m.ticks === Math.round((store.getState().playhead * TICKS_PER_SECOND) / FPS)), reason: t("timeline.why.marker"), testid: "tl-marker-edit", onSelect: () => run({ c: "markerEdit" }) },
            { id: "rin", label: t("timeline.range.in"), disabled: off, hint: keyHint("range.in"), testid: "tl-range-in", onSelect: () => run({ c: "range", what: "in" }) },
            { id: "rout", label: t("timeline.range.out"), disabled: off, hint: keyHint("range.out"), testid: "tl-range-out", onSelect: () => run({ c: "range", what: "out" }) },
            { id: "rplay", label: t("timeline.range.play"), disabled: off || scene.clipCount === 0, reason: t("timeline.why.clips"), hint: keyHint("range.play"), testid: "tl-range-play", onSelect: () => run({ c: "range", what: "play" }) },
            { id: "rloop", label: t("timeline.range.loop"), disabled: off || !scene.range, reason: t("timeline.why.range"), testid: "tl-range-loop", onSelect: () => run({ c: "range", what: "loop" }) },
            { id: "rclear", label: t("timeline.range.clear"), disabled: off || !scene.range, reason: t("timeline.why.range"), hint: keyHint("range.clear"), testid: "tl-range-clear", onSelect: () => run({ c: "range", what: "clear" }) },
            { id: "zin", section: t("timeline.more.view"), label: t("timeline.zoomIn"), onSelect: () => zoomStore.set(clampPps(zoomStore.get() * 1.25), "user") },
            { id: "zout", label: t("timeline.zoomOut"), onSelect: () => zoomStore.set(clampPps(zoomStore.get() / 1.25), "user") },
            { id: "fit", label: t("timeline.fit"), hint: "0", testid: "tl-fit-menu", onSelect: fit },
            { id: "zsel", label: t("timeline.zoomSelection"), hint: keyHint("view.zoomSelection"), disabled: off || none, reason: t("timeline.why.select"), testid: "tl-zoom-selection", onSelect: () => window.dispatchEvent(new CustomEvent(COMMAND_EVENT, { detail: { c: "zoom", how: "selection" } })) },
          ]} />}
      {dialog === "history" && <Suspense fallback={null}><HistoryDialog onClose={closeDialog} onJumped={(what) => { speak(say("history.jumped", { what })); onNotice(t("history.jumped", { what })); }} /></Suspense>}
      {dialog === "timing" && oneClip && <Suspense fallback={null}><TimingDialog scene={scene} clip={oneClip[0]!} fps={fps} onClose={closeDialog}
        onApply={(ops, field, name) => commit(mirrorTrims(scene, ops), say("timeline.say.timed", { field, name }))} /></Suspense>}
      {clipMenu && <ToolbarMenu name={t("timeline.clipMenu")} anchor={clipMenu} onClose={closeClipMenu} testid="tl-clip-menu"
        items={clipMenuItems({ clips: clipCount, anyLinked, allLocked: oneIdx.length > 0 && editable(scene, oneIdx).length === 0, still: speedTarget(project, selected)?.still ?? false }).map((it) => {
          const speed = it.id.startsWith("speed:") ? Number(it.id.slice(6)) : null;
          const label = speed !== null ? formatSpeed(speed) : it.id === "split" ? t("timeline.split") : it.id === "duplicate" ? t("timeline.duplicate") : it.id === "delete" ? t("timeline.delete") : it.id === "rippleDelete" ? t("timeline.rippleDelete") : t("timeline.unlink");
          const hint = it.id === "split" ? KEYS.split : it.id === "duplicate" ? KEYS.dup : it.id === "delete" ? KEYS.del : it.id === "rippleDelete" ? KEYS.rippleDel : "";
          const cmd: Command | null = it.id === "split" ? { c: "split" } : it.id === "duplicate" ? { c: "duplicate" } : it.id === "delete" ? { c: "delete" } : it.id === "rippleDelete" ? { c: "rippleDelete" } : it.id === "unlink" ? { c: "unlink" } : null;
          return { id: it.id, section: it.id === "split" ? t("timeline.more.clip") : speed === SPEED_PRESETS[0] ? t("timeline.speed.section") : undefined, label, hint, disabled: it.disabled, reason: it.why ? t(`timeline.why.${it.why}`) : undefined,
            testid: `tl-clip-${it.id.replace(":", "-")}`, onSelect: () => (cmd ? run(cmd) : setSpeed(speed!)) };
        })} />}
      {markerMenu && scene.markers.find((m) => m.id === markerMenu.id) && <MarkerMenu marker={scene.markers.find((m) => m.id === markerMenu.id)!} anchor={markerMenu.anchor} onAct={markerAction} onClose={closeMarkerMenu} />}
      {menu && <TrackMenu scene={scene} target={menu.target} anchor={menu.anchor} onAct={trackAction} onClose={closeMenu} />}
      <div className="tl-stage">
        {scene.clipCount === 0 && <p className="tl-empty" data-testid="tl-empty">{t("timeline.empty")}</p>}
        <TimelineCanvas scene={scene} fps={fps} playhead={playhead} endFrame={endFrame} playing={playing} onFrame={onFrame} summary={summary}
          selected={selected} onSelect={(ids) => { const all = expandLinks(scene, ids); setSelected(all.size === ids.size ? ids : all); }} onEdit={commit} onCommand={run} onAnnounce={speak} onNotice={(s) => onNotice(t(s.key, s.values))} onReady={ready} media={media} onDropMedia={onDropMedia} onTrackMenu={(track, at) => openMenu({ kind: "track", track }, at)} onMarkerMenu={openMarkerMenu} onClipMenu={(at) => setClipMenu(at)} tool={tool} onLane={(id) => { armed.current = id; }} />
      </div>
      <Overview scene={scene} lengthSec={lengthSec} handle={getHandle} />
    </section>
  );
}

/** The zoom slider and buttons. Subscribed to the zoom store on its own, so a wheel or pinch zoom re-renders only this strip, not the editor (P-2). */
const ZoomBar = memo(function ZoomBar({ onFit }: { onFit: () => void }) {
  const { t } = useI18n();
  const zoom = useSyncExternalStore(zoomStore.subscribe, zoomStore.get, zoomStore.get);
  return (
    <label className="zoom">
      <button type="button" className="icon-btn tl-wide" aria-label={t("timeline.zoomOut")} title={tip(t("timeline.zoomOut"), "-")} onClick={() => zoomStore.set(clampPps(zoomStore.get() / 1.25), "user")}><Icon name="minus" size={18} /></button>
      <input type="range" min={0} max={1} step={0.005} value={ppsToSlider(zoom)} onChange={(e) => zoomStore.set(sliderToPps(Number(e.target.value)), "user")} aria-label={t("timeline.zoom")} />
      <button type="button" className="icon-btn tl-wide" aria-label={t("timeline.zoomIn")} title={tip(t("timeline.zoomIn"), "+")} onClick={() => zoomStore.set(clampPps(zoomStore.get() * 1.25), "user")}><Icon name="plus" size={18} /></button>
      <button type="button" className="icon-btn tl-fit" aria-label={t("timeline.fit")} title={tip(t("timeline.fit"), "0")} data-testid="tl-fit" onClick={onFit}><Icon name="fit" size={18} /></button>
    </label>
  );
});
