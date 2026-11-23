# M1 "First cut" status audit

Audit of 2026-11-23 against `origin/main` at `a8c7ba1`. Nothing was built for this audit; it only reads the code, tests, docs and merged PRs, and runs the built app once headless. Legend: **done** (merged, with a test), **partial** (works, something the feature row asks for is missing), **missing**. "Device" means it needs a real phone or laptop, not the container.

**Verdict: M1 is not complete.** The vertical slice (import, trim, split, delete, undo/redo, play, export) works end to end on web and has a desktop path. What is missing is mostly outside the slice: five hardware or user proofs, two ADRs still "proposed", the perf CI job, and some rows of the P0 feature table (canvas presets, `.overcut` open/save UI, accent colours, opt-in crash reports and the network log, copy/paste/duplicate/ripple delete, history panel, numeric trim).

## 1. Feature IDs (docs/FEATURES.md rows)
| ID | Status | Evidence / what is missing |
|---|---|---|
| PM-01 New project, canvas presets, fps, resolution | **done** (canvas, new project; update 2026-11-23) | Canvas dialog (16:9, 9:16, 1:1, 4:5, 21:9, custom; 24-60 fps; 720p-4K; Match first clip default), `set_canvas` op, undoable, in the project file, used by preview and export (`docs/features/canvas.md`); New project in the app menu |
| PM-02 Import via picker, drop, paste, open-with | **partial** | Picker, drop and paste: `MediaBin.tsx`, `tests/smoke/media-bin.spec.ts` (6 tests). Desktop native import/drop: PR #56. Share sheet / "open with": not built |
| PM-03 Media bin: thumbnails, filter, search, tags, relink | **partial** | Poster thumbnails, name search, offline relink (PR #60, `offline-media.test.ts`). No tags, no codec/type filter, not measured at 10k items |
| PM-06 Autosave, crash recovery, version snapshots | **partial** | Op-log journal, OPFS / IndexedDB / Tauri folder, "Recovered unsaved changes" + Undo recovery, killed-process smoke (PR #34, `persistence.spec.ts`). Version snapshots: not built. Multi-project list: not built |
| PM-07 `.overcut` zip + JSON, documented, migrations | **partial** (open/save UI done; update 2026-11-23) | Reader/writer, migrations, fuzz target (PR #24, `docs/features/project-file.md`). Save project as / Open project in the app menu (web and desktop; `canvas.md`). The live journal is a sidecar, not in the zip (`persistence.md`); fuzz target is not run in CI |
| PM-12 Offline everywhere, installable PWA | **partial** | `sw.js`, manifest, offline fix and allow-list test (PR #54, `network.spec.ts`). No install prompt / install affordance; installability on a real phone unverified |
| TL-02 Split, trim (drag, numeric), delete, ripple delete, duplicate, copy/paste | **done** (ripple delete moved to M2) | Split, delete (lift), drag and keyboard trim: PR #35. Duplicate, copy/cut/paste, numeric timing: `timeline-clipboard.test.ts`, smoke `clipboard-history.spec.ts` |
| TL-06 Unlimited undo/redo, history panel | **done** | Undo/redo buttons and shortcuts, survives recovery (PR #19, #35, #49); history panel (jump to any step) |
| PV-01 Real-time preview, frame-accurate scrub, JKL, frame step | **partial** | Worker player, audio master clock, JKL, frame step (PR #39, #59, `preview.spec.ts`). 60 fps on the reference laptop is unproven; WebGPU path unverified on hardware; the Galaxy S24 Chrome has no WebGPU so it depends on WebGL2 (`PERFORMANCE.md`) |
| EX-01 Export MP4 (H.264) / WebM, M1: 1080p30 H.264 | **partial** | Web: streaming WebCodecs export in a Worker (PR #36, #45; WebM/VP9 2.2x realtime in the container, `export.md`). Desktop: libav H.264/AAC (commit 5d50b91, PR #56). Real-footage speed unmeasured; desktop H.264 needs a hardware encoder or the OpenH264 download (issue #57, not built); desktop WebM not built (issue #58) |
| EX-02 Presets per platform, size-targeted | **partial** | Four presets (Original, YouTube, Vertical, Small) + advanced, calibrated size estimate (PR #45, #46). Not the per-platform list (TikTok, Reels, X, WhatsApp, Discord caps) |
| EX-04 Hardware encoding, software fallback | **partial** | WebCodecs picks what the device offers (`export.md`); desktop falls back to opt-in OpenH264 which is not built. Hardware-encode speed unmeasured on any device |
| AU-01 Waveforms (M1 part) | **done** | Peaks pyramid, cache and wiring (PR #41, #48; unit `media-cache.test.ts`) |
| UX-01 Responsive layouts | **done** (device unchecked) | Phone, tablet, desktop shells; overflow checked at phone and desktop in smoke; phone top bar PR #60. Foldable / ultrawide not specifically tested |
| UX-05 Themes: dark, light, high contrast, accent colours, follows system | **partial** | Dark / light / high-contrast, system default, WCAG test (PR #32, `theme-contrast.test.ts`). No accent colour choice |
| XT-06 Privacy: no telemetry, opt-in crash reports, visible network log, no third-party scripts | **partial** | Allow-list (`config/network-allowlist.json`) + strict CSP + CI test (PR #54, `network.spec.ts`). Opt-in crash reports and the visible network log: not built (documented as future in `privacy-network.md`). CSP as a response header: issue #55 (PR #61 open) |

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
| M1-015 [S4] Native decode/encode via libav | partial | commit 5d50b91; desktop-only; no CI build (issue #52, PR #61 open); parity vs web not reported |
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
| M1-041 Desktop shell: Tauri commands, dialogs, drag-drop, `release.yml` dry run | partial | PR #56; compile-checked only (no webview in CI); desktop preview of on-disk files, WebM, OpenH264 not built (issues #57, #58); release dry run not reported |
| M1-042 Network allow-list + CSP | done | PR #54; header form: issue #55 / PR #61 |
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
| Process issues #51, #52, #55 | **needs owner** | Open `process-request`s. PR #61 (open, green) covers #52 and #55 per the board; #51 still open |

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

## 5. Gaps to close before Alpha (most important first)
1. **Device proofs** (owner, no code): 60 fps 1080p preview on the Windows laptop and the Mac; 1080p30 export speed on the S24 (and iPhone 14); then accept ADR 0003 / 0004 and update `adr/README.md`. Add an in-app preview-fps and export-speed test to `/diagnostics` so the owner can run them (today it has no end-to-end test).
2. **Activation test** (M1-044): write the script and run it with 5 first-time users; measure against 90 s. Fix split-with-no-effect feedback, the undo-removes-the-import surprise, the phone Media drawer staying open over the toolbar and the dead "soon" rail entries first.
3. **Perf CI job** (issue #51) and refresh the baseline from a CI run; merge PR #61 (#52, #55).
4. **Real-footage export and preview speed**: test with a real 1080p30 phone clip (and a long-GOP one: seek p95 200-380 ms on both devices); automatic proxy / keyframe cache for low-tier devices (calibrated A15 proxy misses the 120 ms scrub budget).
5. **Project lifecycle**: new project with canvas presets (PM-01: 21:9, custom, fps, change later), open and save a `.overcut` file from the UI (PM-07), version snapshots (PM-06).
6. ~~Editing rows left in TL-02 / TL-06~~ done; ripple delete stays M2 (FEATURES row reconciled).
7. **Desktop**: OpenH264 downloader (#57) and native WebM, preview of on-disk files, Windows drag behaviour (#58); there is no CI test that runs the desktop app and no release dry run result.
8. **Export presets** (EX-02): add TikTok / Reels / X / WhatsApp / Discord size-capped presets, or narrow the row to the four built.
9. **XT-06**: opt-in crash reports and the visible network log are required by the row; build them or move them to M2 by a docs PR.
10. **UX-05 accent colours**; **PM-02/12** share sheet / open-with and an install prompt; **PM-03** tags and filters, 10k-item check; fuzz targets (`app-media`, `app-model`) not run in CI.
11. **Docs consistency**: ROADMAP M1 lists M1 exit as "all merged and the checklist green" (plan section 4); this file is the checklist until a CI-backed one exists.
