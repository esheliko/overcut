import type { FrameDescription, MediaApi } from "../types";
import { runExport } from "./pipeline";
import { opfsStorage, type ExportStorage } from "./storage";
import { ExportError, type FromWorker, type ToWorker } from "./types";
import { createWebEnv } from "./web-env";

/** The slice of a worker global this file uses (so tests can pass a fake). */
export interface WorkerScope {
  postMessage(m: FromWorker): void;
  addEventListener(type: "message", l: (e: { data: ToWorker }) => void): void;
}

/** Loads the engine inside the worker and opens the snapshotted project (the wasm backend's `openWasmEvaluator`; tests pass a fake). */
export type OpenEvaluator = (projectJson: string) => Promise<{ evaluate(sequence: string, ticks: number, samples: number): FrameDescription; media: MediaApi; free(): void }>;

export function serveExportWorker(scope: WorkerScope, openEvaluator: OpenEvaluator, storage: ExportStorage = opfsStorage): void {
  const jobs = new Map<string, AbortController>();
  scope.addEventListener("message", ({ data }) => {
    if (data.type === "cancel") jobs.get(data.jobId)?.abort();
    else if (data.type === "start") void runJob(data);
  });

  async function runJob(msg: Extract<ToWorker, { type: "start" }>): Promise<void> {
    const { jobId } = msg;
    const ctl = new AbortController();
    jobs.set(jobId, ctl);
    let engine: Awaited<ReturnType<OpenEvaluator>> | undefined;
    let web: Awaited<ReturnType<typeof createWebEnv>> | undefined;
    try {
      engine = await openEvaluator(JSON.stringify(msg.project));
      web = await createWebEnv({ jobId, project: msg.project, settings: msg.settings, signal: ctl.signal, storage, evaluate: engine.evaluate, media: engine.media });
      const r = await runExport(web.env, ctl.signal, (progress) => scope.postMessage({ type: "progress", jobId, progress }));
      const seconds = (web.plan.totalFrames * web.plan.fpsDen) / web.plan.fpsNum;
      scope.postMessage({
        type: "done",
        jobId,
        mime: web.mime(),
        path: web.path,
        fileName: web.fileName,
        fileBytes: r.fileBytes,
        warnings: web.preset.warnings,
        stats: {
          frames: r.frames,
          durationSeconds: seconds,
          fileBytes: r.fileBytes,
          encodeMs: r.encodeMs,
          speedVsRealtime: seconds / (r.encodeMs / 1000),
          peakEncodeQueue: r.peakEncodeQueue,
          codecs: `${web.preset.video.codec} + ${web.preset.audio.codec}`,
        },
      });
    } catch (e) {
      const err = e instanceof ExportError ? e : new ExportError("encode_failed", e instanceof Error ? e.message : String(e));
      scope.postMessage({ type: "error", jobId, code: err.code, message: err.message });
    } finally {
      web?.dispose();
      engine?.free();
      jobs.delete(jobId);
    }
  }
}
