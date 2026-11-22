# Quality, accessibility, privacy and release gates

## Test strategy
| Layer | What | Where |
|---|---|---|
| Unit | pure logic: time math, ops, evaluate, DSP, parsers | `crates/*` (`cargo test`), `tests/unit` (TS) |
| Property | `undo(do(op)) == identity`; `replay(journal) == state`; time conversions round-trip; serialization round-trip + forward compatibility | `proptest` in `app-model`, `app-timeline` |
| Golden frames | each effect/transition/blend/colour op rendered on each GPU backend vs reference image, with per-backend tolerance (perceptual delta) | `crates/render/tests`, fixtures in `tests/golden` (LFS or generated) |
| Media conformance | decode/encode matrix on sync-test media (click track + flashes), VFR, rotation, odd sizes, 10-bit, corrupt files | `tests/media`, runs per platform |
| Fuzz | demuxers, project loader, subtitle parsers, LUT parser | `cargo fuzz` targets, nightly CI |
| UI smoke | each flow at phone and desktop viewports, keyboard-only variants, no horizontal overflow | Playwright (`tests/smoke`) |
| Visual regression | key screens per form factor, theme and language (incl. RTL) | Playwright screenshots, human-reviewed diffs |
| Performance | budgets in `PERFORMANCE.md` | `tests/perf`, benches |
| Device lab | real iOS/Android/desktop runs of the smoke and perf suites before each release | manual + scripted |
| Soak | 2 h playback + edits loop, repeated export, memory growth check | nightly on desktop, weekly on devices |

Every bug fix lands with the test that would have caught it.

## Accessibility (target WCAG 2.2 AA; UX-06)
Keyboard operation for every action (command palette + shortcuts); logical focus order and visible focus; labelled controls and live-region announcements for jobs; timeline operable without a pointer (move by frame/clip with keys, selection via list view alternative); reduced motion and high-contrast themes; minimum 44 px touch targets; captions for all UI audio cues; colour never the only signal; screen-reader pass at M3 and M9; automated axe checks in smoke.

## Internationalization
Message catalogs from M1 (ICU MessageFormat), no concatenated strings, locale-aware number/date/duration, pseudo-localization in CI to catch truncation, RTL layouts mirrored, text shaping for complex scripts in the engine (TX-10), community translation workflow (Weblate-style, open) before M3.

## Privacy and security gates
- Network allow-list file; CI test fails if any other host is contacted in smoke runs; CSP forbids third-party scripts.
- No telemetry by default; opt-in crash reporting with scrubbed payloads, documented in the app.
- Dependency policy: `cargo deny` and `npm audit` in CI; only free/open licences compatible with ADR 0009; SBOM generated per release.
- Plugin sandbox review and fuzzing before XT-01 ships.

## Release gates (each release)
1. `verify` green on the tag commit; golden frames and media conformance green on all backends.
2. Performance budgets met on reference devices (report attached to the release).
3. Upgrade test: open projects from every previous released version; migration fixtures pass.
4. Install/launch test per platform from the produced artifact (unsigned or signed).
5. Changelog with user-visible changes; known issues listed; licence/attribution file regenerated.
6. For M5+: store review checklist; for 1.0: legal review of codecs and licences, accessibility audit report.
