import { parseEngineInfo, type Engine } from "./types";

/** Browser backend: loads the WebAssembly build once. Run the engine inside a Web Worker when it starts doing real work (see docs). */
export async function createWasmEngine(): Promise<Engine> {
  const wasm = await import("@app/wasm-pkg");
  await wasm.default();
  return {
    backend: "wasm",
    info: async () => parseEngineInfo(wasm.engine_info()),
  };
}
