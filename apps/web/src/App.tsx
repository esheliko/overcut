import { createEngine, type Engine, type EngineBackend, type EngineInfo } from "@app/engine-client";
import { useCallback, useEffect, useState } from "react";
import { announce } from "./a11y/announcer";
import { useRovingTabindex } from "./a11y/roving";
import { useI18n } from "./i18n";
import { Icon, type IconName } from "./icons";
import { PersistenceNotes, usePersistence } from "./persistence";
import { PreviewPanel, type Sequenced } from "./PreviewPanel";
import { Timeline, TIMELINE_SECONDS } from "./Timeline";
import { applyTheme, loadPref, nextPref, savePref, watchSystem, type ThemePref } from "./theme/theme";
import { FPS } from "./timecode";

type EngineState = { status: "loading" } | { status: "ready"; info: EngineInfo; backend: EngineBackend } | { status: "error"; message: string };

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

function Library({ tool, onSoon }: { tool: Tool; onSoon: (m: string) => void }) {
  const { t } = useI18n();
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
        <input type="search" placeholder={search} aria-label={search} disabled={!!tool.soon} />
      </label>
      <div className="panel-body">
        {tool.id === "media" ? (
          <button className="dropzone" onClick={() => onSoon(t("media.importSoon"))}>
            <span className="drop-icon"><Icon name="upload" size={26} /></span>
            <strong>{t("media.import")}</strong>
            <span>{t("media.importHint")}</span>
          </button>
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
  const [opened, setOpened] = useState(0); // bumped when the preview opens a clip: the timeline re-reads the engine's project
  const [seq, setSeq] = useState<Sequenced>({ project: null, rate: { num: FPS, den: 1 }, endFrame: TIMELINE_SECONDS * FPS });
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

  useEffect(() => {
    let alive = true;
    createEngine()
      .then(async (e) => ({ info: await e.info(), backend: e.backend, e }))
      .then(({ e, ...r }) => alive && (setEngine({ status: "ready", ...r }), setCore(e)))
      .catch((e: unknown) => alive && setEngine({ status: "error", message: e instanceof Error ? e.message : String(e) }));
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const soon = useCallback((m: string) => setToast(m), []);
  const pick = (id: string) => { setSheet(id === tool ? !sheet : true); setTool(id); };
  const activeId = wide && tool === "edit" ? "media" : tool;
  const active = TOOLS.find((x) => x.id === activeId) ?? TOOLS[0]!;
  const activeLabel = t(`tool.${active.id}.label`);
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
          {active.id === "edit" ? <Details /> : <Library tool={active} onSoon={soon} />}
        </section>

        <PreviewPanel engine={core} ready={persistence.ready} frame={frame} playing={playing} ratios={RATIOS} ratio={ratio} onRatio={(id) => setRatio(id as typeof ratio)} onFrame={setFrame} onPlaying={setPlaying} onSequence={setSeq} onOpened={() => setOpened((n) => n + 1)} />

        {wide && <section className="inspector" aria-label={t("details.title")} data-testid="panel-inspector"><Details /></section>}

        <Timeline frame={frame} playing={playing} zoom={zoom} onFrame={setFrame} fps={seq.rate.num / seq.rate.den} endFrame={seq.endFrame} onZoom={setZoom} onNotice={soon} editing={persistence.session?.editing} epoch={persistence.epoch + opened} />
      </main>

      <PersistenceNotes state={persistence} />
      <div className="toast" role="status">{toast}</div>
    </div>
  );
}
