/** The export dialog itself (settings, progress, done, failed). Loaded on first use so it stays out of the first-load JavaScript. */
import { h264Percent, parseH264Failure, probeExportFormats, type DesktopCodecs, type ExportFormatOption, type ExportFormats, type H264FailureCode, type H264Progress } from "@app/engine-client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { announce } from "../a11y/announcer";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { useReturnFocus } from "../a11y/returnFocus";
import { canShareFile, saveFile, shareFile } from "./deliver";
import { getDesktop } from "../media/sources";
import { OPENH264_HOST_URL, recordNetworkEvent } from "../privacy/networkLog";
import { QUALITIES, PRESET_IDS, buildSettings, canOfferH264Download, desktopFormats, describeFailure, errorKey, formatLabelKey, formatNote, estimateBytes, etaSeconds, formatBytes, formatClock, fpsSteps, loadRemembered, outputFps, pickFormat, needsBars, presetChoice, presetHint, presetWarnings, resolutionSteps, saveName, saveRemembered, usableCustom, withoutCap, type Choice, type PresetId, type QualityId, type Source } from "./model";
import type { ExportState } from "./useExport";

const probes = new Map<string, Promise<ExportFormats>>();
/** The browser's answer for one size and rate, asked once per page (an answer cannot change while the tab lives). */
function probeOnce(width: number, height: number, fps: number): Promise<ExportFormats> {
  const key = `${width}x${height}@${fps.toFixed(3)}`;
  let p = probes.get(key);
  if (!p) probes.set(key, (p = probeExportFormats({ width, height, fps })));
  return p;
}

const fmtKey = (w: number, h: number, fps: number) => `${w}x${h}@${fps.toFixed(3)}`;


export interface DialogProps {
  src: Source;
  state: ExportState;
  locale: string;
  onStart(settings: ReturnType<typeof buildSettings>): void;
  onCancel(): void;
  onBack(): void;
  onClose(): void;
  onTuck(): void;
}

export function Dialog({ src, state, locale, onStart, onCancel, onBack, onClose, onTuck }: DialogProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const head = useRef<HTMLHeadingElement>(null);
  const running = state.phase === "running";
  const lastSettings = useRef<ReturnType<typeof buildSettings> | null>(null);
  useReturnFocus();

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
  // Desktop app: the native encoder decides (not the webview's WebCodecs); asked again after the person enables MP4.
  const desktop = getDesktop();
  const [codecs, setCodecs] = useState<DesktopCodecs | null>(null);
  const [codecRev, setCodecRev] = useState(0);
  useEffect(() => {
    let alive = true;
    if (desktop) {
      void desktop.codecs().then((c) => { if (alive) { setCodecs(c); setFormats(Object.fromEntries(keys.map(([k]) => [k, desktopFormats(c)]))); } })
        .catch(() => { if (alive) { const none: DesktopCodecs = { h264: "none", webm: false, canEnableH264: false }; setCodecs(none); setFormats(Object.fromEntries(keys.map(([k]) => [k, desktopFormats(none)]))); } });
      return () => { alive = false; };
    }
    for (const [k, [w, h, f]] of keys) void probeOnce(w, h, f).then((r) => alive && setFormats((cur) => (cur[k] ? cur : { ...cur, [k]: r })));
    return () => { alive = false; };
  }, [keys, desktop, codecRev]);
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
  const edit = (patch: Partial<Choice>) => { setCustom({ ...withoutCap(choice), ...patch }); setPreset("custom"); }; // any manual change drops a platform's size cap
  const pickPreset = (id: PresetId) => { setPreset(id); setCustom(presetChoice(id, src)); };
  const shape = (c: Choice) => `${c.width}×${c.height}`;
  const letterbox = preset !== "custom" && needsBars(preset, src);

  const go = () => {
    if (!format) return;
    saveRemembered(preset === "custom" ? { preset, custom } : { preset });
    onStart(buildSettings(choice, src, format));
  };

  const fmtName = (o: ExportFormatOption) => t(formatLabelKey(o, Boolean(desktop)));
  const fps = src.fps % 1 === 0 ? String(src.fps) : src.fps.toFixed(2);

  if (!ready) return <p className="export-note" role="status">{t("export.checking")}</p>;
  const notice = desktop && codecs ? <H264Notice codecs={codecs} onEnabled={() => setCodecRev((n) => n + 1)} /> : null;
  if (offered.length === 0) return <>{notice}<p className="export-error" role="alert" data-testid="export-nodevice">{t(desktop ? "export.desktop.noneAtAll" : "export.err.noEncoder")}</p></>;
  return (
    <>
      {notice}
      <p className="export-summary" data-testid="export-summary">{t("export.summary", { size: `${src.width}×${src.height}`, fps, length: formatClock(src.seconds) })}</p>
      <fieldset className="export-presets">
        <legend>{t("export.presets")}</legend>
        {offered.map((id) => {
          const hint = presetHint(id, src, locale);
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
              {fmts?.options.map((o) => <option key={o.id} value={o.id}>{fmtName(o)}</option>)}
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
          {t("export.estimate", { size: formatBytes(estimateBytes(choice, src, format), locale), format: fmtName(format) })}
        </p>
      )}
      {format && choice.capBytes !== undefined && <p className="export-note" data-testid="export-cap-note">{t("export.cap.aims", { cap: formatBytes(choice.capBytes, locale) })}</p>}
      {format && presetWarnings(preset, choice, src, format, locale).map((w) => <p key={w.key} className="export-note" role="status" data-testid={w.key === "export.warn.cap" ? "export-cap-warning" : "export-duration-warning"}>{t(w.key, w.values)}</p>)}
      {format?.warnings.map((w) => <p key={w} className="export-note" data-testid="export-warning">{t("export.warn.limited")}</p>)}
      {format && formatNote(format, fmts?.options ?? []) && <p className="export-note" data-testid="export-format-note">{t(formatNote(format, fmts?.options ?? [])!)}</p>}
      <div className="export-footer">
        <button className="primary export-go" onClick={go} disabled={!format} data-testid="export-go"><Icon name="export" size={20} /><span>{t("export.go")}</span></button>
      </div>
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

/**
 * Desktop, no H.264 encoder: say so, and offer the opt-in download (issue #57). Nothing is fetched until the button is pressed; while it runs there is a
 * progress bar and a Cancel button; every failure says what happened and that WebM still works.
 */
function H264Notice({ codecs, onEnabled }: { codecs: DesktopCodecs; onEnabled(): void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<H264Progress | null>(null);
  const [failure, setFailure] = useState<H264FailureCode | null>(null);
  if (codecs.h264 !== "none") return null;
  const enable = async () => {
    setBusy(true);
    setFailure(null);
    setProgress(null);
    let last: H264Progress | null = null;
    try {
      await getDesktop()?.enableH264((p) => { last = p; setProgress(p); });
      onEnabled();
    } catch (e) {
      setFailure(parseH264Failure(e).code);
    } finally {
      // The native downloader is invisible to the browser, so it is listed in the Network activity log by hand (XT-06).
      recordNetworkEvent({ url: OPENH264_HOST_URL, bytes: (last as H264Progress | null)?.done ?? null, initiator: "user-download" });
      setBusy(false);
    }
  };
  const percent = progress ? h264Percent(progress) : null;
  return (
    <div className="export-note" data-testid="export-h264-notice">
      <p>{t("export.desktop.noH264")}</p>
      {canOfferH264Download(codecs) && (
        <>
          {!busy && <button className="export-secondary" onClick={() => void enable()} data-testid="export-enable-h264">{t("export.desktop.enable")}</button>}
          {busy && (
            <div className="diag-progress" data-testid="export-h264-progress">
              <progress max={100} value={percent ?? undefined} aria-label={t("export.desktop.enabling")} />
              <span>{percent === null ? t("export.desktop.enabling") : t("export.desktop.progress", { percent })}</span>
              <button className="export-secondary export-danger" onClick={() => void getDesktop()?.cancelH264()} data-testid="export-h264-cancel">{t("export.desktop.cancelDownload")}</button>
            </div>
          )}
          <p className="export-fine" data-testid="export-h264-licence">{t("export.desktop.licence")}</p>
        </>
      )}
      {failure && <p className="export-error" role="alert" data-testid="export-enable-failed">{t(`export.desktop.failed.${failure}`)}</p>}
    </div>
  );
}

// ---- 3. done ----
function Done({ state, src, locale, onClose, onAgain }: { state: Extract<ExportState, { phase: "done" }>; src: Source; locale: string; onClose(): void; onAgain(): void }) {
  const { t } = useI18n();
  const { result } = state;
  const file = useMemo(() => new File([state.file], saveName(result.fileName), { type: state.file.type }), [state.file, result.fileName]);
  const [note, setNote] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const share = useMemo(() => !getDesktop() && canShareFile(file), [file]);
  const kind = result.mime.startsWith("video/webm") ? "WebM" : "MP4";
  const desktop = getDesktop();
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const run = async (what: "save" | "share") => {
    setFailed(false);
    try {
      if (what === "save" && desktop) {
        // Native Save dialog; the finished file is copied straight to the chosen place (never through the webview).
        const path = await desktop.saveExport(result.fileName, file.name);
        if (path) { setSavedAt(path); setNote(t("export.savedTo", { path })); }
      } else if (what === "save") {
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
        {desktop && savedAt && <button className="export-secondary" onClick={() => void desktop.reveal(savedAt).catch(() => setFailed(true))} data-testid="export-reveal"><Icon name="media" size={20} /><span>{t("export.showFolder")}</span></button>}
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
  const detail = describeFailure(error);
  return (
    <>
      <p className="export-error" role="alert" data-testid="export-error">{t(errorKey(error))}</p>
      <details className="export-adv"><summary>{t("export.details")}</summary><p className="export-note" data-testid="export-error-detail" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", userSelect: "text" }}>{detail}</p></details>
      <div className="export-actions">
        <button className="primary export-go" onClick={onRetry} data-testid="export-retry"><span>{t("export.retry")}</span></button>
        <button className="export-secondary" onClick={onBack} data-testid="export-back">{t("export.back")}</button>
      </div>
    </>
  );
}
