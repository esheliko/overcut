import { createEngine, type Capabilities, type CodecSupport } from "@app/engine-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { buildReport, sentence, verdict } from "./report";
import { createRunner } from "./runner";
import { TEST_IDS, type TestId, type TestResult } from "./types";

type TFn = ReturnType<typeof useI18n>["t"];

function Row({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className="diag-row" role="row">
      <dt role="rowheader">{label}</dt>
      <dd role="cell" data-tone={tone}>{value}</dd>
    </div>
  );
}

function Codec({ c, t }: { c: CodecSupport; t: TFn }) {
  const tone = (s: string) => (s === "no" ? "bad" : s === "unknown" ? undefined : "good");
  return (
    <div className="diag-row" role="row">
      <dt role="rowheader">{t(`diag.codec.${c.codec}`) === `diag.codec.${c.codec}` ? c.codec : t(`diag.codec.${c.codec}`)}</dt>
      <dd role="cell">
        <span data-tone={tone(c.decode)}>{t("diag.play", { state: t(`diag.support.${c.decode}`) })}</span>
        <br />
        <span data-tone={tone(c.encode)}>{t("diag.save", { state: t(`diag.support.${c.encode}`) })}</span>
      </dd>
    </div>
  );
}

function CapabilityTable({ caps, t }: { caps: Capabilities; t: TFn }) {
  const p = caps.platform;
  const a = caps.webgpu.adapter;
  const device = [p.os ?? p.platform, p.arch].filter(Boolean).join(" ");
  const yn = (b: boolean, no: string) => (b ? t("diag.yes") : no);
  const chip = a ? [a.vendor, a.architecture, a.description].filter(Boolean).join(" ") : "";
  const maxTex = caps.webgpu.limits.maxTextureDimension2D;
  return (
    <>
      {caps.issues.length > 0 && (
        <div className="diag-issues" role="note">
          <strong>{t("diag.issues")}</strong>
          <ul>{caps.issues.map((i) => <li key={i}>{i}</li>)}</ul>
        </div>
      )}
      <h3>{t("diag.section.device")}</h3>
      <dl className="diag-table" role="table" aria-label={t("diag.section.device")}>
        <Row label={t("diag.row.system")} value={device || t("diag.unknown")} />
        <Row label={t("diag.row.cores")} value={p.hardware_concurrency ? String(p.hardware_concurrency) : t("diag.notShared")} />
        <Row label={t("diag.row.memory")} value={p.device_memory_gb ? t("diag.memory", { gb: p.device_memory_gb }) : t("diag.notShared")} />
        <Row label={t("diag.row.runningAs")} value={t(caps.host === "tauri" ? "diag.host.tauri" : "diag.host.web")} />
      </dl>
      <h3>{t("diag.section.video")}</h3>
      <dl className="diag-table" role="table" aria-label={t("diag.section.video")}>{caps.codecs.map((c) => <Codec key={c.codec} c={c} t={t} />)}</dl>
      <h3>{t("diag.section.graphics")}</h3>
      <dl className="diag-table" role="table" aria-label={t("diag.section.graphics")}>
        <Row label={t("diag.gfx.webgpu")} value={caps.webgpu.available ? t("diag.gfx.available") : caps.webgpu.error ? t("diag.gfx.unavailableWhy", { why: caps.webgpu.error }) : t("diag.gfx.unavailable")} tone={caps.webgpu.available ? "good" : "bad"} />
        {a && <Row label={t("diag.gfx.chip")} value={a.fallback ? t("diag.gfx.software", { name: chip }) : chip || t("diag.gfx.unnamed")} tone={a.fallback ? "bad" : undefined} />}
        {maxTex ? <Row label={t("diag.gfx.largest")} value={t("diag.gfx.largestValue", { px: maxTex })} /> : null}
        <Row label={t("diag.gfx.webgl2")} value={caps.webgl2.available ? (caps.webgl2.renderer ? t("diag.gfx.availableNamed", { name: caps.webgl2.renderer }) : t("diag.gfx.available")) : t("diag.gfx.unavailable")} tone={caps.webgl2.available ? "good" : "bad"} />
      </dl>
      <h3>{t("diag.section.other")}</h3>
      <dl className="diag-table" role="table" aria-label={t("diag.section.other")}>
        <Row label={t("diag.row.threads")} value={yn(caps.cross_origin_isolated && caps.shared_array_buffer, t("diag.off"))} tone={caps.cross_origin_isolated ? "good" : "bad"} />
        <Row label={t("diag.row.storage")} value={yn(caps.opfs, t("diag.notAvailable"))} tone={caps.opfs ? "good" : "bad"} />
        <Row label={t("diag.row.workers")} value={yn(caps.web_workers, t("diag.no"))} />
      </dl>
    </>
  );
}

type Phase = "idle" | "running" | "done";

export default function Diagnostics() {
  const { t } = useI18n();
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
    document.title = `${t("diag.title")} · ${t("app.name")}`;
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
    for (const id of TEST_IDS) {
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
  const idx = current ? TEST_IDS.indexOf(current) : -1;

  return (
    <div className="diag" data-testid="diagnostics">
      <header className="diag-head">
        <a className="diag-back" href="/"><span aria-hidden="true">←</span> {t("diag.back")}</a>
        <h1>{t("diag.title")}</h1>
        <p>{t("diag.intro")}</p>
      </header>

      <section aria-labelledby="diag-test" className="diag-card">
        <h2 id="diag-test">{t("diag.test.heading")}</h2>
        <p className="diag-muted">{t("diag.test.hint")}</p>
        <button className="diag-run" onClick={() => void run()} disabled={phase === "running"} data-testid="run-test">
          {t(phase === "running" ? "diag.running" : phase === "done" ? "diag.runAgain" : "diag.run")}
        </button>
        {phase === "running" && current && (
          <div className="diag-progress" role="status" aria-live="polite">
            <span>{t("diag.progress", { n: idx + 1, total: TEST_IDS.length, title: t(`diag.t.${current}.title`) })}</span>
            <progress max={TEST_IDS.length} value={idx + frac} aria-label={t("diag.progress.label")} />
          </div>
        )}
        <ul className="diag-results" data-testid="results">
          {TEST_IDS.filter((id) => results.some((r) => r.id === id)).map((id) => {
            const r = results.find((x) => x.id === id)!;
            const v = verdict(r);
            return (
              <li key={id} data-status={r.status} data-verdict={v}>
                <div className="diag-res-head"><strong>{t(`diag.t.${id}.title`)}</strong>{v !== "na" && <span className="diag-badge" data-verdict={v}>{t(`diag.verdict.${v}`)}</span>}</div>
                <p>{sentence(r, t)}</p>
                <p className="diag-muted">{t(`diag.t.${id}.what`)}</p>
              </li>
            );
          })}
        </ul>
        {phase === "done" && (
          <div className="diag-copy">
            <button className="diag-run" onClick={() => void copy()} data-testid="copy">{t("diag.copy")}</button>
            <p role="status" className="diag-muted">
              {t(copied === "ok" ? "diag.copy.ok" : copied === "manual" ? "diag.copy.manual" : "diag.copy.idle")}
            </p>
            <label className="sr-only" htmlFor="diag-text">{t("diag.copy.textLabel")}</label>
            <textarea id="diag-text" ref={text} readOnly value={report} rows={4} onFocus={(e) => e.currentTarget.select()} data-testid="report" />
          </div>
        )}
      </section>

      <section aria-labelledby="diag-caps" className="diag-card">
        <h2 id="diag-caps">{t("diag.caps.heading")}</h2>
        {!caps && !capsError && <p className="diag-muted">{t("diag.caps.checking")}</p>}
        {capsError && <p role="alert" className="diag-bad">{t("diag.caps.error", { message: capsError })}</p>}
        {caps && <CapabilityTable caps={caps} t={t} />}
      </section>
    </div>
  );
}
