import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { buildCrashReport, currentSaveStatus, noteProblem, workState, type CrashInfo } from "./crash";

/** The calm screen shown when the app cannot continue. No stack trace here: it goes into the copied report. */
export function ErrorScreen({ crash }: { crash: CrashInfo }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState<"" | "ok" | "manual">("");
  const area = useRef<HTMLTextAreaElement>(null);
  const work = workState(currentSaveStatus());
  const report = buildCrashReport(crash);
  const copy = async () => {
    try { await navigator.clipboard.writeText(report); setCopied("ok"); } catch { setCopied("manual"); }
  };
  useEffect(() => { if (copied === "manual") { area.current?.focus(); area.current?.select(); } }, [copied]);
  return (
    <main className="crash" data-testid="error-screen" role="alert">
      <h1>{t("crash.title")}</h1>
      <p>{t("crash.body")}</p>
      <p className={`crash-work ${work}`} data-testid="crash-work" data-state={work}>{t(`crash.work.${work}`)}</p>
      <div className="crash-actions">
        <button className="primary" data-testid="crash-reload" onClick={() => location.reload()}>{t("crash.reload")}</button>
        <button data-testid="crash-copy" onClick={() => void copy()}>{t("crash.copy")}</button>
      </div>
      <p className="crash-muted" role="status" data-testid="crash-copied">{copied === "ok" ? t("crash.copied") : copied === "manual" ? t("crash.copyManual") : ""}</p>
      <p className="crash-muted">{t("crash.privacy")}</p>
      {copied === "manual" && <textarea ref={area} className="crash-report" readOnly value={report} aria-label={t("crash.report")} />}
    </main>
  );
}

type Fatal = CrashInfo | null;
const BENIGN = /ResizeObserver loop/i;

/**
 * The top-level boundary: a render error, an uncaught exception, or `reportFatal` (engine or worker failure) swaps the app for `ErrorScreen`.
 * An unhandled promise rejection is recorded for the report but does not stop the app (a failed import is not a crash).
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { fatal: Fatal }> {
  override state: { fatal: Fatal } = { fatal: null };
  static getDerivedStateFromError(error: unknown): { fatal: Fatal } { return { fatal: { source: "render", error } }; }
  override componentDidMount(): void {
    addEventListener("error", this.onError);
    addEventListener("unhandledrejection", this.onRejection);
    fatalListener = (crash) => this.setState((s) => (s.fatal ? s : { fatal: crash }));
  }
  override componentWillUnmount(): void {
    removeEventListener("error", this.onError);
    removeEventListener("unhandledrejection", this.onRejection);
    fatalListener = null;
  }
  private onError = (ev: ErrorEvent) => {
    if (BENIGN.test(ev.message)) return;
    this.setState((s) => (s.fatal ? s : { fatal: { source: "uncaught", error: ev.error ?? ev.message } }));
  };
  private onRejection = (ev: PromiseRejectionEvent) => noteProblem("unhandled-rejection", ev.reason);
  override render(): ReactNode { return this.state.fatal ? <ErrorScreen crash={this.state.fatal} /> : this.props.children; }
}

let fatalListener: ((c: CrashInfo) => void) | null = null;
/** For failures that are not thrown through React: the engine could not start, a Worker died. Shows the error screen. */
export function reportFatal(source: string, error: unknown): void { fatalListener?.({ source, error }); }

/** Test-only (`?e2e&force-error=<ms>`): throws while rendering after a delay, so smoke tests and screenshots can see the screen with the app running. */
export function ForcedError({ delay }: { delay: number }): null {
  const [boom, setBoom] = useState(false);
  useEffect(() => { const id = setTimeout(() => setBoom(true), delay); return () => clearTimeout(id); }, [delay]);
  if (boom) throw new Error("Forced test error (force-error)");
  return null;
}
