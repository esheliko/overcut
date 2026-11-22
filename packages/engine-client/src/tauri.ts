import { invoke } from "@tauri-apps/api/core";
import { createEditing } from "./editing";
import { probeHost } from "./probe";
import { parseCapabilities, parseEngineInfo, parseOpenedProject, toProjectFileError, type Engine } from "./types";

/** Native backend: the Rust engine runs in the Tauri shell process; commands are defined in apps/desktop/src-tauri/src/lib.rs. */
export function createTauriEngine(): Engine {
  return {
    backend: "tauri",
    info: async () => parseEngineInfo(await invoke<string>("engine_info")),
    openProject: async (bytes) => {
      try {
        return parseOpenedProject(await invoke<string>("project_open", { bytes: Array.from(bytes) }));
      } catch (e) {
        throw toProjectFileError(e);
      }
    },
    saveProject: async (project, previous) => {
      try {
        const out = await invoke<number[]>("project_save", { projectJson: JSON.stringify(project), previous: Array.from(previous ?? []) });
        return Uint8Array.from(out);
      } catch (e) {
        throw toProjectFileError(e);
      }
    },
    editing: createEditing({
      open: (projectJson) => invoke<void>("editor_open", { projectJson }),
      apply: (opsJson, coalesce) => invoke<string>("editor_apply", { opJson: opsJson, coalesce: coalesce ?? null }),
      undo: () => invoke<string>("editor_undo"),
      redo: () => invoke<string>("editor_redo"),
      project: () => invoke<string>("editor_project"),
      journal: () => invoke<string>("editor_journal"),
      // Tauri serializes JSON numbers: ticks are safe integers (checked in createEditing), so Number is exact.
      evaluate: (sequence, ticks, audioSamples) => invoke<string>("editor_evaluate", { sequence, ticks: Number(ticks), audioSamples }),
    }),
    capabilities: async () => parseCapabilities(await invoke<string>("capabilities", { probeJson: await probeHost() })),
  };
}
