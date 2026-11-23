import { createEngine, type Engine, type EngineBackend, type EngineInfo } from "@app/engine-client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { announce } from "./a11y/announcer";
import { useRovingTabindex } from "./a11y/roving";
import { useI18n } from "./i18n";
import { Icon, type IconName } from "./icons";
import { PersistenceNotes, usePersistence } from "./persistence";
import { PreviewPanel, sequenceView } from "./PreviewPanel";
import { ProjectStore, ProjectStoreProvider, useProjectStore } from "./store/projectStore";
import { Timeline } from "./Timeline";
import { applyTheme, loadPref, nextPref, savePref, watchSystem, type ThemePref } from "./theme/theme";
import { ExportControl } from "./export/ExportDialog";
import { MediaBin } from "./media/MediaBin";
import { TICKS, clipCount } from "./media/plan";
import { BIN_DRAG_TYPE, dragHasFiles, fromDataTransfer, fromFileList, pickOne, type Source } from "./media/sources";
import { useMediaBin, type BinItem } from "./media/useMediaBin";

type EngineState = { status: "loading" } | { status: "ready"; info: EngineInfo; backend: EngineBackend; engine: Engine } | { status: "error"; message: string };

type Tool = { id: string; icon: IconName; soon?: string };
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

const RATIOS = [
  { id: "16:9", value: 16 / 9 },
  { id: "9:16", value: 9 / 16 },
  { id: "1:1", value: 1 },
  { id: "4:5", value: 4 / 5 },
] as const;

function useMedia(query: string) {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return match;
}

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
        <EmptyState icon="edit" title={t("details.emptyTitle")} text={t("details.emptyText")} />
      </div>
    </>
  );
}

/** The "..." menu: small, out of the way. Holds About / Diagnostics, and on small phones (`compact`) the theme toggle and engine status that
 *  no longer fit the top bar next to the project name and Export. */
function AppMenu({ compact, theme, status }: { compact: boolean; theme: { name: string; cycle: () => void }; status: ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button className="icon-btn" aria-label={t("menu.open")} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((o) => !o)}><Icon name="more" size={20} /></button>
      {open && (
        <div className="menu-pop" role="menu">
          {compact && (
            <>
              <button className="menu-row" role="menuitem" onClick={theme.cycle} data-testid="theme-toggle"><Icon name="theme" size={20} /><span>{t("theme.change", { theme: theme.name })}</span></button>
              <div className="menu-row menu-status" role="presentation">{status}</div>
            </>
          )}
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
  const persistence = usePersistence(core);
  const [tool, setTool] = useState("media");
  const [sheet, setSheet] = useState(false); // phone only: tool panel open above the bottom bar
  const [name, setName] = useState<string | null>(null); // null = the localized default name
  const [ratio, setRatio] = useState<(typeof RATIOS)[number]["id"]>("16:9");
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(40);
  const [toast, setToast] = useState<string | null>(null);
  const cycleTheme = () => {
    const next = nextPref(themePref);
    savePref(next);
    setThemePref(next);
    const theme = applyTheme(next);
    announce(t("theme.changed", { theme: t(`theme.${next === "system" ? "system" : theme}`) }));
  };
  useEffect(() => watchSystem(() => loadPref(), () => undefined), []);
  const wide = useMedia("(min-width: 1100px)");
  const compact = useMedia("(max-width: 479px)"); // small phone: theme toggle and engine status live in the "..." menu
  const roomy = useMedia("(min-width: 720px)"); // tablet and up: the tool panel is always open

  useEffect(() => {
    let alive = true;
    createEngine()
      .then(async (e) => ({ info: await e.info(), backend: e.backend, engine: e }))
      .then(({ engine: e, ...r }) => alive && (setEngine({ status: "ready", engine: e, ...r }), setCore(e)))
      .catch((e: unknown) => alive && setEngine({ status: "error", message: e instanceof Error ? e.message : String(e) }));
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
  useEffect(() => { void store.attach(editing, { canUndo: persistence.epoch === 0 && replayed.current > 0 }); }, [store, editing, persistence.epoch]); // epoch: undo recovery replaced the project
  const project = useProjectStore((s) => s.project);

  // ---- media import (M1-032) ----
  const media = useMediaBin(core, editing, !!persistence.session, t("app.untitled"), {
    notMedia: (n) => t("media.err.notMedia", { name: n }),
    unsupported: (n, ext, detail) => t("media.err.unsupported", { name: n, ext: ext || "?", detail }),
    failed: (n) => t("media.err.failed", { name: n }),
    imported: (count) => t("media.imported", { count }),
    announce,
  });
  const importFiles = media.importSources;
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
  const binProps: BinProps = {
    items: media.items,
    onImport: (s) => void importFiles(s),
    onAdd: (id) => void media.addToTimeline(id).then((ok) => ok && announce(t("media.added"))),
    onRemove: media.remove,
    onRelink: (id) => void media.relink(id).then(async (ok) => {
      if (ok) return;
      const picked = await pickOne(); // no stored permission: choose the file again
      if (!picked || !(await media.relink(id, picked))) setToast(t("media.relinkFailed"));
    }),
  };
  const seq = sequenceView(project);
  const hasClips = project ? clipCount(project) > 0 : false;
  // The first picture sets the sequence size: show it in the preview shape closest to it.
  const res = project?.sequences[0]?.resolution;
  useEffect(() => {
    if (!res || !hasClips) return;
    const a = res.width / res.height;
    setRatio(RATIOS.reduce((best, r) => (Math.abs(Math.log(r.value / a)) < Math.abs(Math.log(best.value / a)) ? r : best)).id);
  }, [res?.width, res?.height, hasClips]);
  const pick = (id: string) => { setSheet(id === tool ? !sheet : true); setTool(id); };
  const activeId = wide && tool === "edit" ? "media" : tool;
  const active = TOOLS.find((x) => x.id === activeId) ?? TOOLS[0]!;
  const activeLabel = t(`tool.${active.id}.label`);
  const rail = wide ? TOOLS.filter((x) => x.id !== "edit") : TOOLS;
  const themeName = t(`theme.${themePref}`);
  const engineText = engine.status === "loading" ? t("engine.starting")
    : engine.status === "ready" ? t("engine.ready", { name: engine.info.name, version: engine.info.version, backend: engine.backend })
    : t("engine.failed", { message: engine.message });

  return (
    <div className="editor">
      <header className="topbar">
        <div className="brand"><span className="logo" aria-hidden="true"><Icon name="split" size={16} /></span><strong>{t("app.name")}</strong>
          {!compact && <button className="icon-btn" aria-label={t("theme.change", { theme: themeName })} title={themeName} onClick={cycleTheme} data-testid="theme-toggle"><Icon name="theme" size={20} /></button>}
        </div>
        <input className="project-name" value={name ?? t("app.untitled")} maxLength={60} onChange={(e) => setName(e.target.value)} onBlur={() => setName((n) => n?.trim() || null)} aria-label={t("project.name")} spellCheck={false} />
        <div className="top-actions">
          <span className="chip" data-testid="engine" data-state={engine.status} aria-live="polite">
            <span className="dot" aria-hidden="true" />
            <span className="chip-text">
              {engine.status === "loading" && t("engine.starting")}
              {engine.status === "ready" && t("engine.ready", { name: engine.info.name, version: engine.info.version, backend: engine.backend })}
              {engine.status === "error" && <span role="alert" data-testid="engine-error">{t("engine.failed", { message: engine.message })}</span>}
            </span>
          </span>
          <ExportControl engine={core} fileOf={media.fileOf} />
          <AppMenu compact={compact} theme={{ name: themeName, cycle: cycleTheme }} status={<><span className="dot" aria-hidden="true" data-state={engine.status} /><span>{engineText}</span></>} />
        </div>
      </header>

      <main className="workspace">
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

        <PreviewPanel engine={core} fileOf={media.fileOf} readyIds={media.readyIds} onImport={binProps.onImport} playing={playing} ratios={RATIOS} ratio={ratio} onRatio={(id) => setRatio(id as typeof ratio)} onPlaying={setPlaying} />

        {wide && <section className="inspector" aria-label={t("details.title")} data-testid="panel-inspector"><Details /></section>}

        <div className="tl-drop" data-over={tlOver} onDragOver={(e) => { if (e.dataTransfer.types.includes(BIN_DRAG_TYPE)) { e.preventDefault(); setTlOver(true); } }} onDragLeave={() => setTlOver(false)} onDrop={(e) => {
          const id = e.dataTransfer.getData(BIN_DRAG_TYPE);
          setTlOver(false);
          if (!id) return;
          e.preventDefault();
          void media.addToTimeline(id, Math.round((store.getState().playhead * TICKS * seq.rate.den) / seq.rate.num)).then((ok) => ok && announce(t("media.added")));
        }}>
          <Timeline playing={playing} zoom={zoom} fps={seq.rate.num / seq.rate.den} endFrame={seq.endFrame} onZoom={setZoom} onNotice={soon} engine={core} fileOf={media.fileOf} readyIds={media.readyIds} />
        </div>
      </main>

      <PersistenceNotes state={persistence} />
      {dragging && <div className="drop-overlay" aria-hidden="true" data-testid="drop-overlay"><Icon name="upload" size={40} /><strong>{t("media.dropNow")}</strong></div>}
      <div className="toast" role="status">{toast}</div>
    </div>
  );
}
