import type { Engine } from "./types";

export * from "./types";
export * from "./export/types";
export { createExportApi, exportNotYet, type ExportHost, type WorkerLike } from "./export/job";
import type { WorkerLike } from "./export/job";
export { cleanupStaleExports, opfsStorage, type ExportStorage } from "./export/storage";
export { registerMediaResolver, type MediaResolver, type OpenedMedia, type MediaVideo, type MediaAudio, type DrawableFrame } from "./export/media";
export { createEditing, parseEditOutcome, type RawEditing } from "./editing";

/** True inside a Tauri shell (desktop or mobile app), false in a plain browser. */
export const isTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** One entry point for every platform: the native engine in an app shell, the WebAssembly engine everywhere else. */
export async function createEngine(): Promise<Engine> {
  if (isTauri()) return (await import("./tauri")).createTauriEngine();
  // A fresh module Worker per export job: it loads its own copy of the engine, opens the project snapshot and streams the file to OPFS.
  const spawnExportWorker = (): WorkerLike => new Worker(new URL("./export/worker-entry.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike;
  return (await import("./wasm")).createWasmEngine({ spawnExportWorker });
}
export * from "./model.generated";
export { codecName } from "./decode/errors";
export { FINGERPRINT_WINDOW, fingerprintFile, fingerprintSize, relinkMedia, type Candidate, type RelinkResult, type Sliceable } from "./media";
export { StorageError, toStorageError, type ProjectStorage, type StorageErrorCode } from "./persist/storage";
export { memoryStorage } from "./persist/memory";
export { openProjectSession, ProjectSession, type OpenedSession, type RecoveryNote, type SaveStatus, type SessionOptions } from "./persist/session";
export { acquireProjectLock, openProjectStorage } from "./persist/open";
export { newId, newProject, PROJECT_SCHEMA_VERSION } from "./project";
