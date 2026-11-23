import { createEngine, type Engine, type EngineBackend, type EngineInfo } from "@app/engine-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { announce } from "./a11y/announcer";
import { useRovingTabindex } from "./a11y/roving";
import { useI18n } from "./i18n";
import { Icon, type IconName } from "./icons";
import { PersistenceNotes, usePersistence } from "./persistence";
import { END_FRAME, Timeline } from "./Timeline";
import { applyTheme, loadPref, nextPref, savePref, watchSystem, type ThemePref } from "./theme/theme";
import { FPS, timecode } from "./timecode";
import { MediaBin } from "./media/MediaBin";
import { TICKS, clipCount } from "./media/plan";
import { BIN_DRAG_TYPE, dragHasFiles, fromDataTransfer, fromFileList, type Source } from "./media/sources";
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

export function App() {
  const { t } = useI18n();
  const [themePref, setThemePref] = useState<ThemePref>(loadPref);
  const [engine, setEngine] = useState<EngineState>({ status: "loading" });
  const [core, setCore] = useState<Engine | null>(null);
  const persistence = usePersistence(core);
  const [tool, setTool] = useState("media");
  const [sheet, setSheet] = useState(false); // phone only: tool panel open above the bottom bar
  const [name, setName] = useState<string | null>(null); // null = the localized default name
  const [ratio, setRatio] = useState<(typeof RATIOS)[number]["id"]>("16:9");
  const [frame, setFrame] = useState(0);
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
  const roomy = useMedia("(min-width: 720px)"); // tablet and up: the tool panel is always open
  const frameRef = useRef(0);
  frameRef.current = frame;

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

  // Transport: advance by whole frames from the real clock.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const tick = (now: number) => {
      acc += ((now - last) * FPS) / 1000;
      last = now;
      const whole = Math.floor(acc);
      if (whole > 0) {
        acc -= whole;
        const next = Math.min(END_FRAME, frameRef.current + whole);
        frameRef.current = next;
        setFrame(next);
        if (next >= END_FRAME) { setPlaying(false); return; }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const togglePlay = useCallback(() => {
    if (!playing && frameRef.current >= END_FRAME) { frameRef.current = 0; setFrame(0); }
    setPlaying((p) => !p);
  }, [playing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.code !== "Space" || e.repeat || t.closest("input, select, textarea, button, [role=slider]")) return;
      e.preventDefault();
      togglePlay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay]);

  const soon = useCallback((m: string) => setToast(m), []);

  // ---- media import (M1-032) ----
  const media = useMediaBin(engine.status === "ready" ? engine.engine : null, t("app.untitled"), {
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
    onRelink: (id) => void media.relink(id).then((ok) => { if (!ok) setToast(t("media.relinkFailed")); }),
  };
  const project = media.project;
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
  const ar = RATIOS.find((r) => r.id === ratio)!.value;
  const rail = wide ? TOOLS.filter((x) => x.id !== "edit") : TOOLS;
  const themeName = t(`theme.${themePref}`);

  return (
    <div className="editor">
      <header className="topbar">
        <div className="brand"><span className="logo" aria-hidden="true"><Icon name="split" size={16} /></span><strong>{t("app.name")}</strong>
          <button className="icon-btn" aria-label={t("theme.change", { theme: themeName })} title={themeName} onClick={cycleTheme} data-testid="theme-toggle"><Icon name="theme" size={20} /></button>
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
          <button className="primary" onClick={() => soon(t("export.soon"))}>
            <Icon name="export" size={18} /><span>{t("export.label")}</span>
          </button>
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

        <section className="stage" aria-label={t("preview.label")} data-testid="panel-preview">
          <div className="stage-view">
            <div className="canvas" style={{ ["--ar" as string]: ar, aspectRatio: String(ar) }}>
              <div className="canvas-hint"><Icon name="film" size={30} /><span>{t("preview.hint")}</span></div>
            </div>
          </div>
          <div className="player-bar">
            <div className="tc" aria-label={t("player.time")}><span>{timecode(frame)}</span><span className="tc-total"> / {timecode(END_FRAME)}</span></div>
            <div className="transport" role="toolbar" aria-label={t("player.toolbar")}>
              <button className="icon-btn" aria-label={t("player.start")} onClick={() => setFrame(0)}><Icon name="back" size={20} /></button>
              <button className="play" aria-label={playing ? t("player.pause") : t("player.play")} onClick={togglePlay}><Icon name={playing ? "pause" : "play"} size={22} /></button>
              <button className="icon-btn" aria-label={t("player.end")} onClick={() => setFrame(END_FRAME)}><Icon name="forward" size={20} /></button>
            </div>
            <label className="ratio">
              <span className="sr-only">{t("ratio.label")}</span>
              <select value={ratio} onChange={(e) => setRatio(e.target.value as typeof ratio)}>
                {RATIOS.map((r) => <option key={r.id} value={r.id}>{r.id === ratio ? r.id : t(`ratio.${r.id}`)}</option>)}
              </select>
            </label>
          </div>
        </section>

        {wide && <section className="inspector" aria-label={t("details.title")} data-testid="panel-inspector"><Details /></section>}

        <div className="tl-drop" data-over={tlOver} onDragOver={(e) => { if (e.dataTransfer.types.includes(BIN_DRAG_TYPE)) { e.preventDefault(); setTlOver(true); } }} onDragLeave={() => setTlOver(false)} onDrop={(e) => {
          const id = e.dataTransfer.getData(BIN_DRAG_TYPE);
          setTlOver(false);
          if (!id) return;
          e.preventDefault();
          void media.addToTimeline(id, Math.round((frame * TICKS) / FPS)).then((ok) => ok && announce(t("media.added")));
        }}>
          <Timeline frame={frame} playing={playing} zoom={zoom} onFrame={(f) => { setPlaying(false); setFrame(f); }} onZoom={setZoom} onSoon={soon} project={hasClips ? project ?? undefined : undefined} />
        </div>
      </main>

      <PersistenceNotes state={persistence} />
      {dragging && <div className="drop-overlay" aria-hidden="true" data-testid="drop-overlay"><Icon name="upload" size={40} /><strong>{t("media.dropNow")}</strong></div>}
      <div className="toast" role="status">{toast}</div>
    </div>
  );
}
