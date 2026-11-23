/** Export (M1-035): the top-bar button and the progress chip; the dialog (full-screen sheet on a phone, modal on a desktop) loads on first use (ExportDialogView.tsx). Logic lives in model.ts, useExport.ts, deliver.ts. */
import { ExportError, type Engine } from "@app/engine-client";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { announce } from "../a11y/announcer";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { TICKS } from "../media/plan";
import { sequenceView } from "../PreviewPanel";
import { useProjectStore, useStore } from "../store/projectStore";
import type { Source } from "./model";
import { useExport, type ExportState } from "./useExport";

const loadView = () => import("./ExportDialogView");
const Dialog = lazy(() => loadView().then((m) => ({ default: m.Dialog })));

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
        <button className="primary" data-testid="export-open" onPointerEnter={() => void loadView()} onFocus={() => void loadView()} disabled={!engine || !src} title={!src ? t("export.needClip") : undefined} onClick={() => setOpen(true)}>
          <Icon name="export" size={18} /><span>{t("export.label")}</span>
        </button>
      )}
      {open && src && project && (
        <Suspense fallback={<div className="export-loading" role="status">{t("export.loading")}</div>}>
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
        </Suspense>
      )}
    </>
  );
}
