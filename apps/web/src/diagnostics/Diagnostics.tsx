import { createEngine, type Capabilities, type CodecSupport, type Support } from "@app/engine-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { buildReport, sentence, TEST_ORDER, verdict } from "./report";
import { createRunner } from "./runner";
import { TESTS, type TestId, type TestResult } from "./types";

const SUPPORT_TEXT: Record<Support, string> = { hardware: "Yes, fast (hardware)", supported: "Yes (software)", no: "Not supported", unknown: "Could not check" };
const CODEC_NAME: Record<string, string> = { h264: "H.264 (most phone and camera video)", hevc: "HEVC / H.265 (iPhone and newer cameras)", vp9: "VP9 (web video)", av1: "AV1 (newest, smallest files)" };
const VERDICT_TEXT = { good: "Good", ok: "OK", slow: "Slow", na: "" } as const;

const yes = (b: boolean | undefined, no = "No") => (b ? "Yes" : no);

function Row({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className="diag-row" role="row">
      <dt role="rowheader">{label}</dt>
      <dd role="cell" data-tone={tone}>{value}</dd>
    </div>
  );
}

function Codec({ c }: { c: CodecSupport }) {
  return (
    <div className="diag-row" role="row">
      <dt role="rowheader">{CODEC_NAME[c.codec] ?? c.codec}</dt>
      <dd role="cell">
        <span data-tone={c.decode === "no" ? "bad" : c.decode === "unknown" ? undefined : "good"}>Play: {SUPPORT_TEXT[c.decode]}</span>
        <br />
        <span data-tone={c.encode === "no" ? "bad" : c.encode === "unknown" ? undefined : "good"}>Save: {SUPPORT_TEXT[c.encode]}</span>
      </dd>
    </div>
  );
}

function Capabilities_({ caps }: { caps: Capabilities }) {
  const p = caps.platform;
  const a = caps.webgpu.adapter;
  const device = [p.os ?? p.platform, p.arch].filter(Boolean).join(" ");
  return (
    <>
      {caps.issues.length > 0 && (
        <div className="diag-issues" role="note">
          <strong>Things that may limit you here</strong>
          <ul>{caps.issues.map((i) => <li key={i}>{i}</li>)}</ul>
        </div>
      )}
      <h3>Your device</h3>
      <dl className="diag-table" role="table" aria-label="Device">
        <Row label="System" value={device || "Unknown"} />
        <Row label="Processor cores" value={p.hardware_concurrency ? String(p.hardware_concurrency) : "Not shared by this browser"} />
        <Row label="Memory" value={p.device_memory_gb ? `about ${p.device_memory_gb} GB (browsers round this down)` : "Not shared by this browser"} />
        <Row label="Running as" value={caps.host === "tauri" ? "OverCut app" : "Web page"} />
      </dl>
      <h3>Video</h3>
      <dl className="diag-table" role="table" aria-label="Video formats">{caps.codecs.map((c) => <Codec key={c.codec} c={c} />)}</dl>
      <h3>Graphics</h3>
      <dl className="diag-table" role="table" aria-label="Graphics">
        <Row label="WebGPU (modern graphics)" value={caps.webgpu.available ? "Available" : `Not available${caps.webgpu.error ? ` (${caps.webgpu.error})` : ""}`} tone={caps.webgpu.available ? "good" : "bad"} />
        {a && <Row label="Graphics chip" value={[a.vendor, a.architecture, a.description].filter(Boolean).join(" ") + (a.fallback ? " (software, slow)" : "") || "Unnamed"} tone={a.fallback ? "bad" : undefined} />}
        {caps.webgpu.limits.maxTextureDimension2D && <Row label="Largest image" value={`${caps.webgpu.limits.maxTextureDimension2D} px`} />}
        <Row label="WebGL2 (older graphics)" value={caps.webgl2.available ? `Available${caps.webgl2.renderer ? `: ${caps.webgl2.renderer}` : ""}` : "Not available"} tone={caps.webgl2.available ? "good" : "bad"} />
      </dl>
      <h3>Other</h3>
      <dl className="diag-table" role="table" aria-label="Other features">
        <Row label="Multi-threading" value={yes(caps.cross_origin_isolated && caps.shared_array_buffer, "Off")} tone={caps.cross_origin_isolated ? "good" : "bad"} />
        <Row label="Private file storage" value={yes(caps.opfs, "Not available")} tone={caps.opfs ? "good" : "bad"} />
        <Row label="Background workers" value={yes(caps.web_workers)} />
      </dl>
    </>
  );
}

type Phase = "idle" | "running" | "done";

export default function Diagnostics() {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [capsError, setCapsError] = useState<string | null>(null);
  const [app, setApp] = useState({ version: "?", backend: "?" });
  const [phase, setPhase] = useState<Phase>("idle");
  const [current, setCurrent] = useState<TestId | null>(null);
  const [frac, setFrac] = useState(0);
  const [results, setResults] = useState<TestResult[]>([]);
  const [copied, setCopied] = useState<"" | "ok" | "manual">("");
  const runner = useRef<ReturnType<typeof createRunner> | null>(null);
  const text = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    document.title = "Device check · OverCut";
    let alive = true;
    createEngine()
      .then(async (e) => { const [c, i] = await Promise.all([e.capabilities(), e.info()]); return { c, i, b: e.backend }; })
      .then(({ c, i, b }) => { if (alive) { setCaps(c); setApp({ version: i.version, backend: b }); } })
      .catch((e: unknown) => alive && setCapsError(e instanceof Error ? e.message : String(e)));
    return () => { alive = false; runner.current?.dispose(); };
  }, []);

  const run = useCallback(async () => {
    runner.current?.dispose();
    const r = (runner.current = createRunner());
    setPhase("running"); setResults([]); setCopied("");
    const out: TestResult[] = [];
    for (const id of TEST_ORDER) {
      setCurrent(id); setFrac(0);
      const res = await r.run(id, setFrac);
      out.push(res);
      setResults([...out]);
    }
    r.dispose();
    setCurrent(null); setPhase("done");
  }, []);

  const report = phase === "done" ? buildReport(caps, results, app) : "";
  const copy = async () => {
    try { await navigator.clipboard.writeText(report); setCopied("ok"); } catch {
      text.current?.focus(); text.current?.select(); setCopied("manual");
    }
  };
  const idx = current ? TEST_ORDER.indexOf(current) : -1;

  return (
    <div className="diag" data-testid="diagnostics">
      <header className="diag-head">
        <a className="diag-back" href="/"><span aria-hidden="true">←</span> Back to editor</a>
        <h1>Device check</h1>
        <p>See what your device can do and how fast it is. The test takes about a minute. Everything runs on this device: nothing is uploaded and no account is needed.</p>
      </header>

      <section aria-labelledby="diag-test" className="diag-card">
        <h2 id="diag-test">Speed test</h2>
        <p className="diag-muted">Keep this page open and in front while it runs. If you are sending us the result, tap Run, wait for it to finish, then tap Copy results.</p>
        <button className="diag-run" onClick={() => void run()} disabled={phase === "running"} data-testid="run-test">
          {phase === "running" ? "Testing…" : phase === "done" ? "Run it again" : "Run device test"}
        </button>
        {phase === "running" && current && (
          <div className="diag-progress" role="status" aria-live="polite">
            <span>Test {idx + 1} of {TEST_ORDER.length}: {TESTS.find((t) => t.id === current)?.title}</span>
            <progress max={TEST_ORDER.length} value={idx + frac} aria-label="Overall progress" />
          </div>
        )}
        <ul className="diag-results" data-testid="results">
          {TESTS.filter((t) => results.some((r) => r.id === t.id)).map((t) => {
            const r = results.find((x) => x.id === t.id)!;
            const v = verdict(r);
            return (
              <li key={t.id} data-status={r.status} data-verdict={v}>
                <div className="diag-res-head"><strong>{t.title}</strong>{v !== "na" && <span className="diag-badge" data-verdict={v}>{VERDICT_TEXT[v]}</span>}</div>
                <p>{sentence(r)}</p>
                <p className="diag-muted">{t.what}</p>
              </li>
            );
          })}
        </ul>
        {phase === "done" && (
          <div className="diag-copy">
            <button className="diag-run" onClick={() => void copy()} data-testid="copy">Copy results</button>
            <p role="status" className="diag-muted">
              {copied === "ok" && "Copied. Paste it into your message."}
              {copied === "manual" && "Your browser blocked copying: the text below is selected, copy it by hand."}
              {copied === "" && "Then paste it into your message to us."}
            </p>
            <label className="sr-only" htmlFor="diag-text">Results text</label>
            <textarea id="diag-text" ref={text} readOnly value={report} rows={4} onFocus={(e) => e.currentTarget.select()} data-testid="report" />
          </div>
        )}
      </section>

      <section aria-labelledby="diag-caps" className="diag-card">
        <h2 id="diag-caps">What this device supports</h2>
        {!caps && !capsError && <p className="diag-muted">Checking…</p>}
        {capsError && <p role="alert" className="diag-bad">The engine could not report this device: {capsError}. The speed test can still run.</p>}
        {caps && <Capabilities_ caps={caps} />}
      </section>
    </div>
  );
}
