# Implementation plan

How we get from the M0 skeleton to M1 and beyond without building the wrong thing first. Read with [ROADMAP.md](ROADMAP.md) and [ARCHITECTURE.md](ARCHITECTURE.md).

## 1. Strategy: kill the biggest risks first
The product is only viable if five hard things work on every platform: decode to GPU, composite on GPU, encode with sound in sync, handle large media on weak devices, and keep the UI at 60 fps on long timelines. Everything else is ordinary engineering. So M1 starts with **time-boxed spikes**, each with a success bar and a pivot if it fails. A spike produces an ADR update, a benchmark in `crates/*/benches` or `tests/perf`, and throw-away code that is rewritten (not polished) into the real module.

| Spike | Question | Success bar | If it fails |
|---|---|---|---|
| S1 Web decode to GPU | Can WebCodecs `VideoFrame`s feed WebGPU textures with frame-accurate seeking and < 50 ms scrub latency? | 1080p H.264 seek-to-frame < 50 ms warm, no copy through CPU on Chrome and Safari | CPU upload path + bigger prefetch; document per-browser matrix |
| S2 wgpu in the browser | Does one wgpu renderer run on WebGPU **and** the WebGL2 fallback with identical output? | golden frame equal within tolerance on both; 60 fps for 3 layers at 1080p on reference laptop | WebGPU-only + a simple Canvas2D/WebGL2 renderer for degraded mode (ADR 0003) |
| S3 Encode and mux in the browser | Can we encode H.264/AAC (or VP9/Opus, AV1) with WebCodecs and mux MP4/WebM with A/V sync, in a worker, faster than real time? | 1080p30 5 min export >= 1x on reference phone browser, sync drift < 1 frame | WASM software encoders for fallback only; narrow default presets |
| S4 Native media | Does libav (LGPL) + HW encoders give the same frames and sync on desktop; can we ship without GPL parts? | decode parity within tolerance vs web path; HW export >= 4x realtime | OS media frameworks per platform behind the same `Decoder`/`Encoder` traits |
| S5 Mobile WebView | What does Tauri mobile's WebView actually support (WebCodecs, WebGPU, SharedArrayBuffer, OPFS, memory limits) on iOS and Android? | capability table for 5 devices; 1080p preview 30 fps | native media plugin per platform (Kotlin/Swift) for decode/encode |
| S6 On-device STT | Whisper-class model speed and size on WebGPU/WASM and native | 10 min audio in < 3 min on reference laptop; model <= 150 MB default tier | smaller tier by default, native runtime on apps, chunked background job |
| S7 Operation log | Do the op/inverse/journal semantics hold under random testing and give < 1 ms per op at 5k clips? | 100k random op sequences: `undo(do(x)) == x`, replay(journal) == state | simplify op granularity; structural sharing |
| S8 Timeline view | Can a canvas-rendered, virtualized timeline stay at 60 fps with 1000 clips and 20 tracks on the low-end reference phone? | 60 fps pan/zoom desktop, 30+ fps low-end phone | tile cache + level-of-detail |

S1, S2, S3, S7, S8 run in parallel in the first 3-4 weeks; S4 and S5 start when S1-S3 have an interface; S6 belongs to M3 but is spiked in M1 so the model-manager design is not a surprise.

## 2. Workstreams and owners (roles, not people)
| Workstream | Scope | Crates / paths |
|---|---|---|
| **Engine core** | model, ops, history, evaluate, file format, migrations | `core`, `model`, `timeline` |
| **Media I/O** | probe, demux, decode, cache, proxies, waveforms, encode/mux | `media`, `export`, `audio` (I/O parts) |
| **Render and effects** | compositor, color, effect/transition format, text layout | `render`, `fx` |
| **Audio** | mixer, DSP, loudness, beats | `audio` |
| **AI** | model manager, runtimes, tasks | `ai` |
| **UI/UX** | layouts per form factor, timeline canvas, inspector, panels, a11y, i18n | `apps/web`, `packages/*` |
| **Platform** | Tauri desktop/mobile, packaging, signing, updates, store builds | `apps/desktop`, `.github/workflows` |
| **Quality and perf** | test harnesses, golden frames, benchmarks, device lab, fuzzing | `tests/`, `crates/*/benches`, CI |
| **Content and community** | docs, templates, effect packs, translations, website | `docs/`, later repos |

## 3. How work flows (applies to people and Claude sessions)
1. **Plan in docs, build in small PRs.** A feature starts as a row in FEATURES.md and a short `docs/features/<id>.md` (behaviour, data model, edge cases, test plan, perf impact). Architecture-level choices get an ADR first.
2. **One issue = one PR = one reviewable change** (CLAUDE.md: branch + PR, merge on green `verify`). Issues are small (<= 1-2 days). Epics are labelled `epic:<name>`, milestones are GitHub milestones `M1`...`M9`, features carry the feature ID in the title (`TL-02: split clip`).
3. **Vertical slices.** Each feature lands engine op + binding + UI + test together, behind the same interface on every platform (CLAUDE.md boundary rule). No "web first, native later" half-features.
4. **Definition of done** for any feature PR: engine unit tests (and property tests for ops); UI smoke step at phone and desktop widths; keyboard path and accessible name; strings in the catalog; perf measured against the budget when it touches playback/render/export/timeline; `docs/features/<id>.md` updated; screenshot for visual changes.
5. **Perf and quality gates in CI** from M1: unit, smoke, boundaries, rustfmt/clippy, `cargo deny` (licences), bundle-size budget, benchmark regression check (warn at +10%, fail at +25%), golden frames from M1 onward.
6. **Weekly cadence** (suggested): Monday plan from the roadmap; Friday demo + update the `Roadmap and status` issue (#1) and the ADR/open-decision list.

## 4. M1 backlog (the first issues to create; IDs are issue titles)
Ordered; `[S]` = spike. Create these as GitHub issues in milestone **M1**.

**Engine core**
1. `M1-001` Define `Time`/`Rational` (integer ticks, conversions, rounding rules) + property tests (ADR 0010).
2. `M1-002` `app-model`: Project/Sequence/Track/Clip structs, ids, serde, JSON schema export, TS type generation into `engine-client`.
3. `M1-003` `[S7]` `app-timeline`: `Op` enum (insert clip, split, trim in/out, move, delete), inverse, `apply`, `History` (undo/redo), journal append/replay, random-sequence property tests.
4. `M1-004` `evaluate(t)`: frame description for one video + one audio track, with tests for edges (gaps, clip boundaries, speed 1x).
5. `M1-005` `.overcut` writer/reader with versioned `project.json` + migration test fixtures + fuzz target.
6. `M1-006` Capabilities struct and probe plumbing through `HostServices` (web and Tauri) shown in the UI debug panel.

**Media I/O**
7. `M1-010` `[S1]` WebCodecs decode to texture, seek accuracy test page, benchmark.
8. `M1-011` `app-media`: `Source`/`Decoder` traits, fake decoder for tests, frame cache with look-ahead and byte budget.
9. `M1-012` MP4/MOV + WebM demux in Rust (WASM-safe) with probe (duration, tracks, rotation, VFR detection); fuzz target.
10. `M1-013` Waveform extraction job (peaks file cached in OPFS/app cache).
11. `M1-014` `[S3]` WebCodecs encode + MP4 mux with audio, worker, progress, cancel; sync test with a click track.
12. `M1-015` `[S4]` Native decode/encode via libav behind the same traits (desktop), parity test vs web.

**Render**
13. `M1-020` `[S2]` wgpu render of 3 layers (transform, opacity) to canvas on WebGPU and WebGL2; golden frame harness.
14. `M1-021` Colour pipeline v0 (sRGB in/out, linear compositing) and test chart.
15. `M1-022` Export render path (offscreen, readback or direct encoder texture) with deterministic output test.

**UI**
16. `M1-030` Editor shell layouts for the five form-factor profiles (exists as empty panels in M0) + container-query tests.
17. `M1-031` `[S8]` Canvas timeline: ruler, one video track, one audio track, playhead, zoom/scroll, virtualization benchmark.
18. `M1-032` Media bin: import (picker, drag/drop), thumbnails, project media list.
19. `M1-033` Preview panel with transport controls, JKL, scrub, frame step; audio-clock sync.
20. `M1-034` Timeline interactions: select, drag, trim handles, split at playhead, delete, undo/redo buttons and shortcuts.
21. `M1-035` Export dialog: presets (YouTube/TikTok/Reels/custom), progress, cancel, result save/share.
22. `M1-036` Theme tokens (dark/light/high contrast), i18n plumbing (message catalog, ICU plural test), a11y primitives.

**Platform and quality**
23. `M1-040` Project persistence + autosave + crash recovery on web (OPFS) and native (folder); `kill -9` test.
24. `M1-041` Desktop shell: Tauri commands for engine, file dialogs, drag-drop; `desktop-check` green; first signed? (no: unsigned) artifacts from `release.yml` dry run.
25. `M1-042` Network allow-list file + CI test that fails on any other request; CSP review (XT-06).
26. `M1-043` Performance harness: reference-device definitions (ADR), `tests/perf` runner, CI benchmark job and budgets in `PERFORMANCE.md`.
27. `M1-044` Activation usability script and first test with 5 users (import, trim, export).

M1 is done when all of these are merged and the M1 exit checklist is green. M2-M9 backlogs are written when the previous milestone is two-thirds done (planning further ahead goes stale).

## 5. Risks and mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| Browser capability fragmentation (WebCodecs/WebGPU differences, Safari) | features silently broken on a browser | capability table + feature detection, per-browser CI matrix (Chromium, WebKit, Firefox), degraded paths documented not hidden |
| Mobile memory and thermal limits | crashes, slow export | proxies by default on mobile, bounded frame caches, chunked export with resume, device lab |
| Codec licensing and patents (H.264/HEVC/AAC) | legal exposure, "free" at risk | use OS/browser/hardware codecs, openh264 binary (royalty-covered), prefer AV1/VP9/Opus by default where recipients allow; LGPL FFmpeg only; counsel review before 1.0 (ADR 0004) |
| A/V sync and VFR bugs | trust-destroying | audio-master clock, VFR to CFR at import, sync test media in CI, soak tests |
| Scope: "feature complete" is enormous | never ships | milestones with exit criteria; P0/P1/P2 discipline; ship every milestone; kill list per milestone |
| On-device AI size and speed | slow or huge downloads | quality tiers, optional downloads, background jobs, honest speed bars |
| Tauri mobile maturity | blockers late | S5 early; native plugin fallback; PWA is the always-available mobile path |
| Funding "completely free" | burnout, abandonment | no backend costs, minimal fixed costs listed (ADR 0011), sponsors/donations, governance doc at 1.0 |
| Trademark / name clash ("Overcut") | rename cost | check before public launch (ADR 0012) |
| Single point of failure on maintainers | bus factor | docs-first, ADRs, small modules, welcoming contribution guide at M3 |

## 6. Decisions the owner needs to make (blocking marked)
See [adr/README.md](adr/README.md): **license (0009, blocks first external contribution)**, **distribution costs and stores (0011, blocks M5)**, **name/trademark check (0012, blocks public launch)**, reference devices list (0013, blocks M1 perf gates), governance and funding (0014, by M3).
