import { createEditing } from "./editing";
import { createExportApi, type WorkerLike } from "./export/job";
import { opfsStorage } from "./export/storage";
import { createWebMedia, type WasmMediaClass } from "./decode/media";
import { parseEngineInfo, parseOpenedProject, toProjectFileError, type Engine, type FrameDescription, type MediaApi } from "./types";

/** Browser backend: loads the WebAssembly build once. Run the engine inside a Web Worker when it starts doing real work (see docs). */
export async function createWasmEngine(opts: { spawnExportWorker: () => WorkerLike }): Promise<Engine> {
  const wasm = await import("@app/wasm-pkg");
  await wasm.default();
  let editor: InstanceType<typeof wasm.Editor> | undefined;
  const open = () => {
    if (!editor) throw new Error("no project is open");
    return editor;
  };
  const editing = createEditing({
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
  });
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
    editing,
    export: createExportApi({
      spawn: opts.spawnExportWorker,
      project: () => editing.project(),
      storage: opfsStorage,
    }),
  };
}

/**
 * For the export Worker (`export/worker-entry.ts`): loads the engine inside the worker and opens the project snapshot. Lives here because this file is the
 * only one allowed to import the wasm package (`npm run check:boundaries`). Must not reference the worker URL (that would make the worker bundle itself).
 */
export async function openWasmEvaluator(projectJson: string): Promise<{ evaluate(sequence: string, ticks: number, samples: number): FrameDescription; media: MediaApi; free(): void }> {
  const wasm = await import("@app/wasm-pkg");
  await wasm.default();
  const editor = new wasm.Editor(projectJson);
  return {
    evaluate: (sequence, ticks, samples) => JSON.parse(editor.evaluate(sequence, BigInt(ticks), samples)) as FrameDescription,
    media: createWebMedia(wasm.MediaFile as unknown as WasmMediaClass),
    free: () => editor.free(),
  };
}
