import { createEngine, type EngineBackend, type EngineInfo } from "@app/engine-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./icons";
import { END_FRAME, Timeline } from "./Timeline";
import { FPS, timecode } from "./timecode";

type EngineState = { status: "loading" } | { status: "ready"; info: EngineInfo; backend: EngineBackend } | { status: "error"; message: string };

type Tool = { id: string; label: string; icon: IconName; blurb: string; soon?: string };
/** CapCut-style tool strip: the left rail on desktop and tablet, the bottom bar on a phone. */
const TOOLS: Tool[] = [
  { id: "media", label: "Media", icon: "media", blurb: "Your videos, photos and audio. Files stay on this device." },
  { id: "audio", label: "Audio", icon: "audio", blurb: "Music, sound effects and voice-over.", soon: "M3" },
  { id: "text", label: "Text", icon: "text", blurb: "Titles and styled text with animation.", soon: "M3" },
  { id: "captions", label: "Captions", icon: "captions", blurb: "Automatic captions from speech, made on your device.", soon: "M3" },
  { id: "effects", label: "Effects", icon: "effects", blurb: "Looks, glitches and motion effects.", soon: "M4" },
  { id: "transitions", label: "Transitions", icon: "transitions", blurb: "Smooth cuts between clips.", soon: "M4" },
  { id: "filters", label: "Filters", icon: "filters", blurb: "One-tap colour looks.", soon: "M4" },
  { id: "stickers", label: "Stickers", icon: "stickers", blurb: "Stickers and shapes.", soon: "M4" },
  { id: "edit", label: "Edit", icon: "edit", blurb: "" },
];

const RATIOS = [
  { id: "16:9", value: 16 / 9, label: "16:9 Landscape" },
  { id: "9:16", value: 9 / 16, label: "9:16 Vertical" },
  { id: "1:1", value: 1, label: "1:1 Square" },
  { id: "4:5", value: 4 / 5, label: "4:5 Portrait" },
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
  return (
    <>
      <header className="panel-head">
        <h2>{tool.label}</h2>
        {tool.soon && <span className="pill">Coming in {tool.soon}</span>}
      </header>
      <label className="search">
        <Icon name="search" size={18} />
        <input type="search" placeholder={`Search ${tool.label.toLowerCase()}`} aria-label={`Search ${tool.label.toLowerCase()}`} disabled={!!tool.soon} />
      </label>
      <div className="panel-body">
        {tool.id === "media" ? (
          <button className="dropzone" onClick={() => onSoon("Importing arrives in the first alpha (M1)")}>
            <span className="drop-icon"><Icon name="upload" size={26} /></span>
            <strong>Import</strong>
            <span>Videos, photos and audio. Drop files here.</span>
          </button>
        ) : (
          <EmptyState icon={tool.icon} title={tool.label} text={tool.blurb} />
        )}
      </div>
    </>
  );
}

const DETAIL_TABS = ["Video", "Audio", "Speed", "Animation", "Adjust"] as const;
function Details() {
  const [tab, setTab] = useState<(typeof DETAIL_TABS)[number]>("Video");
  return (
    <>
      <header className="panel-head"><h2>Details</h2></header>
      <div className="segmented" role="tablist" aria-label="Clip properties">
        {DETAIL_TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>
      <div className="panel-body">
        <EmptyState icon="edit" title="Nothing selected" text="Select a clip on the timeline to change its size, speed, volume and look." />
      </div>
    </>
  );
}

export function App() {
  const [engine, setEngine] = useState<EngineState>({ status: "loading" });
  const [tool, setTool] = useState("media");
  const [sheet, setSheet] = useState(false); // phone only: tool panel open above the bottom bar
  const [name, setName] = useState("Untitled project");
  const [ratio, setRatio] = useState<(typeof RATIOS)[number]["id"]>("16:9");
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(40);
  const [toast, setToast] = useState<string | null>(null);
  const wide = useMedia("(min-width: 1100px)");
  const roomy = useMedia("(min-width: 720px)"); // tablet and up: the tool panel is always open
  const frameRef = useRef(0);
  frameRef.current = frame;

  useEffect(() => {
    let alive = true;
    createEngine()
      .then(async (e) => ({ info: await e.info(), backend: e.backend }))
      .then((r) => alive && setEngine({ status: "ready", ...r }))
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
  const pick = (id: string) => { setSheet(id === tool ? !sheet : true); setTool(id); };
  const activeId = wide && tool === "edit" ? "media" : tool;
  const active = TOOLS.find((t) => t.id === activeId) ?? TOOLS[0]!;
  const ar = RATIOS.find((r) => r.id === ratio)!.value;
  const rail = wide ? TOOLS.filter((t) => t.id !== "edit") : TOOLS;

  return (
    <div className="editor">
      <header className="topbar">
        <div className="brand"><span className="logo" aria-hidden="true"><Icon name="split" size={16} /></span><strong>OverCut</strong></div>
        <input className="project-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} onBlur={() => setName((n) => n.trim() || "Untitled project")} aria-label="Project name" spellCheck={false} />
        <div className="top-actions">
          <span className="chip" data-testid="engine" data-state={engine.status} aria-live="polite">
            <span className="dot" aria-hidden="true" />
            <span className="chip-text">
              {engine.status === "loading" && "Starting engine…"}
              {engine.status === "ready" && `Engine ${engine.info.name} v${engine.info.version} (${engine.backend})`}
              {engine.status === "error" && <span role="alert" data-testid="engine-error">Engine failed to start: {engine.message}</span>}
            </span>
          </span>
          <button className="primary" onClick={() => soon("Export arrives in the first alpha (M1): 1080p H.264, no watermark")}>
            <Icon name="export" size={18} /><span>Export</span>
          </button>
        </div>
      </header>

      <main className="workspace">
        <nav className="tools" aria-label="Tools">
          {rail.map((t) => (
            <button key={t.id} className="tool" aria-pressed={activeId === t.id && (roomy || sheet)} onClick={() => pick(t.id)}>
              <Icon name={t.icon} size={24} />
              <span>{t.label}</span>
            </button>
          ))}
        </nav>

        <section className="library" data-open={sheet} aria-label={active.label} data-testid="panel-tool">
          <button className="sheet-close icon-btn" aria-label="Close panel" onClick={() => setSheet(false)}><Icon name="close" size={18} /></button>
          {active.id === "edit" ? <Details /> : <Library tool={active} onSoon={soon} />}
        </section>

        <section className="stage" aria-label="Preview" data-testid="panel-preview">
          <div className="stage-view">
            <div className="canvas" style={{ ["--ar" as string]: ar, aspectRatio: String(ar) }}>
              <div className="canvas-hint"><Icon name="film" size={30} /><span>Your video appears here</span></div>
            </div>
          </div>
          <div className="player-bar">
            <div className="tc" aria-label="Playhead time"><span>{timecode(frame)}</span><span className="tc-total"> / {timecode(END_FRAME)}</span></div>
            <div className="transport" role="toolbar" aria-label="Playback">
              <button className="icon-btn" aria-label="Back to start" onClick={() => setFrame(0)}><Icon name="back" size={20} /></button>
              <button className="play" aria-label={playing ? "Pause" : "Play"} onClick={togglePlay}><Icon name={playing ? "pause" : "play"} size={22} /></button>
              <button className="icon-btn" aria-label="Jump to end" onClick={() => setFrame(END_FRAME)}><Icon name="forward" size={20} /></button>
            </div>
            <label className="ratio">
              <span className="sr-only">Aspect ratio</span>
              <select value={ratio} onChange={(e) => setRatio(e.target.value as typeof ratio)}>
                {RATIOS.map((r) => <option key={r.id} value={r.id}>{r.id === ratio ? r.id : r.label}</option>)}
              </select>
            </label>
          </div>
        </section>

        {wide && <section className="inspector" aria-label="Details" data-testid="panel-inspector"><Details /></section>}

        <Timeline frame={frame} playing={playing} zoom={zoom} onFrame={(f) => { setPlaying(false); setFrame(f); }} onZoom={setZoom} onSoon={soon} />
      </main>

      <div className="toast" role="status">{toast}</div>
    </div>
  );
}
