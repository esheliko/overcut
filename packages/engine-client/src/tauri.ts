import { invoke } from "@tauri-apps/api/core";
import { createEditing } from "./editing";
import { probeHost } from "./probe";
import { parseCapabilities, parseEngineInfo, type Engine } from "./types";

/** Native backend: the Rust engine runs in the Tauri shell process; commands are defined in apps/desktop/src-tauri/src/lib.rs. */
export function createTauriEngine(): Engine {
  return {
    backend: "tauri",
    info: async () => parseEngineInfo(await invoke<string>("engine_info")),
    editing: createEditing({
      open: (projectJson) => invoke<void>("editor_open", { projectJson }),
      apply: (opsJson, coalesce) => invoke<string>("editor_apply", { opJson: opsJson, coalesce: coalesce ?? null }),
      undo: () => invoke<string>("editor_undo"),
      redo: () => invoke<string>("editor_redo"),
      project: () => invoke<string>("editor_project"),
      journal: () => invoke<string>("editor_journal"),
    }),
    capabilities: async () => parseCapabilities(await invoke<string>("capabilities", { probeJson: await probeHost() })),
  };
}
