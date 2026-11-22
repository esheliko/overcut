import { invoke } from "@tauri-apps/api/core";
import { parseEngineInfo, type Engine } from "./types";

/** Native backend: the Rust engine runs in the Tauri shell process; commands are defined in apps/desktop/src-tauri/src/lib.rs. */
export function createTauriEngine(): Engine {
  return {
    backend: "tauri",
    info: async () => parseEngineInfo(await invoke<string>("engine_info")),
  };
}
