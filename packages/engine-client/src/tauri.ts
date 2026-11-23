import { invoke } from "@tauri-apps/api/core";
import { createEditing } from "./editing";
import { exportNotYet } from "./export/job";
import { toStorageError, type ProjectStorage } from "./persist/storage";
import { MediaDecodeError, parseEngineInfo, parseOpenedProject, toProjectFileError, type Engine } from "./types";

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
    export: exportNotYet,
    peaks: {
      // PCM crosses IPC as JSON number arrays for now; native hosts will decode and extract in Rust without crossing (follow-up).
      begin: async (sampleRate, channels, resume) => {
        const { id, next_frame } = JSON.parse(await invoke<string>("peaks_job_begin", { sampleRate, channels, resume: Array.from(resume ?? []) })) as { id: number; next_frame: number };
        return {
          nextFrame: next_frame,
          push: (pcm) => invoke<void>("peaks_job_push", { id, pcm: Array.from(pcm) }),
          snapshot: async () => Uint8Array.from(await invoke<number[]>("peaks_job_snapshot", { id })),
          finish: async () => Uint8Array.from(await invoke<number[]>("peaks_job_finish", { id })),
          dispose: () => invoke<void>("peaks_job_drop", { id }),
        };
      },
      open: async (file) => {
        const v = JSON.parse(await invoke<string>("peaks_view_open", { bytes: Array.from(file) })) as { id: number; sample_rate: number; frames: number; complete: boolean };
        return {
          sampleRate: v.sample_rate, frames: v.frames, complete: v.complete,
          columns: async (startFrame, framesPerPx, count) => Int16Array.from(await invoke<number[]>("peaks_view_columns", { id: v.id, startFrame, framesPerPx, count })),
          close: () => invoke<void>("peaks_view_close", { id: v.id }),
        };
      },
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
