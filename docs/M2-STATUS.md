# M2 "Real editing" exit status

Written 2026-11-27 (IST) against `m2` at `6a21494` (PR #215), integration PR #120 (m2 -> main, owner's review pending; `main` stays frozen). Shape copied from [M1-STATUS.md](M1-STATUS.md). Legend: **done** (merged in `m2` with a test), **partial**, **missing** (planned for M2, not built), **M2.1** (moved by the owner's scope cut of 2026-11-26, [plan 4b.4a](IMPLEMENTATION_PLAN.md)). Every claim below was checked against the code on `m2`, not only against PR titles. "Container" numbers are calibrated estimates, not device proofs.

**Verdict: the engineering exit is met; the product scope is not 100% of the ROADMAP row.** E1 and E2 pass. Background fill (TL-19) and the automated export parity test (M2-030) are **built** (`docs/features/background.md`); link/group/detach-attach beyond the M1 link (TL-05 / AU-03), replace/extend/overwrite (TL-20), speed freeze/reverse/loop, stylus/palm rejection and a dedicated playback-while-editing step (PV-06) moved to M2.1 by the lead's decision of 2026-11-27 (section 3). Field validation (section 4) is outside the engineering exit.

## 1. Exit criteria (ROADMAP M2, amended 2026-11-26)
| Criterion | Status | Evidence |
|---|---|---|
| **E2** undo/redo property tests pass 10k random sequences | **met** | `PROPTEST_CASES=10000 cargo test -p app-timeline --release` (`npm run test:e2`) on `m2` @ `6a21494`: **88 passed, 0 failed**; every property ran at 10,000 cases (the env var is the proptest default); test time 6.4 s, whole run 2 min 04 s including the release build (4 shared vCPU container). Covers every op in the S7 generator (M2-011, PR #172). CI runs 256 cases per `verify` |
| **E1** 1000 clips x 20 tracks pan/zoom at 60 fps on desktop | **met in the container** (device proof = field validation) | `tests/perf/timeline-bench.mjs` on a fresh `npm run build` (container, headless Chromium, no GPU), table below |
| Every M2 flow passes the human QA sweep with no open P0/P1 and has a smoke step | **met** at round 9 (`docs/m2/ux-audit.md`: "no P0"; the one P1, edit latency P-4, fixed by PRs #205/#212); **W5's final audit is still running** and owns the last word | Smoke specs per flow: `tracks`, `lanes`, `tl-tools`, `inspector` (transform, keyframes), `markers`, `speed`, `zoom-overview`, `palette`, `shortcuts`, `project-library`, `activation` |
| Export matches preview for multi-track, PiP, keyframes, speed (ffprobe) | **met, automated** | `tests/smoke/export-parity.spec.ts` (runs in `verify`, no ffprobe): V1 at 2x + keyframed, 70%-opaque V2 + blur background, exported to VP9 WebM and decoded again; frames 2, 7, 12 of 15 match the preview's frames (mean difference 3 vs >= 13 for a different frame), exact length (15 frames, 0.5 s). It found and fixed a real export bug (two layers reading one media released the first picture before it was drawn). Also audit-checked by hand with ffprobe in rounds 5, 6 and 8 |
| Field validation (owner's devices) | **pending**, does not block M2 | section 4 |

**E1 numbers** (container (calibrated estimate); 1000 clips x 20 tracks; scripted pan, zoom and pan+zoom; median fps over the run):
| Viewport | pan | zoom | pan+zoom | p95 frame | Bar |
|---|---|---|---|---|---|
| Desktop 1280x800, 1x | 60.0 | 60.0 | 59.8 | 16.7 ms | 60 fps: met |
| Desktop 1280x800, 4x CPU throttle | 27.9 | 29.4 | 25.4 | 50-67 ms | trend only (laptop bar 60 is for real hardware) |
| Phone 390x844 dpr3, 4x CPU throttle | 28.5 | 35.7 | 30.3 | 33-50 ms | 30 fps throttled phone: **met** for zoom and pan+zoom, pan 28.5 is 1.5 fps under the bar |

Drag input-to-paint (same bench): desktop 1x single clip p50 6.7 / p95 8.3 ms, 1000 selected p50 2.1 / p95 3.1 ms; 4x throttle p95 36-42 ms; phone 4x p95 31-43 ms.

**Edit latency** (`tests/perf/edit-latency.mjs`, `?sample=2h` = 2300 clips, median of 15 splits, same build; container (calibrated estimate)):
| | split commit | key to paint | undo | redo |
|---|---|---|---|---|
| 1x | 6.6 ms | 20.7 ms | 24.2 ms | 19.3 ms |
| 4x CPU throttle | 21.4 ms | 75.7 ms | 77.5 ms | 74.6 ms |

PR #212 reported commit 3.1 ms at 1x and key-to-paint 49.5 ms at 4x on its own run: this run is slower on both (shared container, run-to-run noise of 2x is normal here), so read the order of magnitude, not the digit. The ADR 0020 bar "edit commit < 16 ms at 1x on 2300 clips" holds in both runs; at 4x the key-to-paint of ~76 ms is above one frame and stays a field-validation item on the laptop and the S24.

## 2. M2 backlog (IMPLEMENTATION_PLAN 4b.2)
| Item | Status | Evidence |
|---|---|---|
| M2-001 [S9] keyframe model | done | ADR 0015 accepted; `crates/model/src/{anim,curve}.rs`. PR #83 was closed unmerged against `main`; the branch reached `m2` by a direct branch merge |
| M2-002 multi-track model + ops | done | #124 (schema v2, ABI 2) |
| M2-003 clip transform, crop, flip, opacity, fit | **partial** | #140 (schema v3, ABI 3). **Background fill (blur, colour, gradient, image) is not in the model**: no `background` field exists in `crates/model` |
| M2-004 keyframe ops + evaluation | done | #161 (SetKeyframe/MoveKeyframe/DeleteKeyframe/SetEasing) |
| M2-005 ripple, roll, slip, slide, ripple delete, gap close | done | #128 (engine), #152 (UI) |
| M2-006 link, group, multi-op, detach/attach audio | **partial** | `SetLink` (from M1 PR #90) and Unlink only. **No Group/Ungroup, no `Batch` op, no DetachAudio/AttachAudio** in `op.rs`; multi-select edits are sent as several ops |
| M2-007 markers, chapters, in/out, loop | done | #174 (schema 4, ABI 4), UI #179 |
| M2-008 speed (constant, reverse, freeze, loop) | **partial: constant only** | #177 (`SetClipSpeed`), UI #181, audio #180. Freeze and reverse moved to M2.1 (ROADMAP); freeze, reverse and loop are not built |
| M2-009 snapping engine | done | #135 (`crates/timeline/src/snap.rs`), UI in #133, #194 |
| M2-010 replace, extend, overwrite, insert-at-position | **missing** | no such ops in `op.rs`; not in the 4b.4a cut list |
| M2-011 E2 gate | done | #172 |
| M2-020 [S10] proxy format | spike only | ADR 0016 proposed; code on `m2` via a branch merge (PR #85 closed unmerged against `main`); the proxy job itself (M2-027) is M2.1 |
| M2-021 [S11], M2-022 [S12], M2-023 | **M2.1** | ADR 0017 / 0018 have no file yet |
| M2-024 compositor: transform, crop, flip, opacity, stacking | done | #148 |
| M2-025 background fill render | **missing** | depends on the missing model part of M2-003; not in the cut list |
| M2-026 pitch-keeping speed audio | done | #180 (WSOLA, preview + export) |
| M2-027, M2-028 proxy job, adaptive preview | **M2.1** | |
| M2-029 playback while editing (PV-06) | **partial** | no dedicated item or smoke step; edit latency and preview sync work in #205/#206/#212 (patches, coalesced sync) make edits during play cheap, but "no dropped audio during a drag on a 20-track project" is not measured |
| M2-030 export parity on multi-track | **done** | `tests/smoke/export-parity.spec.ts` (section 1); chapters in MP4 not verified |
| M2-031..034 queue, GIF/WebP/APNG/stills, format matrix, E3/E4 fixtures | **M2.1** | stills import/preview exists from M1 |
| M2-040 command and shortcut registry | done | #86 |
| M2-041 command palette | done | `apps/web/src/commands/Palette.tsx` (#169, #178), `palette.spec.ts` |
| M2-042 multi-track timeline view | done | #147, #154 (cross-track move) |
| M2-043 zoom 10 s to 10 h, overview, pinch | done | #195 |
| M2-044 selection and linking UI | **partial** | multi-select, marquee, linked move/trim/delete work; no group, detach or attach actions (see M2-006) |
| M2-045 ripple/roll/slip/slide UI | done | #152 |
| M2-046 snapping, markers, range UI | done | #179, #133, #194 |
| M2-047 inspector and on-canvas transform | done | #153, #158 (speed tab #181) |
| M2-048 keyframe UI | **partial** | diamonds, previous/next, easing picker: #168, #170. Graph editor and copy keys: **M2.1** |
| M2-049 touch, stylus, trackpad layer | **partial** | pinch with two-finger pan (#195), press-and-hold (#133), touch pan; no stylus/palm-rejection layer |
| M2-050, M2-052, M2-053 | **M2.1** | export queue UI, collect/consolidate, local crash report |
| M2-051 project library | done | #157, #204, #210 |

**ROADMAP M2 features -> items**
| Feature | Status | Items |
|---|---|---|
| TL-01 / TL-08 tracks | done | 002, 042 |
| TL-03 snapping | done | 009, 046 |
| TL-04 ripple/roll/slip/slide | done | 005, 045 |
| TL-05 link/group | **partial** (link only; group/Batch M2.1) | 006, 044 |
| TL-07 markers, ranges | done | 007, 046 |
| TL-09 zoom | done | 043 |
| TL-10 speed | **partial** (constant) | 008, 026 |
| TL-12 keyframes | **partial** (no graph editor) | 004, 048 |
| TL-13 / TL-14 transform, PiP | done | 003, 024, 047 |
| TL-19 background fill | done (black / colour / blur; image is M2.1) | 003 (part), 025 |
| TL-20 replace/extend/overwrite | **partial** (ripple delete and gap close only; rest M2.1) | 005, 010 |
| TL-22 VFR, PM-04 formats, PM-05 proxies, PM-09 collect, EX-03 queue, EX-05 formats, PV-02 adaptive preview | **M2.1** | 4b.4a |
| PM-08 project library | done | 051 |
| PV-06 playback while editing | **partial** (no dedicated work; M2.1) | 029 |
| UX-02 touch | **partial** | 043, 049 |
| UX-03 / UX-04 shortcuts, palette | done | 040, 041 |
| AU-03 detach/attach audio | **M2.1** (link/unlink only in M2) | 006 |

## 3. Claimed-but-missing: lead decision 2026-11-27
Decided by the M2 lead (no longer open for the owner; the owner can still overrule in the #120 review).
| Item | Decision |
|---|---|
| TL-19 background fill (M2-003 part, M2-025) | **stays in M2, built** (black / colour / blur, per sequence; `docs/features/background.md`). Image background: M2.1 |
| Automated export parity test (M2-030) | **stays in M2, built** (`tests/smoke/export-parity.spec.ts`) |
| TL-05 group/ungroup + Batch (M2-006 rest, M2-044 rest) | **moved to M2.1** |
| AU-03 detach/attach audio as separate ops | **moved to M2.1** (Unlink already covers moving sound separately) |
| TL-20 replace/extend/overwrite/insert (M2-010) | **moved to M2.1** |
| TL-10 remainder: speed freeze/reverse/loop (M2-008 rest) | **moved to M2.1** |
| M2-049 stylus / palm rejection | **moved to M2.1** |
| PV-06 playback while editing (M2-029) | **no dedicated work**; edit-during-play works through the normal op path (patches and coalesced sync, #205/#206/#212); the "no dropped audio during a drag on 20 tracks" measurement moves to M2.1 |
Reason for the moves: low user value per cost for the first real-editing release.

## 4. Field validation (owner's devices; does not block the M2 merge)
| Item | State |
|---|---|
| Windows laptop (Intel UHD 630, WebGPU) | **numbers in, one FAIL** (see below) |
| Android (Galaxy S24, WebGL2) | **numbers in, two FAILs, one P0** (see below) |
| Mac and iPhone 14 | **carried to M2.1** (owner cannot arrange them now) |
| 5-person activation test (`ACTIVATION-TEST.md`) | **carried to M2.1**; the automated proxy `tests/smoke/activation.spec.ts` passes in CI on every `verify` |
| E3 (30 min 4K with proxies), E4 (A/V drift < 1 frame over 2 h) | **moved to M2.1** with the proxy and drift work (4b.4a) |

**Device numbers 2026-11-27** (owner's devices, Chrome 158, `m2` preview; fixes are in progress, the owner re-runs afterwards; these are open, not pass):
| Device | Check | Result | State |
|---|---|---|---|
| Windows laptop | Playback 3x 1080p30 | 30 fps, 0 dropped, p95 late 14 ms | PASS |
| Windows laptop | Export | 0.58x realtime (bar >= 1x) | **FAIL**, fix in progress (W7) |
| Windows laptop | Seek, GOP 30 | p50 60 ms | recorded |
| Galaxy S24 | Playback | 11.2 fps, 50 dropped, 21 stalls | **FAIL**, fix in progress (W7: the upload path picks the CPU) |
| Galaxy S24 | Export | export worker crashed | **FAIL, P0**, fix in progress (W7) |
| Galaxy S24 | Seek, GOP 30 | p50 75 ms | recorded |
Issue #88 tracks the M1 and M2 device items.

## 5. ADRs
| ADR | State |
|---|---|
| 0015 keyframes | **accepted** (S9 bars met) |
| 0016 proxies | proposed (M2.1; container bars met, device bars are estimates) |
| 0017 A/V drift + VFR, 0018 export queue + resume | proposed (M2.1; no file written yet) |
| 0019 crash-report endpoint | **open, owner-level**: no endpoint is added; local crash report only (M2-053, M2.1) |
| 0020 op patches | **accepted** (implemented in #205, bars met in round 10); `adr/README.md` said "proposed" and is corrected in this PR |

## 6. Known issues (open on GitHub, 2026-11-27)
| Issue | Blocks the merge? |
|---|---|
| #107 stills smoke flake | **No.** Hardened in #215 (waits on the decoder, bounded probe); not reproduced in 62 local runs (its own report). `verify` on `m2` was green on #215's head (run 446) and on #207, #206, #202, #197; red runs on #200, #203, #204, #205 were fixed by #206 per its description (I did not open each log). One green run since #215 is not "stayed green": keep it open until the next few `m2` runs pass, then close |
| #88 M1 + M2 field validation | **No** (field validation by definition; section 4) |
| #89 work-manager handoff, #84 main freeze | No (process; the freeze is why #120 stays unmerged) |
| #91 Actions minutes / CI cost | No (process) |
| #72 OpenH264 pins, #52 native-media release build | No (desktop release, not the web M2 scope) |
| #123 deploy board, #2, #1, #3 | No (bookkeeping) |

**Phone playback (S24, 2026-11-27):** 3 layers of 1080p30 play at about 24 fps (118 presented, 32 dropped, 49% stalls): decode-bound (hardware decoders), not upload-bound; `docs/features/preview.md` has the analysis. Proxies (M2.1) are the planned answer.
