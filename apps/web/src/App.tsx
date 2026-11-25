import { LEGACY_PROJECT_ID, createEngine, newProject, summarize, type ProjectEntry, type SnapshotKind, type Engine, type EngineBackend, type EngineInfo, type Op, type Project } from "@app/engine-client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { announce } from "./a11y/announcer";
import { useRovingTabindex } from "./a11y/roving";
import { reportAppInfo } from "./errorScreen/crash";
import { reportFatal } from "./errorScreen/ErrorScreen";
import { useI18n } from "./i18n";
import { useIncoming } from "./incoming";
import { Icon, type IconName } from "./icons";
import { PersistenceNotes, usePersistence } from "./persistence";
import { Home } from "./Home";
import { createProject, deleteProject, duplicateProject, getRegistry, loadProjects, projectBytes, setArchived } from "./projects";
import { isArchived, startScreen } from "./projectsView";
import { CanvasDialog, ConfirmDialog, PrivacyDialog } from "./ProjectDialogs";
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
import { ShortcutsDialog } from "./commands/ShortcutsDialog";
import { Palette } from "./commands/Palette";
import { PALETTE_EVENT } from "./commands/palette";
import { currentKeymap } from "./commands/keymap";
import { chordLabel } from "./commands/registry";
/** The palette's first key as the user sees it (Ctrl+K, or whatever it was remapped to). */
const paletteKey = (): string => chordLabel(currentKeymap().get("app.palette")?.[0] ?? "Mod+K");
import { VersionsDialog, useAutoSnapshots } from "./Versions";
import { binMeta, type BinMeta } from "./media/binView";
import { MediaBin } from "./media/MediaBin";
import { TICKS } from "./media/plan";
import { BIN_DRAG_TYPE, dragHasFiles, fromDataTransfer, fromFileList, getDesktop, pickMany, pickOne, setDesktop, setNativeMedia, type Source } from "./media/sources";
import { useShellProfile } from "./layout/useShellProfile";
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

function Library({ tool, bin }: { tool: Tool; bin: BinProps }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const label = t(`tool.${tool.id}.label`);
  const search = t("panel.search", { tool: label.toLowerCase() });
  return (
    <>
      <header className="panel-head">
        <h2>{label}</h2>
        {tool.soon && <span className="pill">{t("panel.coming", { milestone: tool.soon })}</span>}
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

const DETAIL_TABS = ["video", "audio", "speed", "animation", "adjust"] as const;
function Details() {
  const { t, dir } = useI18n();
  const [tab, setTab] = useState<(typeof DETAIL_TABS)[number]>("video");
  const roving = useRovingTabindex(DETAIL_TABS.length, { rtl: dir === "rtl", onMove: (i) => setTab(DETAIL_TABS[i]!) });
  return (
    <>
      <header className="panel-head"><h2>{t("details.title")}</h2></header>
      <div className="segmented" role="tablist" aria-label={t("details.tabs")}>
        {DETAIL_TABS.map((id, i) => (
          <button key={id} role="tab" aria-selected={tab === id} {...roving.itemProps(i)} onClick={() => setTab(id)}>{t(`details.tab.${id}`)}</button>
        ))}
      </div>
      <div className="panel-body">
        {tab === "video" ? <Inspector /> : tab === "speed" ? <SpeedSection /> : <EmptyState icon="edit" title={t("details.emptyTitle")} text={t("details.emptyText")} />}
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
      <button ref={trigger} className="icon-btn" aria-label={t("menu.open")} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((o) => !o)}><Icon name="more" size={20} /></button>
      {open && (
        <div className="menu-pop" role="menu">
          {compact && (
            <>
              {/* Small phones: the theme choices are listed here (F3), not cycled. */}
              {THEME_PREFS.map((p) => (
                <button key={p} className="menu-row" role="menuitemradio" aria-checked={p === theme.pref} data-testid={`theme-${p}`} onClick={() => theme.onPick(p)}><span className="menu-check" aria-hidden="true">{p === theme.pref ? "✓" : ""}</span><span>{t(`theme.${p}`)}</span></button>
              ))}
              <div className="menu-row menu-status" role="presentation">{status}</div>
              {/* On small phones the top-bar save chip is screen-reader only, so the plain save state is shown here as well. */}
              <div className="menu-row menu-status save-row" role="presentation" data-testid="save-state-menu" data-state={save.state}><span className="dot" aria-hidden="true" data-state={save.state} /><span>{save.text}</span></div>
            </>
          )}
          <button className="menu-row" role="menuitem" data-testid="menu-palette" onClick={opening(project.onPalette)}><span>{t("palette.open")}</span><kbd className="menu-hint">{paletteKey()}</kbd></button>
          <div className="menu-group" role="presentation">{t("menu.group.project")}</div>
          <button className="menu-row" role="menuitem" data-testid="menu-projects" onClick={opening(project.onProjects)}>{t("menu.projects")}</button>
          <button className="menu-row" role="menuitem" data-testid="menu-new" onClick={opening(project.onNew)}>{t("menu.new")}</button>
          <button className="menu-row" role="menuitem" data-testid="menu-open" onClick={opening(project.onOpen)}>{t("menu.openProject")}</button>
          <button className="menu-row" role="menuitem" data-testid="menu-save" onClick={opening(project.onSave)}>{t("menu.saveProject")}</button>
          {getDesktop() && <button className="menu-row" role="menuitem" data-testid="menu-projects-folder" onClick={() => { setOpen(false); void chooseFolder(); }}>{t("menu.projectsFolder")}</button>}
          <button className="menu-row" role="menuitem" data-testid="menu-versions" onClick={opening(project.onVersions)}>{t("menu.versions")}</button>
          <div className="menu-group" role="presentation">{t("menu.group.view")}</div>
          <AccentPicker />
          <ScrubPrepItem />
          <div className="menu-group" role="presentation">{t("menu.group.help")}</div>
          <button className="menu-row" role="menuitem" data-testid="menu-shortcuts" onClick={opening(project.onShortcuts)}>{t("menu.shortcuts")}</button>
          <button className="menu-row" role="menuitem" data-testid="menu-privacy" onClick={opening(project.onPrivacy)}>{t("menu.privacy")}</button>
          <InstallItem desktopApp={!!getDesktop()} onDone={() => setOpen(false)} />
          <a role="menuitem" href="/diagnostics">{t("menu.diagnostics")}</a>
        </div>
      )}
    </div>
  );
}

/** The app owns one project store; every panel below reads it. */
export function App() {
  const [store] = useState(() => new ProjectStore());
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
  const [name, setName] = useState<string | null>(null); // null = the localized default name
  const [dialog, setDialog] = useState<null | "canvas" | "privacy" | "versions" | "shortcuts" | { title: string; body: string; confirm: string; run(): Promise<void> }>(null);
  const [locating, setLocating] = useState(false); // after opening a file: offer to reconnect media that is not on this device
  const [playing, setPlaying] = useState(false);
  const [palette, setPalette] = useState(false); // the command palette (Ctrl/Cmd+K, the top-bar button, the app menu)
  useEffect(() => { const open = () => setPalette(true); window.addEventListener(PALETTE_EVENT, open); return () => window.removeEventListener(PALETTE_EVENT, open); }, []);
  const [zoom, setZoom] = useState(40);
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
    createEngine()
      .then(async (e) => ({ info: await e.info(), backend: e.backend, engine: e }))
      .then(({ engine: e, ...r }) => alive && (reportAppInfo({ version: r.info.version, backend: r.backend }), setDesktop(e.desktop), setNativeMedia(e.desktop ? e.media : undefined), setEngine({ status: "ready", engine: e, ...r }), setCore(e)))
      .catch((e: unknown) => alive && (setEngine({ status: "error", message: e instanceof Error ? e.message : String(e) }), reportFatal("engine-start", e)));
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
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
  const [dragging, setDragging] = useState(false);
  const [tlOver, setTlOver] = useState(false);
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
  const fail = (key: string, e: unknown) => setToast(t(key, { why: e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e) }));
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
    setDialog({ title: t(`project.${what}.title`), body: t(`project.${what}.body`, { name }), confirm: t(`project.${what}.confirm`), run });
  };
  const onNew = () => {
    if (!core) return;
    confirmThen("new", "", async () => {
      try {
        await replaceWith(await core.saveProject(newProject(t("app.untitled"))), "before-new");
        setName(null);
        setLocating(false);
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
          setLocating(true);
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
  const openEntry = (e: { id: string; name: string }, fromFile = false) => {
    setName(e.name || null);
    clean.current = null;
    setLocating(fromFile);
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
  const flushTouch = (): Promise<void> => {
    clearTimeout(touchTimer.current);
    const p = pendingTouch.current;
    pendingTouch.current = null;
    return p ? getRegistry().then((r) => r.update(p.id, { modified: Date.now(), ...summarize(p.project) })).catch(() => undefined) : Promise.resolve();
  };
  useEffect(() => {
    if (!project || !openId) { touchBase.current = null; return; }
    if (touchBase.current === null) { touchBase.current = project; return; }
    if (touchBase.current === project) return;
    pendingTouch.current = { id: openId, project };
    clearTimeout(touchTimer.current);
    touchTimer.current = setTimeout(() => void flushTouch(), 1500);
  }, [project, openId]);
  useEffect(() => { const f = () => void flushTouch(); addEventListener("pagehide", f); return () => removeEventListener("pagehide", f); }, []);
  const goHome = async () => {
    await flushTouch();
    try { await refreshList(); } catch (e) { return fail("projects.failed", e); }
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
    const label = nameOfFile(file.name) || opened.project.name;
    const e = await createProject(core!, label, file.bytes);
    await refreshList();
    openEntry(e, true);
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
  const applyCanvas = (op: Op) => {
    setDialog(null);
    void store.apply(op, undefined, t("canvas.undoLabel")).then((out) => out?.changed && announce(t("canvas.changed", { summary: (() => { const v = sequenceView(store.getState().project); return canvasSummary(v.size, v.rate); })() })));
  };
  const offline = media.items.filter((i) => i.status === "offline").length;
  const locate = async () => {
    const total = offline;
    try {
      const done = await media.relinkMany(await pickMany());
      setToast(t("project.located", { done, total }));
    } catch (e) { fail("project.open.failed", e); }
  };
  const pick = (id: string) => { setSheet(id === tool ? !sheet : true); setTool(id); };
  const activeId = wide && tool === "edit" ? "media" : tool;
  const active = TOOLS.find((x) => x.id === activeId && shown(x)) ?? TOOLS[0]!;
  const activeLabel = t(`tool.${active.id}.label`);
  const rail = TOOLS.filter((x) => shown(x) && !(wide && x.id === "edit"));
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
          {!compact && <ThemeMenu pref={themePref} onPick={pickTheme} />}
        </div>
        <input className="project-name" value={name ?? t("app.untitled")} maxLength={60} onChange={(e) => setName(e.target.value)} onBlur={() => { const n = name?.trim() || null; setName(n); if (openId) void getRegistry().then((r) => r.update(openId, { name: n ?? "" })).catch(() => undefined); }} aria-label={t("project.name")} spellCheck={false} />
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
          <AppMenu compact={compact} save={{ state: saveState, text: t(`save.state.${saveState}`) }} project={{ onProjects: () => void goHome(), onNew, onOpen: () => void onOpen(), onSave: () => void onSave(), onPrivacy: () => setDialog("privacy"), onVersions: () => setDialog("versions"), onShortcuts: () => setDialog("shortcuts"), onPalette: () => setPalette(true) }} theme={{ name: themeName, pref: themePref, onPick: pickTheme }} status={<><span className="dot" aria-hidden="true" data-state={engine.status} /><span>{engineMenuText}</span></>} />
        </div>
      </header>

      <main className="workspace" data-inspector={wide && DETAILS_READY}>
        <nav className="tools" aria-label={t("tools.nav")}>
          {rail.map((x) => (
            <button key={x.id} className="tool" aria-pressed={activeId === x.id && (roomy || sheet)} onClick={() => pick(x.id)}>
              <Icon name={x.icon} size={24} />
              <span>{t(`tool.${x.id}.label`)}</span>
            </button>
          ))}
        </nav>

        <section className="library" data-open={sheet} aria-label={activeLabel} data-testid="panel-tool">
          <button className="sheet-close icon-btn" aria-label={t("panel.close")} onClick={() => setSheet(false)}><Icon name="close" size={18} /></button>
          {active.id === "edit" ? <Details /> : <Library tool={active} bin={binProps} />}
        </section>

        <PreviewPanel engine={core} fileOf={media.fileOf} readyIds={media.readyIds} hasMedia={media.items.length > 0} onImport={binProps.onImport} playing={playing} onCanvas={() => setDialog("canvas")} onPlaying={setPlaying} pictureOf={(id) => { const m = media.items.find((x) => x.id === id); return m?.width && m?.height ? { width: m.width, height: m.height } : undefined; }} />

        {wide && DETAILS_READY && <section className="inspector" aria-label={t("details.title")} data-testid="panel-inspector"><Details /></section>}

        <div className="tl-drop" data-over={tlOver} onDragOver={(e) => { if (e.dataTransfer.types.includes(BIN_DRAG_TYPE)) { e.preventDefault(); setTlOver(true); } }} onDragLeave={() => setTlOver(false)} onDrop={(e) => {
          const id = e.dataTransfer.getData(BIN_DRAG_TYPE);
          setTlOver(false);
          if (!id) return;
          e.preventDefault();
          void media.addToTimeline(id, Math.round((store.getState().playhead * TICKS * seq.rate.den) / seq.rate.num)).then((ok) => ok && announce(t("media.added")));
        }}>
          <Timeline playing={playing} zoom={zoom} fps={seq.rate.num / seq.rate.den} endFrame={seq.endFrame} onZoom={setZoom} onNotice={soon} engine={core} fileOf={media.fileOf} readyIds={media.readyIds} onDropMedia={(id, tick, track) => void media.addToTimeline(id, tick, track).then((ok) => ok && announce(t("media.added")))} />
        </div>
      </main>

      <PersistenceNotes state={persistence} extra={locating && offline > 0 ? (
        <div className="persist-note" role="status" data-testid="offline-note">
          <span>{t("project.offline", { count: offline })}</span>
          <button onClick={() => void locate()} data-testid="locate-files">{t("project.locate")}</button>
          <button className="icon-btn" aria-label={t("persist.dismiss")} onClick={() => setLocating(false)}>×</button>
        </div>
      ) : null} />
      {dialog === "versions" && persistence.session && <VersionsDialog session={persistence.session} onRestore={restoreVersion} onClose={() => setDialog(null)} />}
      {dialog === "privacy" && <PrivacyDialog onClose={() => setDialog(null)} />}
      {dialog === "canvas" && project?.sequences[0] && <CanvasDialog sequence={project.sequences[0]} hasPicture={hasPicture(project)} onApply={applyCanvas} onClose={() => setDialog(null)} />}
      {dialog === "shortcuts" && <ShortcutsDialog onClose={() => setDialog(null)} />}
      {palette && <Palette onClose={() => setPalette(false)} />}
      {dialog && typeof dialog === "object" && <ConfirmDialog title={dialog.title} body={dialog.body} confirm={dialog.confirm} onClose={() => setDialog(null)} onConfirm={() => { const run = dialog.run; setDialog(null); void run(); }} />}
      {dragging && <div className="drop-overlay" aria-hidden="true" data-testid="drop-overlay"><Icon name="upload" size={40} /><strong>{t("media.dropNow")}</strong></div>}
      </>}
      {refusals.length > 0 && !roomy && (
        <div className="refusal-note" data-testid="refusal-note">
          <ul>{refusals.map((m) => <li key={m}>{m}</li>)}</ul>
          <button className="icon-btn" aria-label={t("media.refusalDismiss")} onClick={() => setRefusals([])}>×</button>
        </div>
      )}
      <div className="toast" role="status">{toast}</div>
    </div>
  );
}
