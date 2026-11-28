/** Export (M1-035): the top-bar button and the progress chip; the dialog (full-screen sheet on a phone, modal on a desktop) loads on first use (ExportDialogView.tsx). Logic lives in model.ts, useExport.ts, deliver.ts. */
import { ExportError, type Engine } from "@app/engine-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { announce } from "../a11y/announcer";
import { EXPORT_EVENT } from "../commands/palette";
import { withKey } from "../commands/keymap";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { TICKS } from "../media/plan";
import { sequenceView } from "../PreviewPanel";
import { useProjectStore, useStore } from "../store/projectStore";
import type { Source } from "./model";
import { useExport, type ExportState } from "./useExport";

const importView = () => import("./ExportDialogView");
type View = Awaited<ReturnType<typeof importView>>;
/** The dialog module once it has loaded. Kept here, not behind React.lazy: a lazy component suspends for a tick even when its chunk is already in, and React holds a suspended reveal back for 300 ms (the "export opens late" of UX r11). */
let loadedView: View | null = null;
const loadView = (): Promise<View> => importView().then((m) => (loadedView = m));
const warmed = new Set<string>();

export function ExportControl({ engine, fileOf, projectName }: { engine: Engine | null; fileOf(id: string): Promise<File | null>; projectName?: string | null }) {
  const { t, locale } = useI18n();
  const store = useStore();
  const project = useProjectStore((s) => s.project);
  const view = sequenceView(project);
  const src: Source | null = useMemo(
    () => (view.has ? { width: view.size.width, height: view.size.height, fps: view.rate.num / view.rate.den, seconds: view.endTicks / TICKS, ...(projectName ? { name: projectName } : null) } : null),
    [projectName, view.has, view.size.width, view.size.height, view.rate.num, view.rate.den, view.endTicks],
  );
  const [open, setOpen] = useState(false);
  const [, loaded] = useState(0);
  // Opened before the chunk was here (a cold first click): fetch it, then draw the dialog.
  useEffect(() => { if (open && !loadedView) void loadView().then(() => loaded((n) => n + 1)); }, [open]);
  /** Loads the dialog chunk and asks the browser which formats it can encode (once per size and rate), so the dialog opens ready. */
  const warm = useCallback(() => {
    if (!src) return;
    const key = `${src.width}x${src.height}@${src.fps}`;
    if (warmed.has(key)) return;
    warmed.add(key);
    void loadView().then((m) => m.prefetchExportProbe(src)).catch(() => warmed.delete(key));
  }, [src]);
  // The dialog's code is fetched once the engine is up and the browser is idle (before any clip exists), so the first Export click has nothing left to download.
  useEffect(() => {
    if (!engine) return;
    const w = window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (h: number) => void };
    const go = () => void loadView().catch(() => undefined);
    if (w.requestIdleCallback) { const h = w.requestIdleCallback(go, { timeout: 3000 }); return () => w.cancelIdleCallback?.(h); }
    const h = window.setTimeout(go, 2000);
    return () => window.clearTimeout(h);
  }, [engine]);
  // Idle after the first clip lands: by the time the button is pressed the chunk and the answers are already here.
  useEffect(() => {
    if (!src || !engine) return;
    const w = window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (h: number) => void };
    if (w.requestIdleCallback) { const h = w.requestIdleCallback(warm, { timeout: 800 }); return () => w.cancelIdleCallback?.(h); }
    const h = window.setTimeout(warm, 600);
    return () => window.clearTimeout(h);
  }, [src, engine, warm]);
  const openRef = useRef(false);
  openRef.current = open;
  // The `app.export` command (Ctrl/Cmd+E, the palette): the same as pressing the button; with nothing to export it says so.
  useEffect(() => {
    const on = () => { if (!engine || !src) announce(t("export.needClip")); else setOpen(true); };
    window.addEventListener(EXPORT_EVENT, on);
    return () => window.removeEventListener(EXPORT_EVENT, on);
  }, [engine, src, t]);

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
        <button className="primary" data-testid="export-open" onPointerEnter={warm} onFocus={warm} onTouchStart={warm} disabled={!engine || !src} title={!src ? t("export.needClip") : withKey(t("export.go"), "app.export")} onClick={() => setOpen(true)}>
          <Icon name="export" size={18} /><span>{t("export.label")}</span>
        </button>
      )}
      {open && src && project && loadedView && (
        <loadedView.Dialog
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
