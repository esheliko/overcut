# Device check (`/diagnostics`)

**Purpose**: let the owner (and later users) see what a device supports and measure it, then paste a compact report back. Reachable from the top-bar "..." menu, "About / Diagnostics". No network requests beyond the app's own assets; nothing uploaded.

**Capabilities (M1-006)**: the host probes its APIs (`packages/engine-client/src/probe.ts`: WebCodecs `isConfigSupported` per codec for decode and encode with hardware preference, WebGPU adapter and limits, WebGL2, SharedArrayBuffer and cross-origin isolation, OPFS, cores, memory) and passes raw JSON to the engine (`app_core::capabilities_json`, wasm `capabilities`, Tauri command `capabilities`). The engine normalises (missing or mistyped sections become unknown, never an error), stamps the host, lets the native shell override OS/arch/cores, and writes plain-language `issues`.

**Speed test** (`apps/web/src/diagnostics/bench.worker.ts`, runs in a Worker, about 30 to 60 s): (1) sequential 1080p H.264 decode fps; (2) random-seek latency p50/p95 on a GOP-30 and a GOP-150 clip (S1 method); (3) VideoFrame to GPU texture: direct import vs copy vs CPU upload; (4) WebGPU fill rate, 8 full-HD blended layers. Test clips are the S1 spike clips shipped in `apps/web/public/diagnostics/` (about 850 KB). Each test fails soft ("not supported", error, or timeout after 40 s with the worker restarted).

**Report**: one compact JSON line (`overcut_device_report: 1`), copied to the clipboard, also shown in a text box for manual copy. Verdict thresholds in `report.ts` are a rough guide only.

**Tests**: Rust unit tests in `capabilities.rs`; `tests/unit/engine-client.test.ts`, `tests/unit/diagnostics-report.test.ts`; smoke step "device check".
