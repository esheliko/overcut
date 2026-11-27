# Roadmap

Milestones are ordered by **risk first, then value**: the hard, uncertain parts (decode to GPU to encode on every platform) are proven before the long tail of features. Durations assume a small core team (2-4 engineers) working with Claude sessions; they are relative sizes for planning, not promises. Feature IDs refer to [FEATURES.md](FEATURES.md). Each milestone ends with a **release** (web deploys continuously; native builds from tags) and an exit checklist that must be fully green.

```
M0 Foundations ──► M1 First cut ──► M2 Real editing ──► M3 Sound & words ──► M4 Look
                        │                                                       │
                        └────────────► M5 Mobile (starts after M2, parallel) ◄──┘
                                          M6 Smart ──► M7 Ecosystem ──► M8 Together ──► M9 1.0
```

## M0 Foundations (this repository today)
**Goal**: a plan everyone can build from and a skeleton that builds, tests and deploys.
- Product, features, roadmap, architecture, plan, ADRs (this `docs/`).
- Repo from the kickoff `cross-platform-app` template: Rust workspace + WASM + React shell + Tauri shell, CI `verify`, web deploy, release workflow, work model (branch + PR, rules, hooks).
- Engine crate skeleton with the module boundaries and an empty responsive editor shell.
- **Exit**: CI green on main; web shell deployed; `npm run dev` shows the shell and a working engine handshake; ADRs 0001-0008 accepted by the owner; open decisions listed (0009 license, 0011 distribution costs, 0012 name check).

## M1 First cut (~8-10 weeks) **Alpha**
**Goal**: cut a clip and export it, on web and desktop, fast.
- **Status (2026-11-24): closed as Alpha, live on the web.** Built, merged and deployed on web, compiled on desktop; ADRs 0003/0004 accepted; budgets measured in CI (non-blocking `perf` job, PR #82); the activation test runs as an automated first-time-user proxy (`tests/smoke/activation.spec.ts`, PR #87). Hardware numbers that need real devices or people (60 fps preview on the reference laptop, phone export speed, the 5-person stopwatch test) moved to **M1 field validation**, tracked in issue #88 and required again by the M2 exit. Exit criteria amended by the M1 lead under the owner's delegation; reasons in [M1-STATUS.md](M1-STATUS.md) section 6.
- Spikes S1-S4, S7 done and their ADRs accepted (see [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)). "Done" means code merged; hardware bars count only once proven on the reference devices (plan section 4a).
- PM-01/02/03/06/07/12, TL-02/06, PV-01, EX-01/02/04, AU-01 (waveform), UX-01/05, XT-06 (no telemetry, visible network log, no third-party scripts; opt-in crash reports moved to M2 as XT-06b: they need a server endpoint, see FEATURES.md).
- One video track + one audio track; import, trim, split, delete, undo/redo, play/scrub, export 1080p30 H.264 (WebCodecs on web, native on desktop).
- **Exit** (amended 2026-11-24): the automated first-time journey (import, trim, export, save) passes on desktop and phone viewports in CI within its click and time budget; autosave survives `kill -9`; no network calls (CI checks); budgets measured in CI; ADRs for S1-S4, S7 accepted. **Field validation** (carried into M2, does not block M1): the 5-person activation test < 90 s, 1080p preview 60 fps on the reference laptop, export >= 1x realtime on the reference phone browser.

## M2 Real editing (~8-10 weeks)
**Goal**: the timeline of a serious editor.
- TL-01/03/04/05/07/08/09/10/12/13/14/19/20/22, PM-04/05/08/09, PV-02/06, EX-03/05, UX-02/03/04, AU-03.
- Multi-track, snapping, ripple/roll/slip/slide, keyframes with easing, transform and PiP, speed (constant/reverse/freeze), proxies, VFR handling, export queue, shortcut sets, command palette.
- **M2 backlog**: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) section 4b (items M2-001 to M2-053, lanes, spikes S9-S12, how each exit criterion is measured, "Not in M2" list).
- **Status (2026-11-27): engineering exit met, scope cut to "real editing" for users (owner decision 2026-11-26); details in [M2-STATUS.md](M2-STATUS.md).** Built on `m2`: multi-track, snapping, ripple/roll/slip/slide, transform and PiP (inspector + on-canvas handles), keyframes with easing, constant speed with pitch kept, markers and in/out range, shortcut presets and command palette, project library, zoom 10 s to 10 h with overview and pinch. E2 (10k property sequences) and E1 (1000 clips x 20 tracks, container bench) pass. **Kept in M2 (lead decision 2026-11-27) and built**: background fill (TL-19: black, colour, blur) and an automated multi-track export parity test (M2-030). **Moved to M2.1** (see below): group/ungroup and Batch (TL-05), detach/attach audio as separate ops (AU-03), replace/extend/overwrite/insert (TL-20), speed freeze/reverse/loop (TL-10 remainder), stylus/palm rejection (M2-049), dedicated playback-while-editing work (PV-06). Moved to **M2.1 Media** below: proxies (PM-05, PV-02), VFR handling (TL-22, PM-04), export queue (EX-03), GIF/WebP/APNG/stills (EX-05), format matrix (PM-04), collect/consolidate (PM-09), opt-in crash reports (XT-06b), freeze/reverse speed, keyframe graph editor.
- **Exit** (amended 2026-11-26): undo/redo property tests pass 10k random sequences (**met**, `npm run test:e2`); 1000-clip, 20-track timeline pans and zooms at 60 fps on desktop in the container bench (**met**; device proof is field validation); every M2 flow passes the human QA sweep (`docs/m2/ux-audit.md`) with no open P0/P1 and has a smoke step; export matches preview for multi-track, PiP, keyframes and speed (checked with ffprobe). **Field validation** (owner's devices, does not block M2): 60 fps timeline on the reference laptop and phone, plus the M1 field items.

## M2.1 Media (~4-6 weeks, after M2)
**Goal**: heavy media, fast and reliable.
- PM-04/05, PV-02, TL-22, EX-03/05, PM-09, XT-06b (local part), speed freeze/reverse/loop, keyframe graph editor; **moved from M2 by the lead on 2026-11-27**: TL-05 group/ungroup + Batch, AU-03 detach/attach, TL-20 replace/extend/overwrite/insert, M2-049 stylus/palm rejection, PV-06 dedicated work (edit-during-play already works through the normal op path); background image fill (TL-19 remainder); plan items M2-020 (ADR 0016 done), M2-021..023, M2-027/028, M2-031..034, M2-050, M2-052/053.
- **Carried in (field validation, not done in M2)**: Mac and iPhone 14 device numbers, the 5-person activation test (owner cannot arrange them now; the automated proxy `tests/smoke/activation.spec.ts` passes in CI). The Windows laptop and Galaxy S24 numbers of 2026-11-27 show export 0.58x on the laptop and playback 11.2 fps plus an export crash on the S24 (M2-STATUS section 4; fixes in progress, owner re-runs; issue #88). E3 and E4 live here.
- **Exit**: a 30 min 4K project edits smoothly with proxies on the reference laptop; A/V sync drift < 1 frame over 2 h; a killed export resumes; formats outside the support matrix get a clear message.

## M3 Sound and words (~8 weeks) **Public beta**
**Goal**: audio and text at CapCut level, including auto captions.
- AU-01/02/04-09/12, TX-01..07/10, AI-01, PM-10, PV-03/05, EX-07/08, UX-08/13.
- Mixer, ducking, noise reduction, loudness, beats; text animations; captions from speech on-device with RTL/CJK shaping; recording; onboarding.
- **Exit**: auto-captions on a 10 min video in < 3 min on the reference laptop, word error rate within 10% of the model's published figure; the first-time-user test "add captions and export" under 3 min; accessibility smoke audit (keyboard-only) of every M1-M3 flow.

## M4 Look (~8 weeks)
**Goal**: effects, transitions, color and compositing.
- EF-01..08/20/21, TL-11/15/16/17/18, PV-04, EX-06.
- Effect/transition format (EF-20) with 40+ transitions, 60+ effects, 50+ looks, LUTs, color tools, masks, chroma key, stabilization, tracking, nested clips, adjustment layers.
- **Exit**: golden-frame tests for every built-in effect on WebGPU, WebGL2 and native backends within tolerance; 4 stacked effects at 1080p keep 60 fps on the reference laptop and 30 fps on the reference phone.

## M5 Mobile (~8 weeks, in parallel with M3/M4 once M2 lands) **Mobile beta**
**Goal**: the same editor as an app on iOS and Android with phone-grade UX.
- Tauri mobile targets initialised; store builds; XT-07; UX-02/12 polished; phone layouts for every M1-M4 flow; share sheet; background export rules; memory management on 3-4 GB devices.
- **Exit**: all M1-M4 smoke flows pass on the device lab (2 iOS, 3 Android incl. one low-end); 1080p30 export of a 5 min project completes in <= 5 min on the low-end Android reference; install size < 80 MB (models excluded).

## M6 Smart (~10 weeks)
**Goal**: the on-device AI toolbox.
- AI-02..12, TX-11/12, EF-09..11, AU-11, TL-24.
- Model manager (download, verify, cache, delete, quality tiers), background removal, smart reframe, transcript editing, silence/filler removal, TTS, translation, interpolation, upscaling, scene detection.
- **Exit**: each AI tool has a quality bar (documented test set) and a speed bar per device tier; works offline after download; no tool uploads anything (CI network allow-list test).

## M7 Ecosystem (~8 weeks)
**Goal**: templates, plugins, content, automation.
- XT-01/02, EX-09/10, PM-11/14, TX-08/09, UX-09, AU-10, TL-23.
- Public plugin API and docs, template packs and gallery, free media library index, CLI, scripting, interchange formats.
- **Exit**: three third-party-style plugins built only from the public API; a template round-trips (export, apply to other media); `overcut render` output is byte-identical to the app's export for the same project and settings (golden test).

## M8 Together (optional, ~8 weeks)
**Goal**: collaboration and sync without a media server.
- XT-03/04/05, PM-13.
- CRDT-based operations over WebRTC (signaling via a tiny stateless relay or QR/manual exchange), bring-your-own-storage sync, version history.
- **Exit**: two editors converge after offline divergence in 1000 randomized sessions; a project syncs through a plain folder; nothing in the product requires this to be enabled.

## M9 1.0 (~8 weeks) **Release**
**Goal**: trustworthy, accessible, global.
- UX-06/07 completed, XT-07/08 audited, performance and reliability gates, docs, website, store listings, long-run soak tests, license and compliance review, security review of demuxers and plugin sandbox.
- **Exit**: every P0 and P1 feature in FEATURES.md shipped or explicitly moved with a recorded reason; all budgets in `PERFORMANCE.md` met on all reference devices; WCAG 2.2 AA audit passed; 25+ languages; 99.5% crash-free in beta; zero open data-loss bugs.

## After 1.0 (candidates, not commitments)
Multicam (TL-21), HDR (PV-07), hardware controllers (UX-11), multi-window (UX-10), object removal (AI-13), more codecs/containers, ProRes RAW, plugin marketplace, deeper audio (multi-band, spatial), scripting UI, tablet pencil-first features.

## How the roadmap changes
It is a document in this repo: a change is a PR with the reason. Scope moves between milestones only with the exit criteria updated. A milestone is never "done" while its exit checklist has an unchecked item; the item is fixed, or the criterion is changed in a PR that says why.
