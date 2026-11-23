import { type Engine, type ExportJob, type ExportProgress, type ExportResult, type ExportSettings } from "@app/engine-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { isCancel } from "./model";

export type ExportState =
  | { phase: "idle" }
  | { phase: "running"; progress: ExportProgress | null }
  | { phase: "done"; result: ExportResult; file: File }
  | { phase: "failed"; error: unknown };

/** Runs one export at a time and keeps its state. The finished file lives in OPFS until `reset` or the next start (then it is removed). */
export function useExport(engine: Engine | null, sources: (sequence: string) => Promise<Record<string, Blob>>, onPhase?: (s: ExportState) => void) {
  const [state, setState] = useState<ExportState>({ phase: "idle" });
  const job = useRef<ExportJob | null>(null);
  const kept = useRef<ExportResult | null>(null);
  const busy = useRef(false);
  const alive = useRef(true);
  const cb = useRef(onPhase);
  cb.current = onPhase;

  const set = useCallback((s: ExportState) => {
    if (!alive.current) return;
    setState(s);
    cb.current?.(s);
  }, []);

  const discard = useCallback(() => {
    const k = kept.current;
    kept.current = null;
    void k?.remove().catch(() => undefined);
  }, []);

  const start = useCallback(async (sequence: string, settings: Omit<ExportSettings, "sequence" | "sources">) => {
    if (!engine || busy.current) return;
    busy.current = true;
    discard();
    set({ phase: "running", progress: null });
    try {
      const src = await sources(sequence);
      const j = await engine.export.start({ ...settings, sequence, sources: src });
      job.current = j;
      j.onProgress((progress) => alive.current && setState({ phase: "running", progress }));
      const result = await j.result;
      kept.current = result;
      // The desktop's file stays on disk until the person saves it (native Save dialog copies it): do not read gigabytes into the webview.
      const file = engine.desktop ? new File([], result.fileName, { type: result.mime }) : await result.file();
      set({ phase: "done", result, file });
    } catch (e) {
      // A cancel puts the dialog back on the settings, nothing to report.
      set(isCancel(e) ? { phase: "idle" } : { phase: "failed", error: e });
    } finally {
      job.current = null;
      busy.current = false;
    }
  }, [engine, sources, discard, set]);

  const cancel = useCallback(() => job.current?.cancel(), []);
  const reset = useCallback(() => { discard(); set({ phase: "idle" }); }, [discard, set]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; job.current?.cancel(); discard(); };
  }, [discard]);

  return { state, start, cancel, reset };
}
