/** Export (M1-035): the top-bar button, the progress chip, and the dialog (full-screen sheet on a phone, modal on a desktop). Logic lives in model.ts, useExport.ts, deliver.ts. */
import { ExportError, probeExportFormats, type Engine, type ExportFormats } from "@app/engine-client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { announce } from "../a11y/announcer";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { TICKS } from "../media/plan";
import { sequenceView } from "../PreviewPanel";
import { useProjectStore, useStore } from "../store/projectStore";
import { canShareFile, saveFile, shareFile } from "./deliver";
import { QUALITIES, PRESET_IDS, buildSettings, errorKey, estimateBytes, etaSeconds, formatBytes, formatClock, fpsSteps, loadRemembered, outputFps, pickFormat, presetChoice, presetHint, resolutionSteps, saveName, saveRemembered, usableCustom, type Choice, type PresetId, type QualityId, type Source } from "./model";
import { useExport, type ExportState } from "./useExport";

const probes = new Map<string, Promise<ExportFormats>>();
/** The browser's answer for one size and rate, asked once per page (an answer cannot change while the tab lives). */
function probeOnce(width: number, height: number, fps: number): Promise<ExportFormats> {
  const key = `${width}x${height}@${fps.toFixed(3)}`;
  let p = probes.get(key);
  if (!p) probes.set(key, (p = probeExportFormats({ width, height, fps })));
  return p;
}

const fmtKey = (w: number, h: number, fps: number) => `${w}x${h}@${fps.toFixed(3)}`;

export function ExportControl({ engine, fileOf }: { engine: Engine | null; fileOf(id: string): Promise<File | null> }) {
  const { t, locale } = useI18n();
  const store = useStore();
  const project = useProjectStore((s) => s.project);
  const view = sequenceView(project);
  const src: Source | null = useMemo(
    () => (view.has ? { width: view.size.width, height: view.size.height, fps: view.rate.num / view.rate.den, seconds: view.endTicks / TICKS } : null),
    [view.has, view.size.width, view.size.height, view.rate.num, view.rate.den, view.endTicks],
  );
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  openRef.current = open;

  const sources = useCallback(async (sequence: string): Promise<Record<string, Blob>> => {
    const p = store.getState().project;
    const seq = p?.sequences.find((s) => s.id === sequence);
    const out: Record<string, Blob> = {};
    for (const id of new Set(seq?.tracks.flatMap((tr) => tr.clips.map((c) => c.media)))) {
      const f = await fileOf(id);
      if (!f) throw new ExportError("media_unavailable", "A clip's file is not available.");
      out[id] = f;
    }
    return out;
  }, [store, fileOf]);

  const onPhase = useCallback((s: ExportState) => {
    store.setReadOnly(s.phase === "running");
    if (s.phase === "done" || s.phase === "failed") {
      if (!openRef.current) setOpen(true); // finished while the dialog was tucked away: bring it back, the file needs saving
      announce(s.phase === "done" ? t("export.announce.done") : t("export.announce.failed"), s.phase === "failed" ? "assertive" : "polite");
    }
  }, [store, t]);
  const ex = useExport(engine, sources, onPhase);
  const running = ex.state.phase === "running" ? ex.state : null;
  const percent = running?.progress ? Math.floor(running.progress.fraction * 100) : 0;

  // Say the progress every quarter, not every update (a screen reader would never finish a sentence).
  const spoken = useRef(0);
  useEffect(() => {
    if (!running) { spoken.current = 0; return; }
    const q = Math.floor(percent / 25) * 25;
    if (q > spoken.current) { spoken.current = q; announce(t("export.announce.progress", { percent: q })); }
  }, [running, percent, t]);

  const close = () => { setOpen(false); if (ex.state.phase !== "running") ex.reset(); };

  return (
    <>
      {running ? (
        <button className="primary export-chip" data-testid="export-chip" onClick={() => setOpen(true)} aria-label={t("export.chip.label", { percent })}>
          <span className="export-chip-bar" style={{ inlineSize: `${percent}%` }} aria-hidden="true" />
          <span className="export-chip-text">{t("export.chip.text", { percent })}</span>
        </button>
      ) : (
        <button className="primary" data-testid="export-open" disabled={!engine || !src} title={!src ? t("export.needClip") : undefined} onClick={() => setOpen(true)}>
          <Icon name="export" size={18} /><span>{t("export.label")}</span>
        </button>
      )}
      {open && src && project && (
        <Dialog
          src={src}
          state={ex.state}
          locale={locale}
          onStart={(s) => void ex.start(project.sequences[0]!.id, s)}
          onCancel={ex.cancel}
          onBack={ex.reset}
          onClose={close}
          onTuck={() => setOpen(false)}
        />
      )}
    </>
  );
}

interface DialogProps {
  src: Source;
  state: ExportState;
  locale: string;
  onStart(settings: ReturnType<typeof buildSettings>): void;
  onCancel(): void;
  onBack(): void;
  onClose(): void;
  onTuck(): void;
}

function Dialog({ src, state, locale, onStart, onCancel, onBack, onClose, onTuck }: DialogProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const head = useRef<HTMLHeadingElement>(null);
  const running = state.phase === "running";
  const lastSettings = useRef<ReturnType<typeof buildSettings> | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  // A new view (progress, done, error, back to settings) starts at its heading, so a screen reader reads where it is.
  useEffect(() => { head.current?.focus({ preventScroll: true }); }, [state.phase]);

  // Esc and the close button: while exporting they tuck the dialog away (the export goes on); otherwise they close it.
  const dismiss = () => (running ? onTuck() : onClose());
  const start = (s: ReturnType<typeof buildSettings>) => { lastSettings.current = s; onStart(s); };

  let body: ReactNode;
  let title = t("export.title");
  if (state.phase === "running") { title = t("export.running.title"); body = <Progress state={state} onCancel={onCancel} onTuck={onTuck} />; }
  else if (state.phase === "done") { title = t("export.done.title"); body = <Done state={state} src={src} locale={locale} onClose={onClose} onAgain={onBack} />; }
  else if (state.phase === "failed") { title = t("export.failed.title"); body = <Failed error={state.error} onRetry={() => lastSettings.current && start(lastSettings.current)} onBack={onBack} />; }
  else body = <Setup src={src} locale={locale} onStart={start} />;

  return (
    <dialog ref={ref} className="export-dialog" aria-labelledby="export-title" data-testid="export-dialog" data-phase={state.phase} onCancel={(e) => { e.preventDefault(); dismiss(); }}>
      <header className="export-head">
        <h2 id="export-title" ref={head} tabIndex={-1}>{title}</h2>
        <button className="icon-btn" onClick={dismiss} aria-label={running ? t("export.minimize") : t("export.close")} data-testid="export-close"><Icon name={running ? "minus" : "close"} size={20} /></button>
      </header>
      <div className="export-body">{body}</div>
    </dialog>
  );
}

// ---- 1. settings ----
function Setup({ src, locale, onStart }: { src: Source; locale: string; onStart(s: ReturnType<typeof buildSettings>): void }) {
  const { t } = useI18n();
  const remembered = useMemo(() => loadRemembered(), []);
  const [preset, setPreset] = useState<PresetId | "custom">(() => (remembered.preset === "custom" && !usableCustom(remembered.custom, src) ? "original" : remembered.preset));
  const [custom, setCustom] = useState<Choice>(() => usableCustom(remembered.custom, src) ?? presetChoice("original", src));
  const choice = preset === "custom" ? custom : presetChoice(preset, src);

  // What this device can encode at each preset's size, and at the current choice. Offer only what passes.
  const keys = useMemo(() => {
    const m = new Map<string, [number, number, number]>();
    for (const id of PRESET_IDS) { const c = presetChoice(id, src); const f = outputFps(c, src); m.set(fmtKey(c.width, c.height, f), [c.width, c.height, f]); }
    const f = outputFps(choice, src);
    m.set(fmtKey(choice.width, choice.height, f), [choice.width, choice.height, f]);
    return [...m.entries()];
  }, [src, choice]);
  const [formats, setFormats] = useState<Record<string, ExportFormats>>({});
  useEffect(() => {
    let alive = true;
    for (const [k, [w, h, f]] of keys) void probeOnce(w, h, f).then((r) => alive && setFormats((cur) => (cur[k] ? cur : { ...cur, [k]: r })));
    return () => { alive = false; };
  }, [keys]);
  const formatsOf = (c: Choice) => formats[fmtKey(c.width, c.height, outputFps(c, src))];
  const ready = keys.every(([k]) => formats[k]);
  const offered = PRESET_IDS.filter((id) => (formatsOf(presetChoice(id, src))?.options.length ?? 0) > 0);

  // A remembered preset this device cannot do any more: fall back to the first it can.
  const firstOffered = offered[0];
  const stillOffered = preset === "custom" || offered.includes(preset);
  useEffect(() => {
    if (ready && !stillOffered && firstOffered) setPreset(firstOffered);
  }, [ready, stillOffered, firstOffered]);

  const fmts = formatsOf(choice);
  const format = fmts ? pickFormat(choice, fmts.options, fmts.auto) : null;
  const edit = (patch: Partial<Choice>) => { setCustom({ ...choice, ...patch }); setPreset("custom"); };
  const pickPreset = (id: PresetId) => { setPreset(id); setCustom(presetChoice(id, src)); };
  const shape = (c: Choice) => `${c.width}×${c.height}`;
  const letterbox = preset === "vertical" && src.width > src.height * 0.57;

  const go = () => {
    if (!format) return;
    saveRemembered(preset === "custom" ? { preset, custom } : { preset });
    onStart(buildSettings(choice, src, format));
  };

  const fmtName = (id: string) => t(`export.format.${id}`);
  const fps = src.fps % 1 === 0 ? String(src.fps) : src.fps.toFixed(2);

  if (!ready) return <p className="export-note" role="status">{t("export.checking")}</p>;
  if (offered.length === 0) return <p className="export-error" role="alert" data-testid="export-nodevice">{t("export.err.noEncoder")}</p>;
  return (
    <>
      <p className="export-summary" data-testid="export-summary">{t("export.summary", { size: `${src.width}×${src.height}`, fps, length: formatClock(src.seconds) })}</p>
      <fieldset className="export-presets">
        <legend>{t("export.presets")}</legend>
        {offered.map((id) => {
          const hint = presetHint(id, src);
          return (
            <label key={id} className="export-chip-choice" data-checked={preset === id}>
              <input type="radio" name="export-preset" value={id} checked={preset === id} onChange={() => pickPreset(id)} data-testid={`export-preset-${id}`} />
              <strong>{t(`export.preset.${id}`)}</strong>
              <span>{t(hint.key, hint.values)}</span>
            </label>
          );
        })}
      </fieldset>
      {letterbox && <p className="export-note">{t("export.verticalNote")}</p>}

      <details className="export-adv" open={preset === "custom" || undefined}>
        <summary>{t("export.advanced")}</summary>
        <div className="export-fields">
          <label>{t("export.field.resolution")}
            <select value={choice.width + "x" + choice.height} onChange={(e) => { const [w, h] = e.target.value.split("x").map(Number); edit({ width: w!, height: h! }); }} data-testid="export-resolution">
              {resolutionSteps(src).filter((r) => (formatsOf({ ...choice, width: r.width, height: r.height })?.options.length ?? 1) > 0 || r.width === choice.width).map((r) => (
                <option key={r.width + "x" + r.height} value={r.width + "x" + r.height}>{r.short === null ? t("export.res.same", { size: shape({ ...choice, ...r }) }) : `${r.short}p (${r.width}×${r.height})`}</option>
              ))}
              {!resolutionSteps(src).some((r) => r.width === choice.width && r.height === choice.height) && <option value={choice.width + "x" + choice.height}>{shape(choice)}</option>}
            </select>
          </label>
          <label>{t("export.field.fps")}
            <select value={choice.fps ?? ""} onChange={(e) => edit({ fps: e.target.value === "" ? null : Number(e.target.value) })} data-testid="export-fps">
              {fpsSteps(src.fps).map((f) => <option key={f ?? "same"} value={f ?? ""}>{f === null ? t("export.fps.same", { fps }) : t("export.fps.value", { fps: f })}</option>)}
              {choice.fps !== null && !fpsSteps(src.fps).includes(choice.fps) && <option value={choice.fps}>{t("export.fps.value", { fps: choice.fps })}</option>}
            </select>
          </label>
          <label>{t("export.field.format")}
            <select value={format?.id ?? ""} onChange={(e) => edit({ format: e.target.value as Choice["format"] })} data-testid="export-format">
              {fmts?.options.map((o) => <option key={o.id} value={o.id}>{fmtName(o.id) + (o.warnings.length > 0 ? ` – ${t("export.format.limited")}` : "")}</option>)}
            </select>
          </label>
          <label>{t("export.field.quality")}
            <select value={choice.quality} onChange={(e) => edit({ quality: e.target.value as QualityId })} data-testid="export-quality">
              {QUALITIES.map((q) => <option key={q} value={q}>{t(`export.quality.${q}`)}</option>)}
            </select>
          </label>
        </div>
      </details>

      {format && (
        <p className="export-estimate" data-testid="export-estimate">
          {t("export.estimate", { size: formatBytes(estimateBytes(choice, src, format), locale), format: fmtName(format.id) })}
        </p>
      )}
      {format?.warnings.map((w) => <p key={w} className="export-note" data-testid="export-warning">{t("export.warn.limited")}</p>)}
      <button className="primary export-go" onClick={go} disabled={!format} data-testid="export-go"><Icon name="export" size={20} /><span>{t("export.go")}</span></button>
    </>
  );
}

// ---- 2. progress ----
function Progress({ state, onCancel, onTuck }: { state: Extract<ExportState, { phase: "running" }>; onCancel(): void; onTuck(): void }) {
  const { t, locale } = useI18n();
  const p = state.progress;
  const fraction = p?.fraction ?? 0;
  const percent = Math.floor(fraction * 100);
  const finishing = p?.phase === "finalizing";
  const eta = p?.etaMs != null && !finishing ? etaSeconds(p.etaMs) : null;
  const left = eta === null ? t("export.eta.estimating") : eta >= 60 ? t("export.eta.minutes", { minutes: Math.ceil(eta / 60) }) : t("export.eta.seconds", { seconds: eta });
  return (
    <>
      <div className="export-percent" data-testid="export-percent" aria-hidden="true">{finishing ? t("export.finishing") : new Intl.NumberFormat(locale, { style: "percent" }).format(Math.min(0.99, fraction) || 0)}</div>
      <div className="export-bar" role="progressbar" aria-label={t("export.running.title")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={finishing ? t("export.finishing") : t("export.valuetext", { percent })} data-testid="export-progress">
        <span style={{ inlineSize: `${percent}%` }} />
      </div>
      <p className="export-meta">
        <span>{p ? t("export.frames", { done: p.framesDone, total: p.totalFrames }) : t("export.starting")}</span>
        <span>{finishing ? "" : left}</span>
      </p>
      <p className="export-note">{t("export.readonly")}</p>
      <div className="export-actions">
        <button className="export-secondary" onClick={onTuck} data-testid="export-minimize">{t("export.keepEditing")}</button>
        <button className="export-secondary export-danger" onClick={onCancel} data-testid="export-cancel">{t("export.cancel")}</button>
      </div>
    </>
  );
}

// ---- 3. done ----
function Done({ state, src, locale, onClose, onAgain }: { state: Extract<ExportState, { phase: "done" }>; src: Source; locale: string; onClose(): void; onAgain(): void }) {
  const { t } = useI18n();
  const { result } = state;
  const file = useMemo(() => new File([state.file], saveName(result.fileName), { type: state.file.type }), [state.file, result.fileName]);
  const [note, setNote] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const share = useMemo(() => canShareFile(file), [file]);
  const kind = result.mime.startsWith("video/webm") ? "WebM" : "MP4";
  const run = async (what: "save" | "share") => {
    setFailed(false);
    try {
      if (what === "save") {
        const r = await saveFile(file);
        if (r !== "dismissed") setNote(t(r === "saved" ? "export.saved" : "export.downloaded", { name: file.name }));
      } else if ((await shareFile(file, file.name)) === "shared") setNote(t("export.shared"));
    } catch {
      setFailed(true);
    }
  };
  useEffect(() => { if (note) announce(note); }, [note]);
  return (
    <>
      <div className="export-ok" aria-hidden="true"><Icon name="check" size={28} /></div>
      <dl className="export-facts" data-testid="export-done">
        <div><dt>{t("export.fact.file")}</dt><dd data-testid="export-filename">{file.name}</dd></div>
        <div><dt>{t("export.fact.size")}</dt><dd data-testid="export-filesize">{formatBytes(result.fileBytes, locale)}</dd></div>
        <div><dt>{t("export.fact.length")}</dt><dd>{formatClock(result.stats.durationSeconds || src.seconds)}</dd></div>
        <div><dt>{t("export.fact.format")}</dt><dd>{kind}</dd></div>
      </dl>
      {result.warnings.length > 0 && <p className="export-note">{t("export.warn.limited")}</p>}
      {failed && <p className="export-error" role="alert" data-testid="export-save-error">{t("export.err.save")}</p>}
      {note && <p className="export-note" role="status" data-testid="export-note">{note}</p>}
      <div className="export-actions">
        <button className="primary export-go" onClick={() => void run("save")} data-testid="export-save"><Icon name="download" size={20} /><span>{t("export.save")}</span></button>
        {share && <button className="export-secondary" onClick={() => void run("share")} data-testid="export-share"><Icon name="share" size={20} /><span>{t("export.share")}</span></button>}
      </div>
      <div className="export-actions">
        <button className="export-secondary" onClick={onAgain} data-testid="export-again">{t("export.again")}</button>
        <button className="export-secondary" onClick={onClose} data-testid="export-done-close">{t("export.close")}</button>
      </div>
    </>
  );
}

// ---- 4. failed ----
function Failed({ error, onRetry, onBack }: { error: unknown; onRetry(): void; onBack(): void }) {
  const { t } = useI18n();
  const detail = error instanceof Error ? error.message : String(error);
  return (
    <>
      <p className="export-error" role="alert" data-testid="export-error">{t(errorKey(error))}</p>
      <details className="export-adv"><summary>{t("export.details")}</summary><p className="export-note" data-testid="export-error-detail">{detail}</p></details>
      <div className="export-actions">
        <button className="primary export-go" onClick={onRetry} data-testid="export-retry"><span>{t("export.retry")}</span></button>
        <button className="export-secondary" onClick={onBack} data-testid="export-back">{t("export.back")}</button>
      </div>
    </>
  );
}
