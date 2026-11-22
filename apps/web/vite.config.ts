import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const wasmPkg = fileURLToPath(new URL("../../packages/engine-client/wasm-pkg/app_wasm.js", import.meta.url));

// Cross-origin isolation (COOP/COEP) is required for SharedArrayBuffer and threaded WebAssembly; production sets the same headers in vercel.json.
const isolation = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@app/wasm-pkg": wasmPkg } },
  server: { port: 5173, strictPort: true, headers: isolation },
  preview: { port: 4173, strictPort: true, headers: isolation },
  build: { target: "es2022", sourcemap: true },
});
