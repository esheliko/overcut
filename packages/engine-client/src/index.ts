import type { Engine } from "./types";

export * from "./types";
export { createEditing, parseEditOutcome, type RawEditing } from "./editing";

/** True inside a Tauri shell (desktop or mobile app), false in a plain browser. */
export const isTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** One entry point for every platform: the native engine in an app shell, the WebAssembly engine everywhere else. */
export async function createEngine(): Promise<Engine> {
  if (isTauri()) return (await import("./tauri")).createTauriEngine();
  return (await import("./wasm")).createWasmEngine();
}
export * from "./model.generated";
export { codecName } from "./decode/errors";
export { FINGERPRINT_WINDOW, fingerprintFile, fingerprintSize, relinkMedia, type Candidate, type RelinkResult, type Sliceable } from "./media";
export { StorageError, toStorageError, type ProjectStorage, type StorageErrorCode } from "./persist/storage";
export { memoryStorage } from "./persist/memory";
export { openProjectSession, ProjectSession, type OpenedSession, type RecoveryNote, type SaveStatus, type SessionOptions } from "./persist/session";
export { acquireProjectLock, openProjectStorage } from "./persist/open";
export { newId, newProject, PROJECT_SCHEMA_VERSION } from "./project";
