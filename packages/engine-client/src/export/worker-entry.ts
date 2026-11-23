// The export Worker's entry point: `new Worker(new URL("./export/worker-entry.ts", import.meta.url), { type: "module" })` (spawned from `index.ts`, never from `wasm.ts`: this file imports `wasm.ts`, so the reverse would make the bundle contain itself).
import { openWasmEvaluator } from "../wasm";
import { serveExportWorker, type WorkerScope } from "./worker";

serveExportWorker(self as unknown as WorkerScope, openWasmEvaluator);
