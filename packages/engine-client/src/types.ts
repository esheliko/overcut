/** What the engine says about itself. Mirrors `app_core::EngineInfo` (crates/core/src/lib.rs). */
export interface EngineInfo {
  name: string;
  version: string;
  /** Bumped when anything crossing the JS boundary changes incompatibly. */
  abi: number;
}

/** Which implementation answers: the WebAssembly build in a browser, or the native engine inside a Tauri shell. */
export type EngineBackend = "wasm" | "tauri";

/**
 * The ONLY way UI code talks to the engine. Add methods here, implement them in both backends (`wasm.ts`, `tauri.ts`),
 * and cover both with the same tests. UI code must never import wasm or Tauri modules itself (`npm run check:boundaries`).
 */
export interface Engine {
  readonly backend: EngineBackend;
  info(): Promise<EngineInfo>;
}

export const EXPECTED_ABI = 1;

export function parseEngineInfo(json: string): EngineInfo {
  const v: unknown = JSON.parse(json);
  if (!v || typeof v !== "object") throw new Error("engine info is not an object");
  const o = v as Record<string, unknown>;
  if (typeof o.name !== "string" || typeof o.version !== "string" || typeof o.abi !== "number") throw new Error("engine info has the wrong shape");
  if (o.abi !== EXPECTED_ABI) throw new Error(`engine ABI ${o.abi} does not match the UI (${EXPECTED_ABI}): rebuild the engine`);
  return { name: o.name, version: o.version, abi: o.abi };
}
