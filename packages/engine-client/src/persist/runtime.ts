/** True inside a Tauri shell (same test as `isTauri` in index.ts, duplicated here to keep persist/ free of import cycles). */
export const isTauriRuntime = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
