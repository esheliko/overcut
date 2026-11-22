import type { Engine } from "./types";

export * from "./types";

/** True inside a Tauri shell (desktop or mobile app), false in a plain browser. */
export const isTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** One entry point for every platform: the native engine in an app shell, the WebAssembly engine everywhere else. */
export async function createEngine(): Promise<Engine> {
  if (isTauri()) return (await import("./tauri")).createTauriEngine();
  return (await import("./wasm")).createWasmEngine();
}
