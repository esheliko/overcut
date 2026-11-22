import { createEditing } from "./editing";
import { createWebMedia, type WasmMediaClass } from "./decode/media";
import { parseEngineInfo, parseOpenedProject, toProjectFileError, type Engine } from "./types";

/** Browser backend: loads the WebAssembly build once. Run the engine inside a Web Worker when it starts doing real work (see docs). */
export async function createWasmEngine(): Promise<Engine> {
  const wasm = await import("@app/wasm-pkg");
  await wasm.default();
  let editor: InstanceType<typeof wasm.Editor> | undefined;
  const open = () => {
    if (!editor) throw new Error("no project is open");
    return editor;
  };
  return {
    backend: "wasm",
    media: createWebMedia(wasm.MediaFile as unknown as WasmMediaClass),
    info: async () => parseEngineInfo(wasm.engine_info()),
    openProject: async (bytes) => {
      try {
        return parseOpenedProject(wasm.project_open(bytes));
      } catch (e) {
        throw toProjectFileError(e);
      }
    },
    saveProject: async (project, previous) => {
      try {
        return wasm.project_save(JSON.stringify(project), previous ?? new Uint8Array());
      } catch (e) {
        throw toProjectFileError(e);
      }
    },
    fingerprintMedia: async (size, first, last) => {
      try {
        return wasm.media_fingerprint(size, first, last);
      } catch (e) {
        throw toProjectFileError(e);
      }
    },
    editing: createEditing({
      open: (projectJson) => {
        const next = new wasm.Editor(projectJson); // throws on an invalid project, keeping the old one
        editor?.free();
        editor = next;
      },
      apply: (opsJson, coalesce) => open().apply(opsJson, coalesce),
      undo: () => open().undo(),
      redo: () => open().redo(),
      project: () => open().project(),
      journal: () => open().journal(),
      evaluate: (sequence, ticks, audioSamples) => open().evaluate(sequence, ticks, audioSamples),
      takeLog: () => open().take_log(),
      checkpoint: () => open().checkpoint(),
      recover: (baseJson, checkpointJson, log) => {
        const next = wasm.Editor.recover(baseJson ?? undefined, checkpointJson ?? undefined, log); // throws, keeping the old editor
        editor?.free();
        editor = next;
        return next.recovery() ?? "{}";
      },
    }),
  };
}
