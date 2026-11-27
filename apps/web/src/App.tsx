import { LEGACY_PROJECT_ID, createEngine, newProject, summarize, summarizeExtra, type ProjectEntry, type SnapshotKind, type Engine, type EngineBackend, type EngineInfo, type Op, type Project } from "@app/engine-client";
import { installKeepFocus } from "./a11y/keepFocus";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { announce } from "./a11y/announcer";
import { useRovingTabindex } from "./a11y/roving";
import { reportAppInfo } from "./errorScreen/crash";
import { reportFatal } from "./errorScreen/ErrorScreen";
import { useI18n } from "./i18n";
import { useIncoming } from "./incoming";
import { Icon, type IconName } from "./icons";
import { PersistenceNotes, usePersistence } from "./persistence";
import { useBackClose } from "./layout/backStack";
import { useKeyboardInset } from "./layout/useKeyboardInset";
import { Home } from "./Home";
import { capturePoster } from "./posterSource";
import { createProject, deleteProject, duplicateProject, getRegistry, loadProjects, projectBytes, setArchived } from "./projects";
import { isArchived, startScreen } from "./projectsView";
import { CanvasDialog, ConfirmDialog, PrivacyDialog } from "./ProjectDialogs";
import { confirmBodyKey, toastDuration } from "./projectConfirm";
import { canvasSummary, hasPicture } from "./canvas";
import { nameOfFile, pickProjectFile, projectFileName, saveProjectBytes } from "./projectFile";
import { PreviewPanel, sequenceView } from "./PreviewPanel";
import { ProjectStore, ProjectStoreProvider, useProjectStore } from "./store/projectStore";
import { Inspector } from "./inspector/Inspector";
import { SpeedSection } from "./inspector/Speed";
import { Timeline } from "./Timeline";
import { AccentPicker, InstallItem, ScrubPrepItem } from "./AppearanceInstall";
import { THEME_PREFS, applyTheme, loadPref, savePref, watchSystem, type ThemePref } from "./theme/theme";
import { ThemeMenu } from "./ThemeMenu";
import { ExportControl } from "./export/ExportDialog";
const ShortcutsDialog = lazy(() => import("./commands/ShortcutsDialog").then((m) => ({ default: m.ShortcutsDialog })));
import { Palette } from "./commands/Palette";
import { PALETTE_EVENT } from "./commands/palette";
import { currentKeymap } from "./commands/keymap";
import { chordLabel } from "./commands/registry";
/** The palette's first key as the user sees it (Ctrl+K, or whatever it was remapped to). */
const paletteKey = (): string => chordLabel(currentKeymap().get("app.palette")?.[0] ?? "Mod+K");
import { VersionsDialog, useAutoSnapshots } from "./Versions";
import { binMeta, type BinMeta } from "./media/binView";
import { MediaBin } from "./media/MediaBin";
import { newId, TICKS } from "./media/plan";
import { mediaToAdd } from "./timeline/addMedia";
import { buildScene } from "./timeline/scene";
import { addTrack } from "./timeline/tracks";
import { BIN_DRAG_TYPE, dragHasFiles, fromDataTransfer, fromFileList, getDesktop, pickMany, pickOne, setDesktop, setNativeMedia, type Source } from "./media/sources";
import { useShellProfile } from "./layout/useShellProfile";
import { Splitter } from "./layout/Splitter";
import { SheetHandle } from "./layout/SheetHandle";
import { MiniTransport } from "./layout/MiniTransport";
import { useCollapsed } from "./layout/useCollapsed";
import type { Detent } from "./layout/sheet";
import { useMediaBin, type BinItem } from "./media/useMediaBin";

type EngineState = { status: "loading" } | { status: "ready"; info: EngineInfo; backend: EngineBackend; engine: Engine } | { status: "error"; message: string };

type Tool = { id: string; icon: IconName; soon?: string };
/** M1 ships Media only. Tools with a `soon` milestone, and the Details panel, are kept in the code for the milestone that builds them but are not shown:
 *  a first-time user must not click into empty promises. Flip `DETAILS_READY` when Details has real controls. */
const DETAILS_READY = true;
export const shown = (x: Tool): boolean => (x.soon ? false : x.id === "edit" ? DETAILS_READY : true);
/** CapCut-style tool strip: the left rail on desktop and tablet, the bottom bar on a phone. */
const TOOLS: Tool[] = [
  { id: "media", icon: "media" },
  { id: "audio", icon: "audio", soon: "M3" },
  { id: "text", icon: "text", soon: "M3" },
  { id: "captions", icon: "captions", soon: "M3" },
  { id: "effects", icon: "effects", soon: "M4" },
  { id: "transitions", icon: "transitions", soon: "M4" },
  { id: "filters", icon: "filters", soon: "M4" },
  { id: "stickers", icon: "stickers", soon: "M4" },
  { id: "edit", icon: "edit" },
];

function EmptyState({ icon, title, text }: { icon: IconName; title: string; text: string }) {
  return (
    <div className="empty">
      <span className="empty-icon"><Icon name={icon} size={26} /></span>
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  );
}

type BinProps = {
  items: BinItem[];
  onImport: (s: Source[]) => void;
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
  onRelink: (id: string) => void;
  onRelinkAll?: () => void;
  meta: BinMeta;
  onTags: (id: string, tags: readonly string[]) => void;
};

/** The header button that folds a docked side panel into a slim strip (tablet and up; phones use a sheet with its own close button). */
function CollapseButton({ panel, onClick }: { panel: string; onClick(): void }) {
  const { t, dir } = useI18n();
  return <button className="icon-btn panel-collapse" aria-label={t("panel.collapse", { panel })} title={t("panel.collapse", { panel })} onClick={onClick} data-testid="panel-collapse"><Icon name={dir === "rtl" ? "chevronRight" : "chevronLeft"} size={18} /></button>;
}

function Library({ tool, bin, onCollapse }: { tool: Tool; bin: BinProps; onCollapse(): void }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const label = t(`tool.${tool.id}.label`);
  const search = t("panel.search", { tool: label.toLowerCase() });
  return (
    <>
      <header className="panel-head">
        <h2>{label}</h2>
        {tool.soon && <span className="pill">{t("panel.coming", { milestone: tool.soon })}</span>}
        <CollapseButton panel={label} onClick={onCollapse} />
      </header>
      <label className="search">
        <Icon name="search" size={18} />
        <input type="search" placeholder={search} aria-label={search} disabled={!!tool.soon} value={tool.id === "media" ? query : ""} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <div className="panel-body">
        {tool.id === "media" ? (
          <MediaBin {...bin} query={query} />
        ) : (
          <EmptyState icon={tool.icon} title={label} text={t(`tool.${tool.id}.blurb`)} />
        )}
      </div>
    </>
  );
}

/** Only tabs with real content. Animation lives inline in Video (keyframes); Audio and Adjust come back when they are built. Speed shows only while a clip is selected. */
type DetailTab = "video" | "speed";
function Details({ onCollapse }: { onCollapse?: () => void }) {
  const { t, dir } = useI18n();
  const hasSelection = useProjectStore((s) => s.selection.size > 0);
  const tabs: readonly DetailTab[] = hasSelection ? ["video", "speed"] : ["video"];
  const [picked, setTab] = useState<DetailTab>("video");
  const tab: DetailTab = tabs.includes(picked) ? picked : "video";
  const roving = useRovingTabindex(tabs.length, { rtl: dir === "rtl", onMove: (i) => setTab(tabs[i]!) });
  return (
    <>
      <header className="panel-head"><h2>{t("details.title")}</h2>{onCollapse && <CollapseButton panel={t("details.title")} onClick={onCollapse} />}</header>
      {/* One tab is no choice: a plain heading above is enough, the tab bar appears with the second tab (a clip is selected). */}
      {tabs.length > 1 && (
        <div className="segmented" role="tablist" aria-label={t("details.tabs")}>
          {tabs.map((id, i) => (
            <button key={id} role="tab" aria-selected={tab === id} {...roving.itemProps(i)} onClick={() => setTab(id)}>{t(`details.tab.${id}`)}</button>
          ))}
        </div>
      )}
      <div className="panel-body insp-body">
        {tab === "speed" ? <SpeedSection /> : <Inspector />}
      </div>
    </>
  );
}

/** The "..." menu: small, out of the way. Holds About / Diagnostics, and on small phones (`compact`) the theme toggle and engine status that
 *  no longer fit the top bar next to the project name and Export. */
function AppMenu({ compact, theme, status, save, project }: { compact: boolean; theme: { name: string; pref: ThemePref; onPick(p: ThemePref): void }; status: ReactNode; save: { state: string; text: string }; project: { onProjects(): void; onNew(): void; onOpen(): void; onSave(): void; onPrivacy(): void; onVersions(): void; onShortcuts(): void; onPalette(): void } }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // A row that opens a dialog: focus goes to the menu button first, so the dialog returns focus there when it closes (the row itself is gone by then).
  const opening = (run: () => void) => () => { trigger.current?.focus({ preventScroll: true }); setOpen(false); run(); };
  // Desktop app: where projects are saved. The open project stays where it is; the new folder is used from the next start.
  const chooseFolder = async () => {
    try {
      const dir = await getDesktop()?.chooseProjectsFolder();
      if (dir) announce(t("menu.projectsFolder.set", { path: dir }), "polite");
    } catch {
      announce(t("menu.projectsFolder.failed"), "assertive");
    }
  };
  useEffect(() => {
    if (!open) return;
    const rows = () => [...(ref.current?.querySelectorAll<HTMLElement>(".menu-pop button, .menu-pop a[href]") ?? [])];
    rows()[0]?.focus({ preventScroll: true }); // keyboard users land on the first item, not on the button they came from
    const away = (e: Event) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); trigger.current?.focus({ preventScroll: true }); return; }
      if (e.key === "Tab" && ref.current?.contains(document.activeElement)) { e.preventDefault(); setOpen(false); trigger.current?.focus({ preventScroll: true }); return; } // Tab leaves the menu (like Esc), it does not walk into the page behind the popover
      const list = rows();
      const at = list.indexOf(document.activeElement as HTMLElement);
      const go = e.key === "ArrowDown" ? at + 1 : e.key === "ArrowUp" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : null;
      if (go === null || list.length === 0 || !ref.current?.contains(document.activeElement)) return;
      e.preventDefault();
      list[(go + list.length) % list.length]!.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", key); };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button ref={trigger} className="icon-btn" aria-label={t("menu.open")} title={t("menu.open")} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((o) => !o)}><Icon name="more" size={20} /></button>
      {open && (
        <div className="menu-pop" role="menu">
          <button className="menu-row" role="menuitem" data-testid="menu-palette" onClick={opening(project.onPalette)}><Icon name="search" size={16} className="menu-ic" /><span>{t("palette.open")}</span>{!compact && <kbd className="menu-hint">{paletteKey()}</kbd>}</button>
          {compact && (
            <>
              {/* Small phones: the theme choices are listed here (F3), not cycled; a heading says what the three rows are. */}
              <div className="menu-group" role="presentation">{t("theme.label")}</div>
              {THEME_PREFS.map((p) => (
                <button key={p} className="menu-row" role="menuitemradio" aria-checked={p === theme.pref} data-testid={`theme-${p}`} onClick={() => theme.onPick(p)}><span className="menu-check" aria-hidden="true">{p === theme.pref && <Icon name="check" size={16} />}</span><span>{t(`theme.${p}`)}</span></button>
              ))}
              <div className="menu-row menu-status" role="presentation">{status}</div>
              {/* On small phones the top-bar save chip is screen-reader only, so the plain save state is shown here as well. */}
              <div className="menu-row menu-status save-row" role="presentation" data-testid="save-state-menu" data-state={save.state}><span className="dot" aria-hidden="true" data-state={save.state} /><span>{save.text}</span></div>
            </>
          )}
          <div className="menu-group" role="presentation">{t("menu.group.project")}</div>
          <button className="menu-row" role="menuitem" data-testid="menu-projects" onClick={opening(project.onProjects)}><Icon name="archive" size={16} className="menu-ic" /><span>{t("menu.projects")}</span></button>
          <button className="menu-row" role="menuitem" data-testid="menu-new" onClick={opening(project.onNew)}><Icon name="plus" size={16} className="menu-ic" /><span>{t("menu.new")}</span></button>
          <button className="menu-row" role="menuitem" data-testid="menu-open" onClick={opening(project.onOpen)}><Icon name="upload" size={16} className="menu-ic" /><span>{t("menu.openProject")}</span></button>
          <button className="menu-row" role="menuitem" data-testid="menu-save" onClick={opening(project.onSave)}><Icon name="download" size={16} className="menu-ic" /><span>{t("menu.saveProject")}</span></button>
          {getDesktop() && <button className="menu-row" role="menuitem" data-testid="menu-projects-folder" onClick={() => { setOpen(false); void chooseFolder(); }}><Icon name="archive" size={16} className="menu-ic" /><span>{t("menu.projectsFolder")}</span></button>}
          <button className="menu-row" role="menuitem" data-testid="menu-versions" onClick={opening(project.onVersions)}><Icon name="history" size={16} className="menu-ic" /><span>{t("menu.versions")}</span></button>
          <div className="menu-group" role="presentation">{t("menu.group.view")}</div>
          <AccentPicker />
          <ScrubPrepItem />
          <div className="menu-group" role="presentation">{t("menu.group.help")}</div>
          <button className="menu-row" role="menuitem" data-testid="menu-shortcuts" onClick={opening(project.onShortcuts)}><Icon name="keyboard" size={16} className="menu-ic" /><span>{t("menu.shortcuts")}</span></button>
          <button className="menu-row" role="menuitem" data-testid="menu-privacy" onClick={opening(project.onPrivacy)}><Icon name="shield" size={16} className="menu-ic" /><span>{t("menu.privacy")}</span></button>
          <InstallItem desktopApp={!!getDesktop()} onDone={() => setOpen(false)} />
          <a role="menuitem" href="/diagnostics"><Icon name="activity" size={16} className="menu-ic" /><span>{t("menu.diagnostics")}</span></a>
        </div>
      )}
    </div>
  );
}

/** The app owns one project store; every panel below reads it. */
export function App() {
  const [store] = useState(() => new ProjectStore());
  useEffect(() => installKeepFocus(), []); // a button that turns itself off (Delete, Redo, Reset) hands keyboard focus on instead of dropping it to the page
  // Test hook (`?e2e`): the store the panels read, so a test can edit through the same path the UI does (`window.__overcutStore.apply(ops)`).
  useEffect(() => { if (new URLSearchParams(location.search).has("e2e")) (window as unknown as { __overcutStore: ProjectStore }).__overcutStore = store; }, [store]);
  return <ProjectStoreProvider store={store}><Editor store={store} /></ProjectStoreProvider>;
}

function Editor({ store }: { store: ProjectStore }) {
  const { t } = useI18n();
  const [themePref, setThemePref] = useState<ThemePref>(loadPref);
  const [engine, setEngine] = useState<EngineState>({ status: "loading" });
  const [core, setCore] = useState<Engine | null>(null);
  const [openId, setOpenId] = useState<string | null>(null); // the project being edited; null while the projects list shows (or is still loading)
  const [list, setList] = useState<ProjectEntry[] | null>(null); // null until the list is read
  const [lastId, setLastId] = useState<string | null>(null);
  const [homeBusy, setHomeBusy] = useState(false);
  const persistence = usePersistence(core, openId);
  const [tool, setTool] = useState("media");
  const [sheet, setSheet] = useState(false); // phone only: tool panel open above the bottom bar
  const [detent, setDetent] = useState<Detent>("half"); // phone only: how tall that sheet is (small / half / full)
  const [libCollapsed, setLibCollapsed] = useCollapsed("library");
  const [inspCollapsed, setInspCollapsed] = useCollapsed("inspector");
  const workspaceRef = useRef<HTMLElement>(null);
  const [name, setName] = useState<string | null>(null); // null = the localized default name
  const [dialog, setDialog] = useState<null | "canvas" | "privacy" | "versions" | "shortcuts" | { title: string; body: string; confirm: string; danger: boolean; run(): Promise<void> }>(null);
  const [offlineHidden, setOfflineHidden] = useState(false); // the "files are missing" note was dismissed for this project (it is shown whenever media is not on this device)
  const [playing, setPlaying] = useState(false);
  const [palette, setPalette] = useState(false); // the command palette (Ctrl/Cmd+K, the top-bar button, the app menu)
  useEffect(() => { const open = () => setPalette(true); window.addEventListener(PALETTE_EVENT, open); return () => window.removeEventListener(PALETTE_EVENT, open); }, []);
  const [toast, setToast] = useState<string | null>(null);
  const [refusals, setRefusals] = useState<string[]>([]); // phone: files refused in an import, kept on screen until dismissed (the Media sheet closes after a successful one)
  // F3: the theme is picked from a small menu (System, Dark, Light, High contrast), not cycled.
  const pickTheme = (next: ThemePref) => {
    savePref(next);
    setThemePref(next);
    const theme = applyTheme(next);
    announce(t("theme.changed", { theme: t(`theme.${next === "system" ? "system" : theme}`) }));
  };
  useEffect(() => watchSystem(() => loadPref(), () => undefined), []);
  const editorRef = useRef<HTMLDivElement>(null);
  const { profile, compact } = useShellProfile(editorRef); // compact: small phone, theme toggle and engine status live in the "..." menu
  const wide = profile === "desktop" || profile === "ultrawide"; // details panel gets its own column
  const roomy = profile === "tablet" || wide; // tablet and up: the tool panel is always docked open (phones: a sheet)

  useEffect(() => {
    let alive = true;
    // After the shell has painted (not inside the first frame's work): the engine's download and compile start on the next task.
    let timer = 0;
    const raf = requestAnimationFrame(() => { timer = window.setTimeout(start, 0); });
    function start() {
    createEngine()
      .then(async (e) => ({ info: await e.info(), backend: e.backend, engine: e }))
      .then(({ engine: e, ...r }) => alive && (reportAppInfo({ version: r.info.version, backend: r.backend }), setDesktop(e.desktop), setNativeMedia(e.desktop ? e.media : undefined), setEngine({ status: "ready", engine: e, ...r }), setCore(e)))
      .catch((e: unknown) => alive && (setEngine({ status: "error", message: e instanceof Error ? e.message : String(e) }), reportFatal("engine-start", e)));
    }
    return () => { alive = false; cancelAnimationFrame(raf); window.clearTimeout(timer); };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toastDuration(toast)); // 3 s; longer text a little longer, never more than 5 s
    return () => clearTimeout(t);
  }, [toast]);

  const soon = useCallback((m: string) => setToast(m), []);

  // ---- the shared project: fed by the persistence session's editing surface (autosaving), or the bare engine when storage is unavailable ----
  const editing = persistence.session?.editing ?? (persistence.problem && core ? core.editing : null);
  // A recovered session already has undo history (the replayed edits); "undo recovery" (epoch > 0) starts a fresh one.
  const replayed = useRef(0);
  replayed.current = persistence.recovered?.replayed ?? 0;
  // "?" opens the keyboard shortcuts anywhere in the editor except while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?" || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      e.preventDefault();
      setDialog((d) => d ?? "shortcuts");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => { void store.attach(editing, { canUndo: persistence.epoch === 0 && replayed.current > 0 }); }, [store, editing, persistence.epoch]); // epoch: undo recovery replaced the project
  const project = useProjectStore((s) => s.project);

  // ---- media import (M1-032) ----
  const media = useMediaBin(core, editing, !!persistence.session, t("app.untitled"), {
    notMedia: (n) => t("media.err.notMedia", { name: n }),
    unsupported: (n, ext, detail) => t("media.err.unsupported", { name: n, ext: ext || "?", detail }),
    failed: (n) => t("media.err.failed", { name: n }),
    imported: (count) => t("media.imported", { count }),
    importLabel: (name) => t("media.importLabel", { name }),
    announce,
    refused: (m) => setRefusals((all) => (all.includes(m) ? all : [...all, m])),
  });
  const importFiles = media.importSources;
  // Phone: the Media sheet covers the Split / Undo toolbar, so it closes once an import has succeeded (the bin is one tap away on the tool bar).
  const readyCount = media.items.filter((i) => i.status === "ready").length;
  const readyBefore = useRef(readyCount);
  useEffect(() => {
    if (readyCount > readyBefore.current && !roomy) setSheet(false);
    readyBefore.current = readyCount;
  }, [readyCount, roomy]);
  /** "Add media at playhead" / "Add as overlay on a new track": the selected clip's media, else the newest card in the bin (T-01). */
  /** The overlay just added is the thing to size next: select it (picture and its linked sound), so its on-canvas handles and Details show at once. */
  const selectOverlay = useCallback((trackId: string) => {
    const project = store.getState().project;
    const all = project?.sequences[0]?.tracks.flatMap((tr) => tr.clips) ?? [];
    const mine = all.filter((c) => project?.sequences[0]?.tracks.find((tr) => tr.id === trackId)?.clips.some((x) => x.id === c.id));
    if (mine.length === 0) return;
    const links = new Set(mine.map((c) => c.link).filter(Boolean));
    store.setSelection(new Set(all.filter((c) => mine.includes(c) || (c.link && links.has(c.link))).map((c) => c.id)));
  }, [store]);
  const addMediaAt = useCallback((overlay: boolean, tick: number) => {
    const st = store.getState();
    const id = mediaToAdd(st.project, st.selection, media.items);
    if (!id) { soon(t("timeline.addMedia.none")); return; }
    const done = (ok: boolean) => { if (ok) announce(t("media.added")); };
    const kind = media.items.find((i) => i.id === id)?.kind;
    if (overlay && kind !== "audio" && st.project) { // a new video track on top, then the clip on it (two undo steps: the track, then the clip)
      const track = newId();
      void store.apply(addTrack(buildScene(st.project), "video", track).ops).then(() => media.addToTimeline(id, tick, track)).then((ok) => { done(ok); if (ok) selectOverlay(track); }).catch(() => soon(t("timeline.say.failed")));
    } else void media.addToTimeline(id, tick).then(done);
  }, [store, media, soon, t, selectOverlay]);
  // History and Timing dialogs (lazy chunks in the timeline's More menu): fetched while the browser is idle once there is something to edit, so they open at once.
  const hasMedia = readyCount > 0;
  useEffect(() => {
    if (!hasMedia) return;
    const w = window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (h: number) => void };
    const load = () => { void import("./timeline/EditDialogs").catch(() => undefined); void import("./commands/ShortcutsDialog").catch(() => undefined); };
    if (w.requestIdleCallback) { const h = w.requestIdleCallback(load, { timeout: 5000 }); return () => w.cancelIdleCallback?.(h); }
    const h = window.setTimeout(load, 2500);
    return () => window.clearTimeout(h);
  }, [hasMedia]);
  const [dragging, setDragging] = useState(false);
  const [tlOver, setTlOver] = useState(false);
  // The dashed drop outline must never outlive a drag: the canvas handles the drop itself (and stops it), a drag can end elsewhere or be cancelled (I-06).
  useEffect(() => {
    const clear = () => setTlOver(false);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear, true);
    return () => { window.removeEventListener("dragend", clear); window.removeEventListener("drop", clear, true); };
  }, []);
  useEffect(() => {
    let depth = 0;
    const over = (e: DragEvent) => { if (dragHasFiles(e.dataTransfer)) e.preventDefault(); };
    const enter = (e: DragEvent) => { if (dragHasFiles(e.dataTransfer)) { depth++; setDragging(true); } };
    const leave = (e: DragEvent) => { if (dragHasFiles(e.dataTransfer) && --depth <= 0) { depth = 0; setDragging(false); } };
    const drop = (e: DragEvent) => {
      depth = 0;
      setDragging(false);
      if (!e.dataTransfer || !dragHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      void fromDataTransfer(e.dataTransfer).then(importFiles);
    };
    const paste = (e: ClipboardEvent) => {
      if (e.target instanceof Element && e.target.closest("input, textarea, [contenteditable]")) return;
      const files = fromFileList(e.clipboardData?.files);
      if (files.length > 0) { e.preventDefault(); void importFiles(files); }
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    window.addEventListener("paste", paste);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
      window.removeEventListener("paste", paste);
    };
  }, [importFiles]);
  // Desktop app: files dropped from the OS arrive as paths (never copies); the window shows the same drop hint as in the browser.
  const desktopApi = engine.status === "ready" ? engine.engine.desktop : undefined;
  useEffect(() => {
    if (!desktopApi) return;
    let off: (() => void) | undefined;
    let alive = true;
    void desktopApi.onDrop((files) => void importFiles(fromFileList(files)), setDragging).then((un) => (alive ? (off = un) : un())).catch(() => undefined);
    return () => { alive = false; off?.(); };
  }, [desktopApi, importFiles]);
  const meta = useMemo(() => binMeta(project), [project]);
  const binProps: BinProps = {
    items: media.items,
    meta,
    onTags: (id, tags) => {
      const name = media.items.find((i) => i.id === id)?.name ?? "";
      void store.apply({ op: "set_media_tags", media: id, tags: [...tags] }, undefined, t("media.tags.undoLabel", { name }));
    },
    onImport: (s) => void importFiles(s),
    onAdd: (id) => void media.addToTimeline(id).then((ok) => ok && announce(t("media.added"))),
    onRemove: media.remove,
    onRelinkAll: () => void locate(),
    onRelink: (id) => void media.relink(id).then(async (ok) => {
      if (ok) return;
      const picked = await pickOne(); // no stored permission: choose the file again
      if (!picked || !(await media.relink(id, picked))) setToast(t("media.relinkFailed"));
    }),
  };
  const seq = sequenceView(project);

  // ---- project lifecycle (PM-01, PM-07): canvas, new, open, save ----
  // "Unsaved" = changed since this project was loaded, opened, created or saved to a file in this window (autosave keeps the working copy either way).
  const clean = useRef<string | null>(null);
  useEffect(() => { if (project && clean.current === null) clean.current = JSON.stringify(project); }, [project]);
  const dirty = () => { const p = store.getState().project; return !!p && JSON.stringify(p) !== clean.current; };
  const markClean = () => { const p = store.getState().project; clean.current = p ? JSON.stringify(p) : null; };
  // A failure stays on screen until it is dismissed (a toast that leaves in 4 s is gone before the person has read why); successes keep the short toast.
  const [failure, setFailure] = useState<string | null>(null);
  const fail = (key: string, e: unknown) => setFailure(t(key, { why: e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e) }));
  /** Swap the open project for `bytes` (a `.overcut` file): the autosaving session when there is one, else the bare engine. */
  const replaceWith = async (bytes: Uint8Array, before?: SnapshotKind): Promise<Project> => {
    let next: Project;
    // The project that is about to go is kept as a version first (PM-06); a snapshot that cannot be written must not block the user.
    if (before && persistence.session) { const s = persistence.session; await s.exportBytes().then((b) => s.snapshots.add(before, "", b)).catch(() => undefined); }
    if (persistence.session) next = await persistence.session.replaceProject(bytes);
    else {
      const opened = await core!.openProject(bytes);
      if (opened.readOnly) throw new Error(t("project.open.newer"));
      await core!.editing.open(opened.project);
      next = opened.project;
    }
    await store.reload();
    store.setPlayhead(0);
    markClean();
    return next;
  };
  const confirmThen = (what: "new" | "open", name: string, run: () => Promise<void>) => {
    if (!dirty()) return void run();
    setDialog({ title: t(`project.${what}.title`), body: t(confirmBodyKey(what, !!persistence.session), { name }), confirm: t(`project.${what}.confirm`), danger: what === "new", run });
  };
  const onNew = () => {
    if (!core) return;
    confirmThen("new", "", async () => {
      try {
        await replaceWith(await core.saveProject(newProject(t("app.untitled"))), "before-new");
        setName(null);
        setOfflineHidden(false);
        announce(t("project.new.done"));
        setToast(t("project.new.done"));
      } catch (e) { fail("project.open.failed", e); }
    });
  };
  /** Open a project file's bytes (from the picker, "Open with" or a launch): a changed project asks first. */
  const openFromFile = async (file: { name: string; bytes: Uint8Array }) => {
    if (!core) return;
    try {
      let opened;
      try { opened = await core.openProject(file.bytes); } catch (e) { return fail("project.open.failed", e); }
      if (opened.readOnly) return setToast(t("project.open.newer"));
      const label = nameOfFile(file.name) || opened.project.name;
      confirmThen("open", label, async () => {
        try {
          await replaceWith(file.bytes, "before-open");
          setName(label);
          setOfflineHidden(false);
          announce(t("project.open.done", { name: label }));
          setToast(t("project.open.done", { name: label }));
        } catch (e) { fail("project.open.failed", e); }
      });
    } catch (e) { fail("project.open.failed", e); }
  };
  const onOpen = async () => {
    if (!core) return;
    try {
      const file = await pickProjectFile();
      if (file) await openFromFile(file);
    } catch (e) { fail("project.open.failed", e); }
  };
  // "Open with", the share sheet and desktop launch files (PM-02): same doors as the picker.
  useIncoming({
    ready: !!core && !!persistence.session,
    desktop: desktopApi,
    onMedia: (sources) => void importFiles(sources),
    onProject: (s) => void s.file.arrayBuffer().then((b) => openFromFile({ name: s.file.name, bytes: new Uint8Array(b) })).catch((e) => fail("project.open.failed", e)),
  });
  const onSave = async () => {
    if (!core || !project) return;
    try {
      const bytes = persistence.session ? await persistence.session.exportBytes() : await core.saveProject(project);
      const saved = await saveProjectBytes(bytes, projectFileName(name ?? project.name));
      if (!saved) return;
      markClean();
      announce(t("project.save.done", { name: saved }));
      setToast(t("project.save.done", { name: saved }));
    } catch (e) { fail("project.save.failed", e); }
  };
  // ---- the projects list (PM-06, docs/features/projects.md) ----
  const refreshList = async () => { const l = await (await getRegistry()).list(); setList(l); return l; };
  const openEntry = (e: { id: string; name: string }) => {
    setName(e.name || null);
    clean.current = null;
    setOfflineHidden(false);
    setOpenId(e.id);
    setLastId(e.id);
    void getRegistry().then((r) => r.setCurrent(e.id)).catch(() => undefined);
  };
  // First screen: the list when there are several projects, the only project when there is one, a new project when there are none.
  useEffect(() => {
    if (!core) return;
    let alive = true;
    void (async () => {
      try {
        const data = await loadProjects(core);
        const items = await (await getRegistry()).list();
        if (!alive) return;
        setLastId(data.current);
        const live = items.filter((i) => !isArchived(i)); // archived projects are tucked away: they do not count as "the only project"
        const screen = startScreen(live.length, items.length - live.length);
        if (screen === "home") setList(items);
        else if (screen === "editor") { setList(items); openEntry(live.find((i) => i.id === data.current) ?? live[0]!); }
        else if (screen === "new") {
          const e = await createProject(core, "");
          if (alive) { setList([e]); openEntry(e); }
        }
      } catch {
        // The list is unavailable (blocked storage): carry on with the one project every install has, as before the list existed. Saving says what is wrong.
        if (alive) openEntry({ id: LEGACY_PROJECT_ID, name: "" });
      }
    })();
    return () => { alive = false; };
  }, [core]);
  // Last-edited time and canvas facts of the open project: written to the list shortly after edits stop (and when leaving), never on just opening it.
  const touchBase = useRef<Project | null>(null);
  const pendingTouch = useRef<{ id: string; project: Project } | null>(null);
  const touchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastPoster = useRef(0);
  /**
   * Writes the row's facts (and, at most every few seconds, a small poster of the frame at the playhead). `leaving` = the project is about to be
   * closed (the preview is still there for this one call): the poster is also taken when the row has none yet. The pagehide path never waits
   * for a poster. A poster that cannot be had (no frame, black frame, timeout) leaves the old one in place.
   */
  const flushTouch = async (mode: "idle" | "leaving" | "hide" = "idle"): Promise<void> => {
    const leaving = mode === "leaving";
    clearTimeout(touchTimer.current);
    const p = pendingTouch.current;
    pendingTouch.current = null;
    const id = p?.id ?? openId;
    const live = p?.project ?? store.getState().project;
    if (!id || !live) return;
    const needsPoster = leaving && !list?.find((x) => x.id === id)?.poster && (summarize(live).clips ?? 0) > 0;
    if (!p && !needsPoster) return;
    const poster = mode !== "hide" && (leaving || Date.now() - lastPoster.current > 4000) ? await capturePoster() : null;
    if (poster) lastPoster.current = Date.now();
    await getRegistry().then((r) => r.update(id, { ...(p ? { modified: Date.now(), ...summarize(live), ...summarizeExtra(live) } : {}), ...(poster ? { poster } : {}) })).catch(() => undefined);
  };
  useEffect(() => {
    if (!project || !openId) { touchBase.current = null; return; }
    if (touchBase.current === null) { touchBase.current = project; return; }
    if (touchBase.current === project) return;
    pendingTouch.current = { id: openId, project };
    clearTimeout(touchTimer.current);
    touchTimer.current = setTimeout(() => void flushTouch(), 1500);
  }, [project, openId]);
  useEffect(() => { const f = () => void flushTouch("hide"); addEventListener("pagehide", f); return () => removeEventListener("pagehide", f); }, []);
  const goHome = async () => {
    await flushTouch("leaving");
    try { await refreshList(); } catch (e) { return fail("projects.failed", e); }
    setToast(null); // a message about the editor ("Nothing to split here") must not follow the user to the projects list
    setOpenId(null);
  };
  const homeTask = async (run: () => Promise<void>) => {
    setHomeBusy(true);
    try { await run(); } catch (e) { fail("projects.failed", e); } finally { setHomeBusy(false); }
  };
  const homeNew = () => void homeTask(async () => { const e = await createProject(core!, ""); await refreshList(); openEntry(e); announce(t("project.new.done")); });
  const homeOpenFile = () => void homeTask(async () => {
    const file = await pickProjectFile();
    if (!file) return;
    let opened;
    try { opened = await core!.openProject(file.bytes); } catch (e) { return fail("project.open.failed", e); }
    if (opened.readOnly) return setToast(t("project.open.newer"));
    let label = nameOfFile(file.name) || opened.project.name;
    const taken = new Set((await (await getRegistry()).list()).map((x) => x.name));
    for (let n = 2, base = label; taken.has(label); n++) label = `${base} (${n})`; // a clashing name becomes "Name (2)"
    const e = await createProject(core!, label, file.bytes);
    await refreshList();
    openEntry(e);
    announce(t("project.open.done", { name: label }));
  });
  const homeRename = (e: ProjectEntry, next: string) => void homeTask(async () => { await (await getRegistry()).update(e.id, { name: next }); await refreshList(); });
  const homeDuplicate = (e: ProjectEntry) => void homeTask(async () => {
    const copy = await duplicateProject(core!, e, t("app.untitled"));
    await refreshList();
    announce(t("projects.duplicated", { name: copy.name }));
    setToast(t("projects.duplicated", { name: copy.name }));
  });
  const homeArchive = (e: ProjectEntry, archived: boolean) => void homeTask(async () => { await setArchived(e, archived); await refreshList(); });
  const homeExport = (e: ProjectEntry) => void homeTask(async () => {
    const file = await saveProjectBytes(await projectBytes(core!, e), projectFileName(e.name || t("app.untitled")));
    if (file) { announce(t("projects.exported", { file })); setToast(t("projects.exported", { file })); }
  });
  const homeDelete = (e: ProjectEntry) => void homeTask(async () => {
    await deleteProject(e);
    if (lastId === e.id) setLastId(null);
    await refreshList();
    announce(t("projects.deleted", { name: e.name || t("app.untitled") }));
    setToast(t("projects.deleted", { name: e.name || t("app.untitled") }));
  });
  const showHome = openId === null && list !== null;

  const restoreVersion = async (id: string, label: string) => {
    const session = persistence.session;
    if (!session) return;
    const bytes = await session.snapshots.read(id);
    if (!bytes) throw new Error(t("versions.restoreFailed", { why: label }));
    try {
      await replaceWith(bytes, "before-restore");
      announce(t("versions.restored", { name: label }));
      setToast(t("versions.restored", { name: label }));
    } catch (e) { fail("versions.restoreFailed", e); }
  };
  useAutoSnapshots(persistence.session);
  const applyCanvas = (ops: Op[]) => {
    setDialog(null);
    void store.apply(ops, undefined, t("canvas.undoLabel")).then((out) => out?.changed && announce(t("canvas.changed", { summary: (() => { const v = sequenceView(store.getState().project); return canvasSummary(v.size, v.rate); })() })));
  };
  const offline = media.items.filter((i) => i.status === "offline" && !i.uri?.startsWith("fixture:")).length; // a file that is not on this device ("fixture:" is the built-in sample, not a file)
  const locate = async () => {
    const total = offline;
    try {
      const done = await media.relinkMany(await pickMany());
      setToast(t("project.located", { done, total }));
    } catch (e) { fail("project.open.failed", e); }
  };
  const pick = (id: string) => {
    const opening = id !== tool || !sheet;
    setSheet(id === tool ? !sheet : true);
    setTool(id);
    if (opening) setDetent(id === "edit" ? "peek" : "half"); // Edit starts small so the picture and the timeline stay in view
  };
  const closeSheet = useCallback(() => setSheet(false), []);
  // WCAG 2.4.11 Focus Not Obscured: on a phone the open tool sheet is drawn over the timeline. When keyboard focus moves from the sheet to a control it
  // would cover, the sheet steps aside (closes) instead of leaving focus on something nobody can see.
  useEffect(() => {
    if (roomy || !sheet) return;
    const onFocus = (e: FocusEvent) => {
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (!el || el.closest(".library")) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const over = document.elementFromPoint(Math.min(Math.max(r.x + r.width / 2, 0), innerWidth - 1), Math.min(Math.max(r.y + r.height / 2, 0), innerHeight - 1));
      if (over?.closest(".library")) setSheet(false);
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, [roomy, sheet]);
  // Focus goes back to the tool button that opened the sheet (a closed sheet is display:none: its focused element would otherwise drop focus to the page).
  const sheetOpener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (roomy) return;
    const here = document.activeElement as HTMLElement | null;
    if (sheet) { if (!sheetOpener.current && here && here !== document.body && !here.closest(".library")) sheetOpener.current = here; return; }
    const back = sheetOpener.current;
    sheetOpener.current = null;
    if (back?.isConnected && (!here || here === document.body || here.closest(".library"))) back.focus({ preventScroll: true });
  }, [sheet, roomy]);
  useBackClose(!roomy && sheet, closeSheet); // phone: Back / swipe-back closes the sheet before it leaves the editor
  useKeyboardInset(true); // the sheet and the dialogs ride above the on-screen keyboard (--kb)
  const activeId = wide && tool === "edit" ? "media" : tool;
  const active = TOOLS.find((x) => x.id === activeId && shown(x)) ?? TOOLS[0]!;
  const activeLabel = t(`tool.${active.id}.label`);
  const rail = TOOLS.filter((x) => shown(x) && !(wide && x.id === "edit"));
  /** Tablet and up dock the tool panel open, so a rail with a single tool (Media, in M1) switches nothing: it is left out and its column goes to the panels. */
  const railHidden = roomy && rail.length === 1;
  const themeName = t(`theme.${themePref}`);
  const engineText = engine.status === "loading" ? t("engine.starting")
    : engine.status === "ready" ? t("engine.ready", { name: engine.info.name, version: engine.info.version, backend: engine.backend })
    : t("engine.failed", { message: engine.message });
  // The menu says plain "Ready"; the engine's name, version and backend are on the About OverCut page.
  // "Saved on this device" follows autosave (persistence.status); it does not claim a save before the project is open.
  const saveState = persistence.status === "error" ? "error" : !persistence.ready ? "opening" : persistence.status;
  const engineMenuText = engine.status === "ready" ? t("engine.menu.ready") : engineText;

  return (
    <div className={showHome ? "editor home-mode" : "editor"} ref={editorRef} data-profile={profile} data-testid="editor">
      {showHome ? <Home entries={list} current={lastId} busy={homeBusy} onOpen={(e) => openEntry(e)} onNew={homeNew} onOpenFile={homeOpenFile} onRename={homeRename} onDuplicate={homeDuplicate} onArchive={homeArchive} onExport={homeExport} onDelete={homeDelete} /> : <>
      <header className="topbar">
        <div className="brand"><span className="logo" aria-hidden="true"><Icon name="split" size={16} /></span><strong>{t("app.name")}</strong>
        </div>
        <input className="project-name" value={name ?? t("app.untitled")} maxLength={60} readOnly={openId === null} onChange={(e) => setName(e.target.value)} onBlur={() => { const n = name?.trim() || null; setName(n); if (openId) void getRegistry().then((r) => r.update(openId, { name: n ?? "" })).catch(() => undefined); }} aria-label={t("project.name")} spellCheck={false} />
        <div className="top-actions">
          {engine.status === "error"
            ? <span className="chip" data-testid="engine" data-state="error">
                <span className="dot" aria-hidden="true" />
                <span className="chip-text"><span role="alert" data-testid="engine-error">{t("engine.failed", { message: engine.message })}</span></span>
              </span>
            // Developer detail ("Engine overcut v0.1.0 (wasm)") is not for the top bar: it lives in the app menu and on the Diagnostics page. This hidden probe is what tests wait on.
            : <span hidden data-testid="engine" data-state={engine.status} data-backend={engine.status === "ready" ? engine.backend : undefined} />}
          <span className="chip save-state" role="status" data-testid="save-state" data-state={saveState}>
            <span className="dot" aria-hidden="true" />
            <span className="chip-text">{t(`save.state.${saveState}`)}</span>
          </span>
          <button className="icon-btn palette-btn" aria-label={t("palette.open")} title={`${t("palette.open")} (${paletteKey()})`} data-testid="palette-open" onClick={() => setPalette(true)}><Icon name="search" size={20} /></button>
          <ExportControl engine={core} fileOf={media.fileOf} />
          {!compact && <ThemeMenu pref={themePref} onPick={pickTheme} />}
          <AppMenu compact={compact} save={{ state: saveState, text: t(`save.state.${saveState}`) }} project={{ onProjects: () => void goHome(), onNew, onOpen: () => void onOpen(), onSave: () => void onSave(), onPrivacy: () => setDialog("privacy"), onVersions: () => setDialog("versions"), onShortcuts: () => setDialog("shortcuts"), onPalette: () => setPalette(true) }} theme={{ name: themeName, pref: themePref, onPick: pickTheme }} status={<><span className="dot" aria-hidden="true" data-state={engine.status} /><span>{engineMenuText}</span></>} />
        </div>
      </header>

      <main className="workspace" ref={workspaceRef} data-inspector={wide && DETAILS_READY} data-rail={railHidden ? "none" : undefined} data-lib={roomy && libCollapsed ? "collapsed" : undefined} data-insp={inspCollapsed ? "collapsed" : undefined}>
        {!railHidden && <nav className="tools" aria-label={t("tools.nav")}>
          {rail.map((x) => (
            <button key={x.id} className="tool" aria-pressed={activeId === x.id && (roomy || sheet)} onClick={() => pick(x.id)}>
              <Icon name={x.icon} size={24} />
              <span>{t(`tool.${x.id}.label`)}</span>
            </button>
          ))}
        </nav>}

        {!roomy && sheet && active.id !== "edit" && <div className="sheet-scrim" data-testid="sheet-scrim" aria-hidden="true" onClick={closeSheet} />}
        <section className="library" data-open={sheet} data-detent={!roomy && sheet ? detent : undefined} data-collapsed={roomy && libCollapsed ? "true" : undefined} aria-label={activeLabel} data-testid="panel-tool">
          {!roomy && sheet && <SheetHandle detent={detent} onDetent={setDetent} onClose={closeSheet} />}
          <button className="sheet-close icon-btn" aria-label={t("panel.close")} onClick={() => setSheet(false)}><Icon name="close" size={18} /></button>
          {roomy && libCollapsed && <button className="icon-btn panel-expand" aria-label={t("panel.expand", { panel: activeLabel })} title={t("panel.expand", { panel: activeLabel })} onClick={() => setLibCollapsed(false)} data-testid="panel-expand"><Icon name="chevronRight" size={18} /></button>}
          {!roomy && sheet && active.id === "edit" && detent === "peek" && <MiniTransport playing={playing} />}
          {active.id === "edit" ? <Details /> : <Library tool={active} bin={binProps} onCollapse={() => setLibCollapsed(true)} />}
        </section>

        {openId !== null ? <PreviewPanel handlesOn={roomy || (sheet && active.id === "edit")} engine={core} fileOf={media.fileOf} readyIds={media.readyIds} hasMedia={media.items.length > 0} onImport={binProps.onImport} playing={playing} onCanvas={() => setDialog("canvas")} onPlaying={setPlaying} pictureOf={(id) => { const m = media.items.find((x) => x.id === id); return m?.width && m?.height ? { width: m.width, height: m.height } : undefined; }} /> : <section className="stage" aria-label={t("preview.label")} data-testid="panel-preview"><div className="stage-view"><div className="canvas" style={{ aspectRatio: "1.78" }} /></div><div className="player-bar" /></section>}

        {wide && DETAILS_READY && (
          <section className="inspector" data-collapsed={inspCollapsed ? "true" : undefined} aria-label={t("details.title")} data-testid="panel-inspector">
            {inspCollapsed && <button className="icon-btn panel-expand" aria-label={t("panel.expand", { panel: t("details.title") })} title={t("panel.expand", { panel: t("details.title") })} onClick={() => setInspCollapsed(false)} data-testid="panel-expand"><Icon name="chevronLeft" size={18} /></button>}
            <Details onCollapse={() => setInspCollapsed(true)} />
          </section>
        )}
        {roomy && <Splitter workspace={workspaceRef} />}

        <div className="tl-drop" data-over={tlOver} onDropCapture={() => setTlOver(false)} onDragOver={(e) => { if (e.dataTransfer.types.includes(BIN_DRAG_TYPE)) { e.preventDefault(); setTlOver(true); } }} onDragLeave={() => setTlOver(false)} onDrop={(e) => {
          const id = e.dataTransfer.getData(BIN_DRAG_TYPE);
          setTlOver(false);
          if (!id) return;
          e.preventDefault();
          void media.addToTimeline(id, Math.round((store.getState().playhead * TICKS * seq.rate.den) / seq.rate.num)).then((ok) => ok && announce(t("media.added")));
        }}>
          <Timeline playing={playing} fps={seq.rate.num / seq.rate.den} endFrame={seq.endFrame} onNotice={soon} onAddMedia={addMediaAt} engine={core} fileOf={media.fileOf} readyIds={media.readyIds} onDropMedia={(id, tick, track) => void media.addToTimeline(id, tick, track).then((ok) => ok && announce(t("media.added")))} />
        </div>
      </main>

      <PersistenceNotes state={persistence} extra={(failure || (offline > 0 && !offlineHidden)) ? (<>
        {failure && (
          <div className="persist-note danger" role="alert" data-testid="failure-note">
            <span>{failure}</span>
            <button className="icon-btn" aria-label={t("persist.dismiss")} onClick={() => setFailure(null)}><Icon name="close" size={18} /></button>
          </div>
        )}
        {offline > 0 && !offlineHidden && (
        <div className="persist-note" role="status" data-testid="offline-note">
          <span>{t("project.offline", { count: offline })}</span>
          <button onClick={() => void locate()} data-testid="locate-files">{t("project.locate")}</button>
          <button className="icon-btn" aria-label={t("persist.dismiss")} onClick={() => setOfflineHidden(true)}><Icon name="close" size={18} /></button>
        </div>
      )}</>) : null} />
      {dialog === "versions" && persistence.session && <VersionsDialog session={persistence.session} onRestore={restoreVersion} onClose={() => setDialog(null)} />}
      {dialog === "privacy" && <PrivacyDialog onClose={() => setDialog(null)} />}
      {dialog === "canvas" && project?.sequences[0] && <CanvasDialog sequence={project.sequences[0]} hasPicture={hasPicture(project)} onApply={applyCanvas} onClose={() => setDialog(null)} />}
      {dialog === "shortcuts" && <Suspense fallback={null}><ShortcutsDialog onClose={() => setDialog(null)} /></Suspense>}
      {palette && <Palette onClose={() => setPalette(false)} />}
      {dialog && typeof dialog === "object" && <ConfirmDialog title={dialog.title} body={dialog.body} confirm={dialog.confirm} danger={dialog.danger} onClose={() => setDialog(null)} onConfirm={() => { const run = dialog.run; setDialog(null); void run(); }} />}
      {dragging && <div className="drop-overlay" aria-hidden="true" data-testid="drop-overlay"><Icon name="upload" size={40} /><strong>{t("media.dropNow")}</strong></div>}
      </>}
      {refusals.length > 0 && !roomy && (
        <div className="refusal-note" data-testid="refusal-note">
          <ul>{refusals.map((m) => <li key={m}>{m}</li>)}</ul>
          <button className="icon-btn" aria-label={t("media.refusalDismiss")} onClick={() => setRefusals([])}><Icon name="close" size={18} /></button>
        </div>
      )}
      <div className="toast" role="status">{toast}</div>
    </div>
  );
}
