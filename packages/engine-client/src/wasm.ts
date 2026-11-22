import { createEditing } from "./editing";
import { probeHost } from "./probe";
import { parseCapabilities, parseEngineInfo, type Engine } from "./types";

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
    info: async () => parseEngineInfo(wasm.engine_info()),
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
    }),
    capabilities: async () => parseCapabilities(wasm.capabilities(await probeHost())),
  };
}
