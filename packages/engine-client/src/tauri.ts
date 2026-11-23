import { invoke } from "@tauri-apps/api/core";
import { createEditing } from "./editing";
import { probeHost } from "./probe";
import { toStorageError, type ProjectStorage } from "./persist/storage";
import { MediaDecodeError, parseCapabilities, parseEngineInfo, parseOpenedProject, toProjectFileError, type Engine } from "./types";

/** Native backend: the Rust engine runs in the Tauri shell process; commands are defined in apps/desktop/src-tauri/src/lib.rs. */
export function createTauriEngine(): Engine {
  return {
    backend: "tauri",
    media: {
      // Native decode (libav) is M1-015; until then a typed error the UI can show.
      open: () => Promise.reject(new MediaDecodeError("unsupported", "Opening media files in the desktop app is not available yet (native decoder, M1-015). Use the web app for now.")),
    },
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
    fingerprintMedia: async (size, first, last) => {
      try {
        return await invoke<string>("media_fingerprint", { size, first: Array.from(first), last: Array.from(last) });
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
      takeLog: () => invoke<string>("editor_take_log"),
      checkpoint: () => invoke<string>("editor_checkpoint"),
      recover: (baseJson, checkpointJson, log) => invoke<string>("editor_recover", { baseJson, checkpointJson, log }),
    }),
    capabilities: async () => parseCapabilities(await invoke<string>("capabilities", { probeJson: await probeHost() })),
  };
}

/** The project folder inside the app's data directory, through the `store_*` Tauri commands (`crates/store`: real rename, fsync on append). */
export function createTauriStorage(project: string): ProjectStorage {
  const run = async <T>(cmd: string, args: Record<string, unknown>): Promise<T> => {
    try {
      return await invoke<T>(cmd, { project, ...args });
    } catch (e) {
      throw toStorageError(e);
    }
  };
  return {
    kind: "folder",
    read: async (name) => {
      const b = await run<number[] | null>("store_read", { name });
      return b ? Uint8Array.from(b) : null;
    },
    writeAtomic: (name, bytes) => run("store_write_atomic", { name, bytes: Array.from(bytes) }),
    append: (name, bytes) => run("store_append", { name, bytes: Array.from(bytes) }),
    truncate: (name, size) => run("store_truncate", { name, size }),
    remove: (name) => run("store_remove", { name }),
  };
}
