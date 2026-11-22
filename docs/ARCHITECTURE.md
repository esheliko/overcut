# Architecture

One engine, many shells. All editing logic, media handling, rendering and AI live in a **Rust engine**; the **UI** is one TypeScript/React app; thin **shells** (browser, Tauri desktop, Tauri mobile) host the UI and give the engine access to platform capabilities (codecs, files, GPU, camera). Decisions behind this are in [adr/](adr/).

```
┌──────────────────────────────── UI (apps/web: React 19, Vite) ────────────────────────────────┐
│  panels: media bin · preview · timeline · inspector · export · settings   (responsive layouts)  │
│  state: project view-model (read) ── commands (write) ──►  @app/engine-client (typed Engine)    │
└───────────────────────────────────────────────┬─────────────────────────────────────────────────┘
                                                │ ops (JSON), frames/buffers (typed arrays, SharedArrayBuffer, GPU textures)
        ┌───────────────────────────────────────┴──────────────────────────────┐
        │ Browser / PWA                         │ Tauri shell (desktop, mobile)  │
        │  engine = WASM in a Web Worker        │  engine = native Rust, in-proc │
        │  media = WebCodecs                    │  media = FFmpeg(LGPL)/OS codecs│
        │  gpu = WebGPU (WebGL2 fallback)       │  gpu = wgpu (Vulkan/Metal/DX12)│
        │  files = OPFS + File System Access    │  files = filesystem            │
        └───────────────────────────────────────┴──────────────────────────────┘
                                   Rust engine (crates/)
   core ─► model ─► timeline ─┐
             │  ├─► media ────┼─► render ─► export
             │  ├─► audio ────┤
             │  └─► fx ───────┘
             └────► ai (beside fx)           wasm = bindings only
```

## Layers and ownership

| Layer | Path | Owns | Must not |
|---|---|---|---|
| UI | `apps/web`, `packages/ui` (later) | layouts, interaction, accessibility, i18n strings, view-model caching | decode media, mutate project state directly, import wasm/Tauri |
| Client | `packages/engine-client` | the typed `Engine` interface, transport (wasm worker / Tauri IPC), op batching | contain business logic |
| Engine | `crates/*` | project model, edit operations, timeline evaluation, decode/composite/encode orchestration, audio DSP, effects, AI orchestration | depend on web-sys/tauri (except `crates/wasm`) |
| Bindings | `crates/wasm`, `apps/desktop/src-tauri` | marshalling, platform capabilities behind traits | hold logic |

The boundaries are enforced by `npm run lint` (`scripts/check-boundaries.mjs`) and by crate dependency direction.

## Engine modules (crates)

| Crate | Responsibility | Key interfaces (planned) |
|---|---|---|
| `app-core` | handshake, ABI version, shared error and id types, platform capability traits | `EngineInfo`, `Capabilities`, `HostServices` |
| `app-model` | the project document: media references, tracks, clips, effects, keyframes, markers, settings; integer-tick time; ids; (de)serialization and schema migrations | `Project`, `Timeline`, `Clip`, `Time`, `Rational`, `Migration` |
| `app-timeline` | edit **operations** (split, trim, ripple, move, group, keyframe edit...), their inverses, undo/redo, op-log journal, selection and snapping logic, timeline evaluation (what is visible/audible at time t) | `Op`, `apply()`, `History`, `evaluate(t) -> Frame description` |
| `app-media` | probing, demux, decode via a `Decoder` trait, frame cache and prefetch, proxy and thumbnail generation, VFR to CFR mapping, waveform extraction | `Source`, `Decoder`, `FrameCache`, `ProxyJob` |
| `app-audio` | mixing, resampling, gain/fade/pan, loudness, EQ/dynamics/denoise DSP, beat detection, audio clock | `Mixer`, `AudioGraph`, `Meter` |
| `app-fx` | effect and transition definitions (data + WGSL), parameter evaluation with keyframes, color math, LUTs, masks, text layout and shaping | `EffectDef`, `Param`, `LutCube`, `TextLayout` |
| `app-render` | GPU compositor: builds a render graph from the evaluated frame, runs it on wgpu (WebGPU, WebGL2, Vulkan, Metal, DX12), colour management, readback for export | `Renderer`, `RenderGraph`, `Texture` |
| `app-export` | encode orchestration, muxing (MP4/WebM/MOV/GIF...), presets, size-targeted bitrate, queue and resume | `Encoder` trait, `Muxer`, `Preset`, `ExportJob` |
| `app-ai` | model registry and downloader contract, runtime abstraction (WebGPU/ONNX/native), task pipelines (STT, matting, tracking, reframe, TTS...) | `Model`, `Task`, `Runtime` |
| `app-wasm` | wasm-bindgen bindings only | |

Host-specific work (decode with WebCodecs, encode with VideoToolbox, read a file) is reached through **traits defined in the engine and implemented by the host**. On the web the host implementation is TypeScript (`engine-client` wasm backend: WebCodecs, OPFS) called from Rust through `wasm-bindgen` imports; natively it is Rust. This keeps the engine testable with fake hosts.

## Data model and edits
- **Time** is integer ticks (`ADR 0010`), exact for every common frame rate and sample rate; conversion to frame index or sample index is explicit and rounding is defined once.
- **Project** is a tree: `Project -> Sequences -> Tracks -> Clips -> {source ref, in/out, transform, effects[], keyframes}`. Media is referenced by content hash + path hints, never embedded by default.
- **Edits are operations** (ADR 0006): every change is a small serializable `Op` with a computed inverse. The UI sends ops; the engine applies them, returns patches, appends to a journal. This one mechanism gives undo/redo, autosave and crash recovery (replay the journal), scripting/automation, and later collaboration (ops become CRDT-mergeable) and version history.
- **File format** `.overcut`: a zip with `project.json` (versioned schema, forward-compatible unknown fields preserved), optional embedded small assets, and a journal. Schema is generated from Rust types to TypeScript and JSON Schema so the UI and docs cannot drift. Migrations are code plus fixtures in tests.

## Rendering and playback
1. **Evaluate**: for a playhead time, `timeline.evaluate(t)` yields a *frame description*: visible clips, their source times, transforms, effect stacks with parameters evaluated at `t`.
2. **Decode**: `media` supplies decoded frames (GPU-resident when the platform allows: WebCodecs `VideoFrame` imported as an external texture; native zero-copy where the API exists) from a look-ahead cache; scrubbing uses nearest keyframe + decode forward with proxies as the fallback.
3. **Composite**: `render` builds a render graph (layer draws, effect passes, blends, masks, transitions) and runs it on the GPU in linear light, then converts to the display transform.
4. **Present / encode**: preview presents to a canvas/surface; export reads back (or feeds an encoder texture directly) at the project frame rate.
Audio is the master clock for playback: video frames are dropped or repeated to follow the audio, never the reverse. Export is deterministic and not tied to real time.

## Threading
- **Web**: the engine and render run in a dedicated Worker with `OffscreenCanvas`; decoders in the same or auxiliary Workers; the UI thread only sends ops and draws UI. Cross-origin isolation (COOP/COEP, already configured) enables `SharedArrayBuffer` for frame and audio ring buffers and threaded WASM where it pays off.
- **Native**: render thread, decode thread pool, audio callback thread, job pool for export/AI; UI process separate from the engine only if profiling demands it.
- No engine call blocks the UI thread; long work is a *job* with progress, cancel and resume.

## Media I/O strategy (detail in ADR 0004)
| | Web / PWA | Desktop (Tauri) | Mobile (Tauri) |
|---|---|---|---|
| Demux | Rust demuxers in WASM (MP4/MOV, WebM/MKV) | FFmpeg libav (dynamic, LGPL) | Rust demuxers or FFmpeg |
| Decode | WebCodecs (HW), WASM fallbacks for audio | HW (NVDEC/VAAPI/VideoToolbox/MF) via FFmpeg, SW fallback | WebView WebCodecs (iOS 16.4+/Android), native plugins where needed |
| Encode | WebCodecs (H.264/AV1/VP9/Opus/AAC where offered) | HW encoders first (NVENC, AMF, QSV, VideoToolbox), SW AV1/VP9; openh264 for royalty-covered H.264 fallback | WebView WebCodecs or native MediaCodec/VideoToolbox plugin |
| Mux | Rust muxers in WASM | Rust muxers or libav | same as web |
| Unsupported codec | clear message + "convert" using the slow WASM path | transcode via libav | clear message |
Capability probing at startup builds a `Capabilities` table that the UI uses to enable/disable options (e.g. HEVC export) instead of failing late.

## Storage
- **Web**: OPFS for imported/proxy/cache data and project files; File System Access API (Chromium) to link files in place; IndexedDB for the project index and settings. Storage persistence is requested; low-space handled explicitly.
- **Native**: user-chosen project folder; app cache directory for proxies/thumbnails/models with size limits and a "clear cache" control.
- Media is never uploaded. Export writes to a user-chosen location or the share sheet.

## AI on-device (ADR 0008)
Models are open-weight (e.g. Whisper-class STT, matting, detection/tracking, TTS, interpolation), distributed as files fetched on demand from a static host (checksummed, versioned, mirrored), run on WebGPU/ONNX-WASM on the web and native runtimes in apps. A model manager shows size, quality tier and licence, and removes models on request. Tasks are *jobs* producing ops (e.g. "insert caption clips") so results are undoable and editable, never opaque.

## Extensibility (ADR 0007 + XT-01)
Effects and transitions are **data**: a manifest (parameters, UI hints, defaults) plus WGSL (and a GLSL ES fallback for WebGL2 generated at build). Built-ins use the same format as plugins. Plugins cannot run native code on web/mobile; desktop may add a WASI-sandboxed compute tier later. Template packs are `.overcut` projects with media slots.

## Security and privacy
Memory-safe engine (`unsafe` forbidden in workspace lints except audited FFI crates); demuxers fuzzed in CI; strict CSP with no third-party scripts; network access limited to update checks, model downloads, and user-initiated actions, listed in one allow-list file that a test asserts against; no telemetry by default; crash reports are opt-in and exclude media and paths; plugins sandboxed.

## UI architecture
React 19 + Vite, plain CSS with design tokens (no heavy component library), headless accessibility primitives. Timeline and waveform are **canvas/WebGPU-rendered and virtualized** (not DOM per clip). Layout is driven by container queries and a small set of *form factor profiles* (phone portrait, phone landscape, tablet, desktop, ultrawide), each with its own panel arrangement over the same components. All UI state that is the project comes from the engine (single source of truth); UI-only state (selection, zoom, panel layout) stays in the UI store. i18n via message catalogs from day one; strings never hard-coded.

## Repository layout
```
crates/            core model timeline media audio fx render export ai wasm   (Rust workspace)
apps/web           the UI (PWA)
apps/desktop       Tauri shell (desktop + mobile targets)
packages/          engine-client (and later: ui, i18n, schema)
docs/              this documentation and ADRs
scripts/           build, boundary check, smoke, CI helpers
tests/             unit (TS), smoke (Playwright); Rust tests live in crates/*
```

## Platform support targets (1.0)
Web: current Chrome/Edge/Safari/Firefox (WebCodecs + WebGPU or WebGL2; degraded paths documented). Windows 10+, macOS 12+, Linux (x86_64/aarch64, glibc 2.31+). iOS 16.4+, Android 9+ (API 28; WebView with WebCodecs). Chromebooks via the web/Android app.
