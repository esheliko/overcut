# Privacy: no network beyond our own assets (M1-042, XT-06)

**Behaviour.** OverCut loads only its own files from its own origin. Editing, playback, import and export never contact a server. After the first visit the installed app opens and edits with the network off.

**Allow-list.** `config/network-allowlist.json`: `sameOrigin: true`, `hosts: []`. Adding a host needs a reason in `docs/` (ADR or this file) in the same PR, and the feature using it must be optional with a local fallback (PRODUCT.md, ADR 0005).

**Test.** `tests/smoke/network.spec.ts` (desktop project, production build) records every request of the page, its Workers and the service worker through: load, import a fixture, edit (aspect ratio), play, export + save, `/diagnostics` (visited if it exists), then an offline reload with an import and an edit. It fails on any http(s)/ws(s) request to a host outside the allow-list and on any Content-Security-Policy violation. `data:` and `blob:` URLs never leave the device and are not counted.

**CSP.** `apps/web/csp.ts`, injected as `<meta http-equiv="Content-Security-Policy">` into the production `index.html` by the `overcut-csp` plugin in `vite.config.ts`: `default-src 'self'`; `script-src 'self' 'wasm-unsafe-eval'` (WebAssembly only; no inline scripts); `worker-src 'self' blob:`; `connect-src 'self'` plus Tauri's local `ipc:` / `http://ipc.localhost`; `img-src`/`media-src` with `blob: data:`; `style-src 'self'`; `object-src 'none'`; `base-uri 'none'`; `form-action 'none'`. Not applied in dev (inline React refresh script, HMR WebSocket).
- **Limit of the meta tag:** it cannot set `frame-ancestors`, and does not govern the service worker script itself. A real response header (`vercel.json`) is stronger: filed as a process request.

**Offline.** Measured: after the first visit the app reloads, imports and edits with the network off. Two causes had broken it, both fixed: (1) files loaded before the service worker took control (JS chunks, engine `.wasm`) were never cached, so `main.tsx` re-requests each same-origin file once the worker controls the page (from the HTTP cache, no new download); (2) the server sends `Vary: Origin`, so the cached copy did not match module-script requests, and `sw.js` now matches with `ignoreVary`. The spec asserts every loaded file is in the cache before going offline.

**Edge cases.** A future opt-in crash report or update check (XT-06) must be off by default, listed in the allow-list with its reason, and shown in a visible network log.
