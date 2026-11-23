import type { Project } from "../model.generated";
import { planExport } from "./plan";
import type { ExportStorage } from "./storage";
import { ExportError, type ExportApi, type ExportJob, type ExportProgress, type ExportResult, type FromWorker, type ToWorker } from "./types";

/** The slice of `Worker` the host uses; `spawn` returns a real one in the browser and a loopback in tests. */
export interface WorkerLike {
  postMessage(m: ToWorker): void;
  terminate(): void;
  onmessage: ((e: { data: FromWorker }) => void) | null;
  onerror: ((e: { message?: string }) => void) | null;
}

export interface ExportHost {
  spawn(): WorkerLike;
  /** The project to export, snapshotted now. */
  project(): Promise<Project>;
  storage: ExportStorage;
  /** How long a cancelled worker gets to clean up before it is terminated (default 3 s). */
  cancelGraceMs?: number;
}

let counter = 0;
const newId = (): string => `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** `Engine.export` for a backend that runs the pipeline in a Worker (the browser). One Worker per job; it is terminated when the job ends. */
export function createExportApi(host: ExportHost): ExportApi {
  return {
    async start(settings) {
      const project = await host.project();
      planExport(project, settings); // fail fast, on this thread, before a worker exists
      const id = newId();
      const worker = host.spawn();
      const listeners = new Set<(p: ExportProgress) => void>();
      let cancelled = false;
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let resolve!: (r: ExportResult) => void;
      let reject!: (e: ExportError) => void;
      const result = new Promise<ExportResult>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      void result.catch(() => undefined); // a job nobody awaits must not raise an unhandled rejection
      const end = (): void => {
        settled = true;
        clearTimeout(killTimer);
        worker.terminate();
        listeners.clear();
      };

      worker.onmessage = ({ data }) => {
        if (data.jobId !== id || settled) return;
        if (data.type === "progress") for (const l of listeners) l(data.progress);
        else if (data.type === "done") {
          end();
          resolve({
            mime: data.mime,
            fileName: data.fileName,
            fileBytes: data.fileBytes,
            stats: data.stats,
            warnings: data.warnings,
            file: () => host.storage.open(data.path),
            remove: () => host.storage.remove(data.path),
          });
        } else {
          end();
          reject(new ExportError(data.code, data.message));
        }
      };
      worker.onerror = (e) => {
        if (settled) return;
        end();
        reject(new ExportError("encode_failed", `The export worker crashed${e.message ? `: ${e.message}` : ""}.`));
      };
      worker.postMessage({ type: "start", jobId: id, project, settings });

      const job: ExportJob = {
        id,
        result,
        onProgress(l) {
          listeners.add(l);
          return () => void listeners.delete(l);
        },
        cancel() {
          if (settled || cancelled) return;
          cancelled = true;
          worker.postMessage({ type: "cancel", jobId: id });
          // A worker that is stuck inside a long native call cannot answer: take it down and delete its file ourselves.
          killTimer = setTimeout(() => {
            if (settled) return;
            end();
            void host.storage.remove(`overcut-exports/${id}.mp4`).catch(() => undefined);
            void host.storage.remove(`overcut-exports/${id}.webm`).catch(() => undefined);
            reject(new ExportError("cancelled", "The export was cancelled."));
          }, host.cancelGraceMs ?? 3000);
        },
      };
      return job;
    },
  };
}

/** `Engine.export` where native encoding does not exist yet (Tauri until M1-015): starting always rejects with the typed `not_yet`. */
export const exportNotYet: ExportApi = {
  start: () => Promise.reject(new ExportError("not_yet", "Exporting in the desktop and mobile apps is not available yet. Use the web app, or wait for the native encoder.")),
};
