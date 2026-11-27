import type { Project } from "../model.generated";
import { planExport } from "./plan";
import type { ExportStorage } from "./storage";
import { ExportError, type ExportFailureDetail, type ExportApi, type ExportJob, type ExportProgress, type ExportResult, type FromWorker, type ToWorker } from "./types";

/** The slice of `Worker` the host uses; `spawn` returns a real one in the browser and a loopback in tests. */
export interface WorkerLike {
  postMessage(m: ToWorker): void;
  terminate(): void;
  onmessage: ((e: { data: FromWorker }) => void) | null;
  onerror: ((e: { message?: string; filename?: string; lineno?: number; colno?: number; error?: unknown }) => void) | null;
}

export interface ExportHost {
  spawn(): WorkerLike;
  /** The project to export, snapshotted now. */
  project(): Promise<Project>;
  storage: ExportStorage;
  /** How long a cancelled worker gets to clean up before it is terminated (default 3 s). */
  cancelGraceMs?: number;
  /** A worker that says nothing at all for this long is taken down and counts as a failed attempt (default 120 s; progress arrives every 200 ms). */
  stallMs?: number;
  /** How long to wait after a worker's `error` event for the worker's own, more detailed, report (default 150 ms). */
  crashGraceMs?: number;
}

/** Highest `ExportSettings.safeLevel` the host tries after failures (see `presets.ts`). */
export const MAX_SAFE_LEVEL = 3;

let counter = 0;
const newId = (): string => `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Failures a more conservative encoder setup can fix. Everything else (cancelled, bad settings, unreadable media, storage, no GPU) would fail the same way again. */
const retryable = (e: ExportError): boolean => e.code === "encode_failed";

/**
 * `Engine.export` for a backend that runs the pipeline in a Worker (the browser). One Worker per attempt; it is terminated when the attempt ends.
 * When an attempt dies (the worker crashes, hangs, or an encoder fails) the host starts over in a fresh worker with the next, more conservative
 * `safeLevel` (up to `MAX_SAFE_LEVEL`), so a device whose hardware encoder rejects the preferred config still exports. The last failure is
 * reported with every attempt's stage, error and encoder config in `ExportError.detail`.
 */
export function createExportApi(host: ExportHost): ExportApi {
  return {
    async start(settings) {
      const project = await host.project();
      planExport(project, settings); // fail fast, on this thread, before a worker exists
      const id = newId();
      const listeners = new Set<(p: ExportProgress) => void>();
      let cancelled = false;
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let worker: WorkerLike | undefined;
      let currentJobId = id;
      const removePartial = (jobId: string): void => {
        for (const ext of ["mp4", "webm"]) void host.storage.remove(`overcut-exports/${jobId}.${ext}`).catch(() => undefined);
      };
      let resolve!: (r: ExportResult) => void;
      let reject!: (e: ExportError) => void;
      const result = new Promise<ExportResult>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      void result.catch(() => undefined); // a job nobody awaits must not raise an unhandled rejection
      let stopAttempt: () => void = () => undefined;
      const end = (): void => {
        settled = true;
        stopAttempt();
        clearTimeout(killTimer);
        worker?.terminate();
        listeners.clear();
      };
      const attempts: ExportFailureDetail[] = [];

      const attempt = (level: 0 | 1 | 2 | 3): void => {
        const w = host.spawn();
        worker = w;
        const jobId = `${id}${level ? `-l${level}` : ""}`;
        currentJobId = jobId;
        let stage = "starting";
        let video: string | undefined;
        let audio: string | undefined;
        let frames = 0;
        let over = false; // this attempt has ended (answered, failed or replaced)
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        let crashTimer: ReturnType<typeof setTimeout> | undefined;
        const arm = (): void => {
          clearTimeout(watchdog);
          watchdog = setTimeout(() => fail(new ExportError("encode_failed", `The export stopped responding at "${stage}".`)), host.stallMs ?? 120_000);
        };
        const finishAttempt = (): void => {
          over = true;
          clearTimeout(watchdog);
          clearTimeout(crashTimer);
          w.terminate();
        };
        const fail = (e: ExportError, raw?: { filename?: string; lineno?: number; colno?: number }): void => {
          if (over || settled) return;
          finishAttempt();
          removePartial(jobId); // a terminated worker could not delete its own partial file
          const detail: ExportFailureDetail = { stage, frames, level, video, audio, ...raw, ...e.detail, message: e.detail?.message ?? e.message };
          detail.stage = e.detail?.stage ?? stage;
          if (retryable(e) && !cancelled && level < MAX_SAFE_LEVEL) {
            attempts.push(detail);
            attempt((level + 1) as 1 | 2 | 3);
            return;
          }
          end();
          reject(new ExportError(e.code, e.message, { ...detail, attempts: attempts.length ? [...attempts] : undefined }));
        };

        w.onmessage = ({ data }) => {
          if (over || settled || !data.jobId.startsWith(id)) return;
          arm();
          if (data.type === "stage") {
            stage = data.stage;
            video = data.video ?? video;
            audio = data.audio ?? audio;
          } else if (data.type === "progress") {
            frames = data.progress.framesDone;
            for (const l of listeners) l(data.progress);
          } else if (data.type === "done") {
            finishAttempt();
            end();
            resolve({
              mime: data.mime,
              fileName: data.fileName,
              fileBytes: data.fileBytes,
              stats: { ...data.stats, safeLevel: level, failedAttempts: attempts.length ? [...attempts] : undefined },
              warnings: level > 0 ? [...data.warnings, "This device's video encoder rejected the best settings, so the file uses compatibility settings (a little larger or slower)."] : data.warnings,
              file: () => host.storage.open(data.path),
              remove: () => host.storage.remove(data.path),
            });
          } else if (data.type === "error") {
            fail(new ExportError(data.code, data.message, data.detail));
          }
        };
        w.onerror = (e) => {
          if (over || settled) return;
          // The worker reports its own uncaught errors with a stage and a stack just before this event: give that message a moment to arrive.
          clearTimeout(crashTimer);
          crashTimer = setTimeout(() => {
            const msg = e.message || (e.error instanceof Error ? e.error.message : "");
            fail(new ExportError("encode_failed", `The export worker crashed at "${stage}"${msg ? `: ${msg}` : ""}.`, { name: e.error instanceof Error ? e.error.name : undefined, message: msg || "(the browser gave no message)", stack: e.error instanceof Error ? e.error.stack?.slice(0, 1500) : undefined }), { filename: e.filename, lineno: e.lineno, colno: e.colno });
          }, host.crashGraceMs ?? 150);
        };
        stopAttempt = finishAttempt;
        arm();
        w.postMessage({ type: "start", jobId, project, settings: level ? { ...settings, safeLevel: level } : settings });
      };
      attempt(settings.safeLevel ?? 0);

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
          worker?.postMessage({ type: "cancel", jobId: currentJobId });
          // A worker that is stuck inside a long native call cannot answer: take it down and delete its file ourselves.
          killTimer = setTimeout(() => {
            if (settled) return;
            end();
            removePartial(currentJobId);
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
