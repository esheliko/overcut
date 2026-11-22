import { createEngine, type EngineBackend, type EngineInfo } from "@app/engine-client";
import { useEffect, useState } from "react";

type EngineState = { status: "loading" } | { status: "ready"; info: EngineInfo; backend: EngineBackend } | { status: "error"; message: string };

/** The editor's four work areas. On a phone one is shown at a time (tab bar); from tablet width up all are visible. */
const PANELS = [
  { id: "media", label: "Media", hint: "Import and browse clips, images and audio. (M1)" },
  { id: "preview", label: "Preview", hint: "Frame-accurate playback and scrubbing. (M1)" },
  { id: "timeline", label: "Timeline", hint: "Cut, trim, layer and animate. (M1-M2)" },
  { id: "inspector", label: "Inspector", hint: "Properties, effects, text, audio. (M2-M4)" },
] as const;
type PanelId = (typeof PANELS)[number]["id"];

export function App() {
  const [engine, setEngine] = useState<EngineState>({ status: "loading" });
  const [active, setActive] = useState<PanelId>("preview");

  useEffect(() => {
    let alive = true;
    createEngine()
      .then(async (e) => ({ info: await e.info(), backend: e.backend }))
      .then((r) => alive && setEngine({ status: "ready", ...r }))
      .catch((e: unknown) => alive && setEngine({ status: "error", message: e instanceof Error ? e.message : String(e) }));
    return () => { alive = false; };
  }, []);

  return (
    <div className="editor">
      <header className="topbar">
        <strong className="brand">OverCut</strong>
        <span className="status" data-testid="engine" aria-live="polite">
          {engine.status === "loading" && "Starting engine…"}
          {engine.status === "ready" && `Engine ${engine.info.name} v${engine.info.version} (${engine.backend})`}
          {engine.status === "error" && <span role="alert" data-testid="engine-error">Engine failed to start: {engine.message}</span>}
        </span>
      </header>

      <nav className="tabs" role="tablist" aria-label="Editor areas">
        {PANELS.map((p) => (
          <button key={p.id} role="tab" id={`tab-${p.id}`} aria-selected={active === p.id} aria-controls={`panel-${p.id}`} onClick={() => setActive(p.id)}>
            {p.label}
          </button>
        ))}
      </nav>

      <main className="panels">
        {PANELS.map((p) => (
          <section key={p.id} id={`panel-${p.id}`} className={`panel panel-${p.id}`} role="tabpanel" aria-labelledby={`tab-${p.id}`} data-active={active === p.id} data-testid={`panel-${p.id}`}>
            <h2>{p.label}</h2>
            <p>{p.hint}</p>
          </section>
        ))}
      </main>
    </div>
  );
}
