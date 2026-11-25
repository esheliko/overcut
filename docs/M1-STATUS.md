# M1 "First cut" status audit

Audit of 2026-11-23 against `origin/main` at `a8c7ba1`; reconciled 2026-11-24 with `main` at `314248c` (PRs up to #79). Nothing was built for this audit; it only reads the code, tests, docs and merged PRs, and runs the built app once headless. Legend: **done** (merged, with a test), **partial** (works, something the feature row asks for is missing), **missing**. "Device" means it needs a real phone or laptop, not the container.

**Verdict (2026-11-24, closing): M1 is closed as Alpha and live on the web.** The code was complete; the remaining proofs were resolved by the M1 lead under the owner's delegation (section 6): budgets measured in CI (PR #82), an automated first-time-user activation proxy (PR #87), ADRs 0003/0004 accepted, and the device/people numbers moved to field validation (issue #88, required by the M2 exit). Sections 1-5 are the audit as it stood before closing.

## 1. Feature IDs (docs/FEATURES.md rows)
| ID | Status | Evidence / what is missing |
|---|---|---|
| PM-01 New project, canvas presets, fps, resolution | **done** (canvas, new project; update 2026-11-23) | Canvas dialog (16:9, 9:16, 1:1, 4:5, 21:9, custom; 24-60 fps; 720p-4K; Match first clip default), `set_canvas` op, undoable, in the project file, used by preview and export (`docs/features/canvas.md`); New project in the app menu |
| PM-02 Import via picker, drop, paste, open-with | **done** (device unchecked) | Picker, drop and paste: `MediaBin.tsx`, `tests/smoke/media-bin.spec.ts` (6 tests). Desktop native import/drop: PR #56. Share sheet / "open with": **done** (PR #78): PWA `file_handlers` + `share_target` (service worker, no network), desktop file associations + launch files; per-platform support in `docs/features/open-with.md`. **done in code**; unverified on real devices/OS; second launch while running needs `tauri-plugin-single-instance` (follow-up) |
| PM-03 Media bin: thumbnails, filter, search, tags, relink | **done** | Poster thumbnails, search (names and tags), offline relink (PR #60), type filter, sort, undoable tags (`set_media_tags`), windowed list measured at 10k items (`media-bin.md`) |
| PM-06 Autosave, crash recovery, version snapshots, projects list | **done** | Op-log journal, OPFS / IndexedDB / Tauri folder, "Recovered unsaved changes" + Undo recovery, killed-process smoke (PR #34, `persistence.spec.ts`). Version snapshots: done (`versions.md`). Multi-project list: open, rename, duplicate, delete local projects (PR #79, `projects.md`) |
| PM-07 `.overcut` zip + JSON, documented, migrations | **partial** (open/save UI done; update 2026-11-23) | Reader/writer, migrations, fuzz target (PR #24, `docs/features/project-file.md`). Save project as / Open project in the app menu (web and desktop; `canvas.md`). The live journal is a sidecar, not in the zip (`persistence.md`); fuzz target is not run in CI |
| PM-12 Offline everywhere, installable PWA | **partial** | `sw.js`, manifest, offline fix and allow-list test (PR #54, `network.spec.ts`). Install affordance: menu "Install app" (`beforeinstallprompt`) and an iOS Add-to-Home-Screen how-to (PR #69). Installability on a real phone unverified |
| TL-02 Split, trim (drag, numeric), delete, ripple delete, duplicate, copy/paste | **done** (ripple delete moved to M2) | Split, delete (lift), drag and keyboard trim: PR #35. Duplicate, copy/cut/paste, numeric timing: `timeline-clipboard.test.ts`, smoke `clipboard-history.spec.ts` |
| TL-06 Unlimited undo/redo, history panel | **done** | Undo/redo buttons and shortcuts, survives recovery (PR #19, #35, #49); history panel (jump to any step) |
| PV-01 Real-time preview, frame-accurate scrub, JKL, frame step | **partial** | Worker player, audio master clock, JKL, frame step (PR #39, #59, `preview.spec.ts`). 60 fps on the reference laptop is unproven; WebGPU path unverified on hardware; the Galaxy S24 Chrome has no WebGPU so it depends on WebGL2 (`PERFORMANCE.md`) |
| EX-01 Export MP4 (H.264) / WebM, M1: 1080p30 H.264 | **partial** | Web: streaming WebCodecs export in a Worker (PR #36, #45; WebM/VP9 2.2x realtime in the container, `export.md`). Desktop: libav H.264/AAC (commit 5d50b91, PR #56). Real-footage speed unmeasured; desktop H.264 needs a hardware encoder or the OpenH264 download (PR #74, pins empty: issue #72); desktop WebM built (PR #74) |
| EX-02 Presets per platform, size-targeted | **done** | Presets Original, YouTube, 9:16 (TikTok/Reels/Shorts), X, Facebook (feed + Reels), WhatsApp, Discord (size caps, bitrate fitted), Small + advanced, calibrated estimate (PR #45, #46, #69, this update). Limits re-checked 2026-11-24 against excerpts of the official help pages (the container cannot open them directly); per-row source and confirmed/unconfirmed in the `export.md` table. WhatsApp's current figure is contradictory on its own pages |
| EX-04 Hardware encoding, software fallback | **partial** | WebCodecs picks what the device offers (`export.md`); desktop falls back to the opt-in OpenH264 download (built, PR #74; pins empty, issue #72). Hardware-encode speed unmeasured on any device |
| AU-01 Waveforms (M1 part) | **done** | Peaks pyramid, cache and wiring (PR #41, #48; unit `media-cache.test.ts`) |
| UX-01 Responsive layouts | **done** (device unchecked) | Phone, tablet, desktop shells; overflow checked at phone and desktop in smoke; phone top bar PR #60. Foldable / ultrawide not specifically tested |
| UX-05 Themes: dark, light, high contrast, accent colours, follows system | **done** | Dark / light / high-contrast, system default, 7 accent colours in the menu (WCAG-tested per theme x accent, PR #69) |
| XT-06 Privacy: no telemetry, opt-in crash reports, visible network log, no third-party scripts | **done** (crash reports: M2) | Allow-list (`config/network-allowlist.json`) + strict CSP + CI test (PR #54, `network.spec.ts`). Visible network log (PR #73, #75, #78; Privacy menu and `/diagnostics`, `recordNetworkEvent` hook for desktop downloads; smoke asserts no foreign host). Opt-in crash reports moved to M2 as XT-06b (needs an optional endpoint with a local fallback; docs PR). Error screen with local diagnostics report (PR #78). CSP as a response header: issue #55, merged in PR #61 |

## 2. M1 backlog (docs/IMPLEMENTATION_PLAN.md section 4)
| Item | Status | Evidence |
|---|---|---|
| M1-001 Time/Rational | done | PR #4 |
| M1-002 app-model + TS types | done | commit 2934420, `model-types.test.ts` |
| M1-003 [S7] ops, history, journal, property tests | done | PR #19; ADR 0006 accepted |
| M1-004 evaluate(t) | done | PR #25, `docs/features/evaluate.md` |
| M1-005 `.overcut` + migrations + fuzz | done | PR #24 (fuzz not in CI; no open/save UI, see PM-07) |
| M1-006 Capabilities probe + debug panel | done | PR #21, `/diagnostics` |
| M1-010 [S1] WebCodecs decode to texture | partial | PR a14a396, code merged; hardware bars measured on laptop and S24 (decode, seek), ADR 0004 still "proposed"; Mac/iPhone not measured |
| M1-011 Source/Decoder traits, frame cache | done | commit c036345 |
| M1-012 MP4/MOV + WebM demux, probe, fuzz | done | PR #18, #23 |
| M1-013 Waveform extraction + cache | done | PR #41, #48 |
| M1-014 [S3] WebCodecs encode + mux, sync test | partial | PR #29 (A/V sync verified in the container); real-device speed and drift unmeasured |
| M1-015 [S4] Native decode/encode via libav | partial | commit 5d50b91; desktop-only; CI native-media job merged in PR #61 (issue #52 part 1; part 2 open); parity vs web not reported |
| M1-020 [S2] wgpu 3 layers on WebGPU/WebGL2 + golden frames | partial | commit 3cf70ab, PR #44; WebGL2 verified headless; WebGPU not on hardware; ADR 0003 accepted for the browser path but `adr/README.md` still lists it "proposed" |
| M1-021 Colour pipeline v0 | done | commit b542a41 |
| M1-022 Export render path, deterministic output | done | PR #36, #44 |
| M1-030 Editor shell, five form-factor profiles, container-query tests | partial | PR #10, #60; phone/desktop smoke; no container-query test, tablet/foldable/ultrawide untested |
| M1-031 [S8] Canvas timeline + virtualization bench | done | PR #30; `perf` timeline bench (container, 4x throttle) |
| M1-032 Media bin import, thumbnails | done | PR #37 |
| M1-033 Preview, transport, JKL, scrub, step, audio sync | done | PR #39, #59 |
| M1-034 Timeline interactions | done | PR #35, #49 (no duplicate / copy / numeric trim, see TL-02) |
| M1-035 Export dialog: presets, progress, cancel, save/share | done | PR #45, #46, #47 |
| M1-036 Theme tokens, i18n, a11y primitives | done | PR #32 (English only) |
| M1-040 Persistence, autosave, recovery, `kill -9` test | done | PR #34 |
| M1-041 Desktop shell: Tauri commands, dialogs, drag-drop, `release.yml` dry run | partial | PR #56, #74; compile-checked only (no webview in CI); preview of on-disk files, native WebM and the opt-in OpenH264 downloader built (PR #74; download pins still empty, issue #72); release dry run not reported |
| M1-042 Network allow-list + CSP | done | PR #54; header form: issue #55, PR #61 (merged) |
| M1-043 Perf harness, device definitions, budgets | partial | PR 8f989ef (`tests/perf`, `PERFORMANCE.md`, device files); no CI job (issue #51) |
| M1-044 Activation script + test with 5 users | partial | Script and pass bar: [ACTIVATION-TEST.md](ACTIVATION-TEST.md); the test with 5 users is not run yet (owner) |

## 3. Exit criteria (ROADMAP M1)
| Criterion | Status | Evidence |
|---|---|---|
| Spikes S1-S4, S7 done, ADRs accepted | **not met** | S7 / ADR 0006 accepted. ADR 0003 (S2) accepted only for the browser path in its own header; ADR 0004 (S1, S3, S4) still "proposed" in the file and in `adr/README.md`. Needs owner |
| Activation test (import, trim, export) < 90 s for a first-time user | **needs owner** | No test run, no script (M1-044). My scripted pass of import, split, play and export took about 8 s end to end with a 1 s clip, which only shows the path is short |
| 1080p preview 60 fps on the reference laptop | **needs owner** | Decode 720 fps and 11 layers at 60 fps on the owner's Windows laptop (`tests/perf/devices/windows-laptop-uhd630.json`) but no end-to-end preview fps on any device; Mac not measured |
| Export >= 1x realtime on the reference phone browser | **needs owner** | No in-app export run on the S24 or iPhone 14; container software encode of 1080p was 0.16x for H.264 (`PERFORMANCE.md`), VP9 2.2x. Low-phone seek budget fails on the calibrated proxy (195 ms vs 120 ms) |
| Autosave survives `kill -9` | **met** | `tests/smoke/persistence.spec.ts` (killed worker, reload restores, undo history intact) in CI |
| No network calls (CI checks) | **met** | `tests/smoke/network.spec.ts`, allow-list `hosts: []`, strict CSP meta (PR #54) |
| Budgets measured in CI | **not met** | Harness exists; the CI job is issue #51 (open, process session). Baseline is a container number |
| Process issues #14, #17 | done | closed by PR #31 |
| Process issues #51, #52, #55 | **partly done** | PR #61 merged (CSP response header, native-media CI job: #55 and #52 part 1). #51 (perf CI job) and #52 part 2 still open (process session) |

## 4. Spot check of the real flow
Built the app (`npm run build`, wasm-bindgen-cli 0.2.130) and served it with `vite preview`; headless Chromium with no GPU, once at 1280x800 and once at 390x844 touch, using the repo fixture `crates/media/tests/fixtures/h264_aac.mp4` (160x120, 1 s).
- **Works**: engine starts; import adds the clip to the timeline with no questions (2 clips on V1 and A1); keyboard split at the playhead gives 4 clips; undo and redo restore the exact counts; play advances the timecode; Export opens, defaults to the whole project (160x120, 30 fps), finishes and offers Save (27.6 KB file) at both sizes. No console errors, no horizontal overflow at either width.
- **Confusing for a first-time user**:
  1. Pressing Split with the playhead at the start (the state right after import) does nothing and says nothing; a first user sees a dead button.
  2. The first Undo after an import removes the whole import (clips and timeline go to 0), because import is one undoable operation; there is no hint of that.
  3. The preview was black in this container (no GPU), so the picture check is not covered here; the smoke suite and the owner devices must confirm it.
  4. The canvas shape picker looks like a project setting but only changes the preview box (see PM-01).
  5. Several left-rail entries (Audio, Text, Captions, Effects, Transitions, Filters, Stickers) and the right-hand "Details" panel are present with no function ("soon"), on desktop; a first user can click into empty promises.
  6. On the phone the Media drawer stays open after the first import and covers the Split / Undo toolbar until the Media tab is tapped again (Playwright could not click Split until I closed it).
  7. A 1 s clip at the default zoom occupies about 40 px of a 30 s ruler (see the desktop screenshot logic: the ruler starts at 30 s); the keyboard shortcut `0` fits, I did not look for a visible Fit button.
- **Not covered**: a real 1080p file, a real GPU, the desktop app, a phone browser, touch trim drag (I did not drive it).

## 5. What is really left (2026-11-24)
Owner / device proofs (no code, needs real hardware or people):
1. **Preview fps**: 1080p 60 fps end to end on the Windows laptop and the Mac (PV-01).
2. **Export speed**: 1080p30 in-app on the S24 and iPhone 14 (EX-01, M1-014; low-phone seek budget on the calibrated proxy is 195 ms vs 120 ms).
3. **Scrub strip on a real long-GOP phone clip** on the S24 (`docs/features/preview.md` "Smooth scrubbing"), and the first real 1080p30 phone clip through export.
4. **Activation test with 5 first-time users** against 90 s (script and pass bar: [ACTIVATION-TEST.md](ACTIVATION-TEST.md), M1-044).
5. **ADR 0003 / 0004 acceptance** (and `adr/README.md`) after proofs 1 to 3.
6. Installability on a real phone, open-with / share target per OS (`open-with.md`), desktop shell on real Windows/macOS/Linux.

Process session (CI and process files, not feature work):
7. **Perf CI job** (issue #51) and a baseline refreshed from CI; **fuzz targets** (`app-media`, `app-model`, project file) run in CI.
8. **Issue #52 part 2** (native-media CI beyond the compile check); a release dry run result.

Small code follow-ups:
9. **OpenH264 download pins** (issue #72): `PINS` in `openh264.rs` are empty, so the opt-in download cannot run yet.
10. Single-instance second launch for open-with (`tauri-plugin-single-instance`); opt-in crash reports are XT-06b (M2); ripple delete is M2.

## 6. Closing decisions (2026-11-24, M1 lead, owner delegation)
| Was | Now | Why |
|---|---|---|
| Activation test with 5 people < 90 s | Automated first-time journey in CI (`tests/smoke/activation.spec.ts`: labelled controls only, desktop and phone, <= 12 clicks, < 60 s scripted; 10 clicks desktop, 11 phone at merge); 5-person test is field validation (issue #88) | The owner asked for cheap checks instead of people tests; the proxy catches regressions in the path length on every PR |
| 1080p 60 fps preview on the reference laptop; phone export >= 1x realtime | Field validation (issue #88), required by the M2 exit | Needs real hardware; decode (720 fps) and 11-layer compositing at 60 fps on the Windows laptop already measured; phones encode with hardware WebCodecs, which the container cannot measure (software VP9 there) |
| Budgets measured in CI | **met**: non-blocking `perf` job and 60 s `fuzz` job (PR #82); runner numbers vary +/-20-70% run to run, so it warns only | Trend tracking, not device budgets |
| ADR 0003 / 0004 proposed | **accepted** | Both paths are built and tested with fallbacks (WebGL2, OpenH264/hardware); a bad device number changes defaults, not the decision |
| TL-05 linked audio/video in M2 | Minimal slice pulled into M1: picture and sound from one import select, trim, split, move and delete together, with Unlink (PR #90) | The first-time audit (PR #87) found cutting the front took two edits and left sound over black; that is the core M1 task |
| First-run polish | Any clip edge trims with a mouse; cutting the front closes the gap; developer engine chip moved off the top bar | PR #87 and PR #90 |
