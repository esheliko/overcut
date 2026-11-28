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

M1 is done when all of these are merged and the M1 exit checklist is green. M2 backlog: section 4b. M3-M9 backlogs are written when the previous milestone is two-thirds done (planning further ahead goes stale).

## 4a. M1 sequencing (changed 2026-11-22, after the first build wave)
**Why**: the first wave built foundations breadth-first (model, ops, file format, media reading, render spike, colour) and nothing a person can try yet; the import, trim, export loop (M1-032 to M1-035, M1-022) was not started. Working spikes also cannot be fully proven in the cloud: S1 (<50 ms seek, zero-copy) and S2 (60 fps at 1080p, WebGPU in a real browser) ran on a software renderer.

**Status at this change** (merged on `main`): M1-001, 002, 003 (S7), 005, 011, 012 (plus fragmented MP4 and CPU/GPU frame variants), 010 (S1, code only), 020 (S2, code only), 021. Open or paused with work in progress: 004, 006, 014 (S3), 016 (new: production WebCodecs decoder backend), 031 (S8), 036, 040.

**Order from here (vertical slice first)**:
1. Finish the in-flight items that the slice needs: 004 (evaluate), 016 (decoder backend), 014 (encode and mux), 031 (canvas timeline), 040 (autosave).
2. Then the slice itself, one thin end-to-end path before polish: 032 (import) -> 033 (preview and transport) -> 034 (split, trim, delete, undo) -> 035 and 022 (export). Each lands engine op, binding, UI and smoke step together (section 3, rule 3).
3. Then 030, 013, 036, 006, 041 to 044.
4. Do not start another foundation item unless the slice needs it.

**Device proofs are separate from merging.** Spike code merges when its tests pass in CI. The success bars that need real hardware (S1 seek latency and zero-copy, S2 60 fps, S3 export speed and A/V drift, S8 on the low-end phone) are tracked as a checklist run on the reference devices (ADR 0013) and recorded in the spike's ADR results section. A spike is marked "proven" only when that run exists; until then say "code merged, bar unproven". Do not spend cloud sessions trying to measure what needs a GPU.

**Session sizing** (cost note: every session re-reads its whole context each turn, and a cold start costs about $0.5 to $0.75 before any work): one session per vertical slice or per tightly related set of items, not per tiny change. A follow-up to an item goes to the session that still holds its context, or is folded into the next item in the same crate. A docs-only edit is done directly by whoever is already in the repo, not by a new session.

## 4b. M2 backlog "Real editing" (written 2026-11-24; M1 code is complete, open M1 items are device proofs, process items and owner acceptances: [M1-STATUS.md](M1-STATUS.md))
Scope is exactly the ROADMAP M2 row list; anything else is in "Not in M2" below. `[S]` = spike (throw-away code, an ADR, a benchmark; section 1 rules). Size: S <= 1 day, M 2-3 days, L 4-5 days (an L that grows is split). Each item lands engine op + binding + UI + test together where it has all four (section 3, rule 3). **Exit criteria** referenced as E1 to E4: **E1** 1000-clip, 20-track timeline pans and zooms at 60 fps; **E2** undo/redo property tests pass 10k random sequences; **E3** 30 min 4K project edits smoothly with proxies on the reference laptop; **E4** A/V drift < 1 frame over 2 h. Section 4b.3 says how each is measured.

### 4b.1 Lanes (three workers, disjoint files)
Each item names its dependencies (`dep`); a dependency in another lane is a merge to wait for, not shared editing.
| Lane | Owns (a worker edits only these) | Items |
|---|---|---|
| **A: model and timeline ops (Rust)** | `crates/model`, `crates/timeline`, new `crates/wasm/src/edit.rs` and the matching `src-tauri` commands, `packages/engine-client/src/editing.ts` (new file, not `types.ts`), `docs/features/{model,timeline-ops,evaluate}.md` | M2-001 to M2-011 |
| **B: media, playback, render, export** | `crates/media`, `crates/render`, `crates/export`, `crates/audio`, `crates/wasm/src/{media,render}.rs`, `apps/web/src/{preview,export,media}/`, `packages/engine-client/src/media.ts`, `tests/perf/` | M2-020 to M2-034 |
| **C: UI and UX** | `apps/web/src/{timeline,layout,commands,store}/`, `Timeline.tsx`, `Home.tsx`, `ProjectDialogs.tsx`, `styles.css`, `tests/smoke/`, `apps/web/src/i18n` | M2-040 to M2-053 |
Shared-file rules: `PreviewPanel.tsx` belongs to B; lane C adds its on-canvas handles as a new component (`preview/TransformHandles.tsx`) that B only imports. A lane never edits another lane's files: it asks that lane (or waits for its merge) and merges `main` before pushing. Schema, `ABI_VERSION`/`EXPECTED_ABI` bumps happen only in lane A items (002, 003, 004, 007, 008), one at a time, never in parallel.

**Start these three first** (no dependencies, each unblocks its lane's long pole): **M2-001** [S9] keyframe model (lane A: 003 and 004 wait for it), **M2-020** [S10] proxy format (lane B: proxies are the long pole of E3), **M2-040** shortcut and command registry (lane C: no engine dependency). Spikes S11 and S12 (M2-021, M2-022) start as soon as a lane worker is free, before 023 and 031.

### 4b.2 Items
**Lane A: model and timeline ops**
1. `M2-001` `[S9]` Keyframe and animatable-property model (see spike table; ADR 0015). Prototype in `crates/model`, wasm and native results compared. **S-M**, no deps. E2.
2. `M2-002` Multi-track model + track ops. TL-01, TL-08 (engine). `AddTrack/RemoveTrack/MoveTrack/SetTrackProps` (name, mute, solo, lock, hide, height, colour); evaluate honours hide/mute/solo; `TrackKind` keeps Video + Audio (overlay is a video track higher in the stack, TL-14); Text/Effect kinds reserved for M3/M4, not built. Schema v2 + migration fixtures, `ABI_VERSION` bump, docs/features/model.md. Tests: unit, S7 property tests extended, migration round-trip. **M**, dep 001. E1, E2.
3. `M2-003` Clip transform and background fill (model). TL-13, TL-14, TL-19. `SetClipProps` (position, scale, rotation, anchor, crop, flip, opacity, fit/fill) in the shape ADR 0015 picks (animatable-ready, identity default so M1 files open unchanged); sequence/clip `background` (blur, colour, gradient, image ref); `VideoLayer` carries the evaluated values. Tests: unit, property (undo), evaluate edge cases. **M**, dep 001, 002. Serves 024, 025, 047.
4. `M2-004` Keyframes: ops and evaluation. TL-12. `SetKeyframe/MoveKeyframe/DeleteKeyframe/SetEasing`, evaluate at t with hold/linear/bezier + presets, drag-coalesced into one undo step, `< 1 us` per parameter (bench). Tests: property (undo, replay), golden values equal on wasm and native. **L**, dep 001, 003. E2.
5. `M2-005` Ripple, roll, slip, slide + ripple delete + gap close. TL-04, TL-02 carry-over (ripple delete), TL-20 gaps. Ops on one or many tracks (locked tracks excluded, sync rule documented), integer-tick exact, no overlaps ever (validate). Tests: property (undo, no-overlap invariant), edge cases at 0 and at source limits. **L**, dep 002. E2.
6. `M2-006` Link, group, multi-op. TL-05 (engine), AU-03. `Link/Unlink/Group/Ungroup` stored in the project (selection itself is UI state, not in the file); `Batch` op = one undo step for multi-select edits; `DetachAudio/AttachAudio`. Tests: property, linked-move invariants. **M**, dep 002. E2.
7. `M2-007` Markers, chapters, in/out range, loop range. TL-07. Sequence-level model + ops, schema bump batched with 003 or 008 if they are open. Chapter export to MP4 stays with lane B (030). **S**, dep 002.
8. `M2-008` Speed: constant, reverse, freeze, loop. TL-10 (engine), TL-20 freeze/extend/replace. Clip gets `reverse`, `freeze_at`, `loop`; speed stays a positive `Rational`; source-time mapping exact in ticks (no float; fractional-tick result is an error as today). Tests: unit, property (map is monotonic, round-trips), evaluate edges. **M**, dep 002. Serves 026.
9. `M2-009` Snapping engine. TL-03. Pure `snap(t, targets, tolerance) -> Snap` in `crates/timeline/src/snap.rs`: playhead, clip edges, markers, range, beats (hook for M3), magnetic mode; targets built from the project, no UI state. Tests: unit + property (idempotent, nearest wins), bench on 20 tracks x 1000 clips (< 1 ms). **S-M**, dep 007. E1.
10. `M2-010` Replace, extend, overwrite and insert edits. TL-20. `Replace`, `Extend`, insert-at-position (ripple) and overwrite as ops built on 005. Voice-over recording is M3; here only the insertion and gap behaviour. **S**, dep 005.
11. `M2-011` Property-test gate for E2. Every new op joins the S7 generator as it merges (rule for items 002 to 010); this item adds the 10k-sequence run over the full op set in release mode, undo-all/redo-all and journal replay, and the 20-track x 1000-clip op bench. **S**, dep 005, 006, 008. E1, E2.

**Lane B: media, playback, render, export**
12. `M2-020` `[S10]` Proxy format and cache (ADR 0016). **M**, no deps. E3.
13. `M2-021` `[S11]` A/V drift method and VFR policy (ADR 0017). **S-M**, no deps. E4.
14. `M2-022` `[S12]` Export resume and queue persistence (ADR 0018). **S**, no deps. Serves 031.
15. `M2-023` VFR to CFR mapping. TL-22, PM-04. Probe already detects VFR; add the pts-to-frame table in `app-media` (policy from ADR 0017), used by decode scheduling, evaluate hand-off and export. Tests: VFR fixtures (generated in `tests/fixtures/make.sh`), sync assertions against the click/flash track. **M**, dep 021. E4.
16. `M2-024` Compositor: transform, crop, flip, opacity, stacking. TL-13, TL-14. Render graph draws each `VideoLayer` with its matrix and blend; WebGPU and WebGL2 identical within tolerance (golden frames, S2 harness). Preview frame time measured against the 1080p 3-layer budget. **L**, dep 003. E1 (render side).
17. `M2-025` Background fill render. TL-19. Blur, colour, gradient, image behind a letter/pillar-boxed layer; blur is one cheap downsample pass. Golden frames. **M**, dep 003, 024.
18. `M2-026` Speed playback. TL-10. Decode scheduler honours the speed map; reverse via GOP-chunk decode and reverse cache (or the proxy if ADR 0016 makes all-intra proxies the reverse path); freeze; audio resample plus pitch-preserving stretch (WSOLA; no GPL dependency) in `app-audio`. Tests: audio unit (pitch and length), sync test with the click track at 0.5x, 2x, -1x. **L**, dep 008, 020. E4.
19. `M2-027` Proxy job. PM-05. Background, resumable (chunked, OPFS and app cache), automatic policy per device and resolution (always on for 4K on low/mid phones, offered on laptop), cache size limit and "clear cache"; same `Decoder` trait so preview swaps source without the timeline noticing. Tests: unit (policy, resume after kill), smoke (proxy badge, switch). **L**, dep 020. E3.
20. `M2-028` Preview on proxies and adaptive quality. PV-02. Quality ladder (proxy, resolution scale, effect quality), never drops audio, drops video frames first (design rule 6); toggle "full quality" for stills and export. Tests: unit (ladder), preview smoke, `preview.*` perf metrics. **M**, dep 024, 027. E3.
21. `M2-029` Playback while editing. PV-06. Ops applied between frames in the Worker, the player re-evaluates from the patch; no dropped audio during a drag on a 20-track project. Tests: smoke (edit during play), perf (frame lateness p95 while dragging). **S-M**, dep 002, 028.
22. `M2-030` Export parity on multi-track. EX-03 prerequisite. Export uses the same `evaluate` and compositor as preview: all tracks, transforms, speed, hidden/muted/solo, markers as MP4 chapters; deterministic output test and preview-vs-export frame equality. **M**, dep 024, 026.
23. `M2-031` Export queue. EX-03. Persisted job list (IndexedDB/OPFS, Tauri folder), run in background, pause/resume, estimate, progress notification (Notification API where allowed), resume after tab/app restart at the last safe segment (ADR 0018). Tests: unit (state machine), smoke (kill mid-export, resume), `export.speed_x` unchanged. **L**, dep 022, 030.
24. `M2-032` GIF, animated WebP, APNG, still frame, image sequence. EX-05. Encoders behind the `Encoder` trait, palette quantiser for GIF, size warning; licences checked against ADR 0004. Tests: unit (decode back, frame count/timing), smoke. **M**, dep 030.
25. `M2-033` Format support matrix. PM-04. MKV demux, HEVC/VP9/AV1 via the capability probe, ProRes only where native decode exists, HEIC/AVIF/SVG/GIF stills, per-platform table in ADR 0004, clear message and "convert" offer for unsupported input. Fuzz targets for each new demuxer. **L**, no deps. (Lane B, schedule when 023 is done.)
26. `M2-034` Perf fixtures for E3 and E4. Generator for a synthetic 30 min 4K project (and the 2 h drift run), metrics added to `tests/perf/metrics.mjs` (peak memory, dropped frames, drift max/p99, op latency), docs in `PERFORMANCE.md`. **M**, dep 021, 027. E3, E4.

**Lane C: UI and UX**
27. `M2-040` Command and shortcut registry. UX-03. One registry of commands (id, label, default keys, context), presets familiar from CapCut, Premiere, Final Cut and DaVinci (named "like X", no logos or trademarked assets), user remap with conflict detection, stored locally, every existing shortcut migrated; keyboard path and accessible names. Tests: unit (resolve, conflicts, presets), smoke (remap and use). **M**, no deps.
28. `M2-041` Command palette. UX-04. Search over every registered command and setting, recent first, keyboard and touch. Tests: unit (ranking), smoke at phone and desktop widths. **S-M**, dep 040.
29. `M2-042` Multi-track timeline view. TL-01, TL-08 (UI), TL-09 part. Track headers (mute, solo, lock, hide, height, colour, reorder by drag), vertical scroll, virtualised canvas draw for 20 tracks; `tests/perf/timeline-bench.mjs` switches to a real 20-track project. **L**, dep 002. E1.
30. `M2-043` Zoom and scroll 10 s to 10 h. TL-09, UX-02 (pinch zoom). Level-of-detail for clips, ruler and waveforms, overview bar, zoom to fit/selection, keyboard zoom. Perf at 60 fps desktop, 30 fps throttled phone. **M**, dep 042. E1.
31. `M2-044` Selection and linking UI. TL-05, AU-03 (UI). Multi-select, marquee, group/link/detach-attach actions, linked clips move and trim together, shown in the UI. Tests: unit (selection logic in `timeline/`), smoke. **M**, dep 006, 042.
32. `M2-045` Ripple, roll, slip, slide in the timeline. TL-04, TL-20 (UI). Handles and modifier keys without a mode switch, a tool toggle for touch, ripple delete and gap delete, numeric entry. Tests: smoke at both widths, unit (hit testing). **M**, dep 005, 042.
33. `M2-046` Snapping, markers, range UI. TL-03, TL-07 (UI). Snap indicator, magnetic toggle, marker add/rename/colour/chapter flag, in/out/loop range on ruler and in transport. **M**, dep 007, 009, 042.
34. `M2-047` Inspector and on-canvas transform. TL-13, TL-14, TL-10 (UI). Numeric fields, fit/fill, flip, speed field and reverse/freeze/loop, on-canvas handles (move, scale, rotate, crop; touch-size handles), stacking order controls. Screenshots at both widths. **L**, dep 003, 008, 024.
35. `M2-048` Keyframe UI. TL-12. Diamonds per property, easing picker, bezier/graph editor (pro), copy keyframes, keyboard nudge. Screenshots at both widths. **L**, dep 004, 047.
36. `M2-049` Touch, stylus, trackpad. UX-02. One pointer-event layer: pinch, two-finger pan, long-press menu, edge-drag scroll, stylus precision, palm rejection; Playwright touch emulation tests; mobile polish stays M5. **M**, dep 043.
37. `M2-050` Export queue UI. EX-03 (UI). Queue panel, pause/resume/cancel, estimates, "keep this tab open" guidance where the OS suspends it, notification opt-in. **M**, dep 031.
38. `M2-051` Project library. PM-08. Duplicate, rename, archive/restore, import/export `.overcut` from the library (extends `Home.tsx`; check what `project-lifecycle.spec.ts` already covers first). **S-M**, no deps.
39. `M2-052` Collect, consolidate, link in place. PM-09. File System Access (Chromium) and native copy; progress, disk-space check, relink on failure. Tests: unit, smoke where the API exists. **M**, dep 051.
40. `M2-053` Opt-in crash reports (XT-06b), local part. "Save/copy crash report" fallback and the off-by-default toggle with a network-log entry; **no endpoint is added until the owner decides ADR 0019**. **S**, dep none (remote part blocked).

### 4b.3 Spikes before code
| Spike | Question | Success bar | If it fails | ADR |
|---|---|---|---|---|
| S9 Keyframes (M2-001) | Where do keyframes live, which interpolation, which number type, what is one undo step? | Same value on wasm and native for 1M random samples (f64, deterministic bezier solve, no libm); < 1 us per parameter; drag of 200 keyframe moves = 1 undo entry; M1 files open unchanged | Fixed-point (Q32.32) values; piecewise-linear only for M2 | **0015** keyframes and animatable properties (proposed; recommendation: per-property key lists on the clip, clip-relative ticks, hold/linear/cubic-bezier plus CSS-like presets) |
| S10 Proxies (M2-020) | Which proxy codec/resolution/container, how stored and resumed, and does it make reverse and long-GOP scrub cheap? | 4K H.264 source to proxy >= 2x realtime on the Windows laptop; seek p50 <= 50 ms on proxy at laptop and <= 120 ms on the low-tier proxy; proxy <= 10% of source size; resume after kill loses < 10 s of work | Scrub strip only for scrub, original for play (today's state) and a smaller 4K cap | **0016** proxies (proposed; recommendation: 540p/720p H.264, short or all-intra GOP, MP4 segments, OPFS, keyed by content hash) |
| S11 A/V drift and VFR (M2-021) | How do we measure drift over 2 h without waiting 2 h in CI, and is VFR handled by a pts table or by re-timing at import? | Method detects an injected 1-frame drift; export drift is zero by construction (integer ticks); playback drift max over 2 h < 1 frame on one device; VFR clip stays in sync within 0.5 frame at 100 random seeks | Resample audio to the video clock only in export; document the playback drift number and the cause | **0017** A/V drift and VFR (proposed; recommendation: audio master clock, pts table at probe, CFR only in proxies and export) |
| S12 Export resume (M2-022) | Can a killed export resume from the last safe segment on web and desktop, and give an identical file? | `kill -9` mid-export then resume: output byte-identical to an uninterrupted run (same encoder) or frame-equal; lost work < one segment | No resume on web (restart from zero, say so), resume on desktop only | **0018** export queue and resume (proposed) |
| (owner) XT-06b endpoint (M2-053) | Is there an optional crash-report endpoint at all, hosted by whom, at what cost? | n/a: owner decision, see below | Local file/clipboard only (default today) | **0019** crash-report endpoint (**proposed, not picked; owner-level**: it adds the project's first server and a running cost, ADR 0005/0011) |

### 4b.4 How each exit criterion is measured
Per section 4a: an item merges when CI passes; a hardware bar is "proven" only with a device file in `tests/perf/devices/` and the number in `docs/PERFORMANCE.md`. The perf CI job is **issue #51** (`process: perf CI job`, pending a process session): until it lands, `npm run perf` and `perf:compare` run by hand in a worker session and the result goes in the PR.
| Exit | Harness | Metric and bar | Where it runs |
|---|---|---|---|
| **E1** 1000 clips x 20 tracks at 60 fps | `tests/perf/timeline-bench.mjs` (S8), moved onto a real 20-track project by M2-042; Rust op bench in `crates/timeline/examples/bench.rs` (M2-011) | `timeline.*` pan/zoom fps (desktop 60, laptop 60, throttled phone 30), op apply <= 2 ms laptop at 5k clips | Container trend in `npm run perf` (and in #51 once wired); Windows laptop and Galaxy S24 as device proof |
| **E2** 10k random sequences | `crates/timeline/src/tests.rs` (S7 generator, all ops from 002 to 010), `PROPTEST_CASES=10000 cargo test -p app-timeline --release` | 0 failures: `undo(do(x)) == x`, `replay(journal) == state`, no overlap, links consistent | CI runs 256 cases per `verify` today; a release 10k step is a **process request** (`process: M2 exit CI steps`), until then run by the lane A worker at M2-011 and at the exit review |
| **E3** 30 min 4K edits smoothly with proxies | M2-034 generator: 30 min synthetic 4K timeline, 1 video + 1 overlay + audio; metrics in `tests/perf/metrics.mjs`: dropped frames and lateness p95 over a 60 s scripted scrub-and-play, input-to-paint while dragging, peak memory | dropped < 1%, scrub first frame <= 50 ms (laptop), drag <= 16 ms, memory <= 3 GB laptop and no OOM at 4 GB low phone | Container for trend; **proof on the Windows laptop and Mac** (ADR 0013) via `/diagnostics` plus `perf:device`; low phone stays "calibrated proxy" |
| **E4** drift < 1 frame over 2 h | M2-021 method + M2-034 harness: click-and-flash media, sample audio clock vs presented frame pts each second, report max and p99; export side by integer-tick unit test (frame times and sample counts exact) | max drift < 1 frame (33.3 ms at 30 fps) | Export check in `cargo test`; playback 2 h run once per milestone on one device (and nightly accelerated run in the container after a process request); a number from a run shorter than 2 h is labelled as such |
Property, golden-frame and smoke steps listed on each item are CI gates; the four criteria above are checked off in a `docs/M2-STATUS.md` (same shape as M1-STATUS, created at the exit review), with the proof file linked.

### 4b.4a Scope cut (owner decision, 2026-11-26)
M2 stops after the zoom/overview item (M2-043, with pinch from M2-049). Items M2-021..023, M2-027/028, M2-031..034, M2-050, M2-052/053 and the rest of M2-048 (graph editor, copy keys) move to **M2.1 Media** (ROADMAP). E3 and E4 move with them; E1 device proof becomes field validation. Reason: ship real editing to users now; heavy-media work is a separate, measurable milestone.

**Lead decision 2026-11-27** (M2 team lead, after the exit review): not built, moved to **M2.1**: TL-05 group/ungroup + `Batch` (M2-006 rest, M2-044 rest), AU-03 detach/attach as separate ops, TL-20 replace/extend/overwrite/insert (M2-010), speed freeze/reverse/loop (M2-008 rest, TL-10 remainder), M2-049 stylus/palm rejection, PV-06 dedicated work (M2-029; edit-during-play already works through the normal op path, patches and coalesced sync of #205/#206/#212). Reason: low user value per cost for the first real-editing release; Unlink already covers moving sound separately. **Stays in M2**: TL-19 background fill (M2-003 part, M2-025; black/colour/blur, image is M2.1) and an automated export parity test (M2-030).

### 4b.5 Not in M2 (goes to an issue or a later milestone, not to this backlog)
Transitions, effects, masks, keying, nested clips, adjustment layers, compound clips, multicam (after 1.0); text and effect tracks (M3/M4: `TrackKind` only reserves them); mixer, ducking, loudness, beat detection (M3: snapping has a beat hook, no beats); voice-over recording and captions (M3); speed ramps and keyframed time remap beyond constant, reverse, freeze, loop (TL-22 here means VFR handling); HDR; hardware controllers and multi-window (UX-10/11); mobile layout polish and phone share sheet (M5); collaboration (M8); server-backed anything (XT-06b endpoint waits on ADR 0019); proxy for audio; cloud or sync storage; plugin API.

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
See [adr/README.md](adr/README.md): **name/trademark check (0012, deferred by owner: revisit before M3 public beta; blocks public launch)**, governance and funding (0014, by M3). **Decided 2026-11-22:** licence (0009: GPL-3.0-or-later apps, MIT OR Apache-2.0 engine, DCO) and reference devices (0013: owner's Windows 10 laptop (assumed i5 10th-gen, 8 GB), Mac (assumed M1, 8 GB), Galaxy S24, iPhone 14; low-end Android has no physical device: emulator for function/memory, perf scaled from the Galaxy S24 by SoC benchmark ratio and labelled "calibrated proxy") and distribution (0011: public repo, free static hosting, SignPath OSS, store fees from donations later, cost ledger in repo; PWA is the mobile app and desktop builds are unsigned until funded).
