import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { CSP } from "./csp";

const wasmPkg = fileURLToPath(new URL("../../packages/engine-client/wasm-pkg/app_wasm.js", import.meta.url));

const wasmPkgGpu = fileURLToPath(new URL("../../packages/engine-client/wasm-pkg/gpu/app_wasm.js", import.meta.url));

// Cross-origin isolation (COOP/COEP) is required for SharedArrayBuffer and threaded WebAssembly; production sets the same headers in vercel.json.
const isolation = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };

// XT-06: the strict CSP goes into the production index.html only (dev needs inline refresh scripts and a WebSocket).
const csp: Plugin = { name: "overcut-csp", apply: "build", transformIndexHtml: () => [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: CSP }, injectTo: "head-prepend" }] };

export default defineConfig({
  plugins: [react(), csp],
  resolve: { alias: { "@app/wasm-pkg-gpu": wasmPkgGpu, "@app/wasm-pkg": wasmPkg } }, // the longer name first: Vite matches aliases by prefix
  server: { port: 5173, strictPort: true, headers: isolation },
  preview: { port: 4173, strictPort: true, headers: isolation },
  build: { target: "es2022", sourcemap: true },
});
