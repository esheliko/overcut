/**
 * The app's Content-Security-Policy (XT-06). Injected as a <meta http-equiv> into the production index.html by `vite.config.ts`
 * (not in dev: the React refresh preamble is an inline script and HMR uses a WebSocket). A response header would be stronger
 * (it also covers the service worker script and frame-ancestors); that is a deploy-config change tracked as a process issue.
 * No inline scripts; no remote hosts anywhere; `'wasm-unsafe-eval'` is the only relaxation, for WebAssembly.
 * `ipc:` and `http://ipc.localhost` are Tauri's local IPC to the native shell, not the network.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self' ipc: http://ipc.localhost",
  "img-src 'self' blob: data:",
  "media-src 'self' blob: data:",
  "style-src 'self'",
  "font-src 'self' data:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");
