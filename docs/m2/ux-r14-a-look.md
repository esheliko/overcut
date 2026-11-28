# M2 UX round 14, lane A: shell and timeline look

Goal: on first sight it reads as a pro video editor, not a web dashboard. Screenshots (desktop 1440x900, phone 390x844, dark): `img/r14-a-look-desktop.png`, `img/r14-a-look-phone.png`; before: `img/r14-a-look-before-desktop.png`.

## What changed (before -> after)
| Area | Before | After |
|---|---|---|
| Shell | floating rounded cards with 6-8 px gaps | flush panels; the workspace paints `--line` and a 1 px grid gap is the divider; radius 0, no card borders or shadows (tablet, desktop, ultrawide, phone landscape) |
| Panel headers | 44 px | 38 px with a mouse, 44 px on touch |
| Preview | stage same family as the chrome, 12 px card | `.stage-view` sits on `--stage` (darkest surface), picture has a 1 px `--line` edge, no radius or drop shadow |
| First-run theme | followed the system (light for a light OS) | **dark** when nothing is stored; "follow the system" is now a stored choice (`overcut.theme=system`), so an explicit choice still wins |
| Lane height | 52 px | 60 px (all tracks) |
| Clips | 4 px corners, 2 px top strip, tiles with gaps | 6 px corners, no strip, full-bleed continuous filmstrip |
| Clip name | plain text over a gradient scrim on the picture | dark rounded chip top-left, duration chip top-right on clips >= 150 px, speed chip bottom-left |
| Waveform | every other column (a dotted hairline when scaled) | every column: a filled, mirrored shape; keeps the fade of muted tracks |
| Selection | 2 px outline + keyline, small accent grips | 3 px accent border + wash, white trim handles (10 px drawn; hit zone unchanged: 16 px mouse, 44 px touch, `hit.ts`) |
| Playhead | 1.5 px | 2 px with the existing grab head on the ruler |
| Ruler | ticks at 50% | ticks at 32% |
| Locked / muted | locked: faint veil | locked: 42% `--bg` veil; muted/hidden: 38% fade (already) |
| Empty area | blank | dashed "Drop media here" zone under the tracks while at most two tracks hold clips |

## Cost (TimelineBench, 1000 clips x 20 tracks, `node tests/perf/timeline-bench.mjs`)
| Profile | before fps / JS draw ms | after fps / JS draw ms |
|---|---|---|
| desktop pan | 60.0 / 0.92 | 60.0 / 0.89 |
| desktop zoom | 60.0 / 0.75 | 60.0 / 0.66 |
| desktop pan+zoom | 60.0 / 0.85 | 60.0 / 0.74 |
| 4x throttle pan | 56.0 / 4.14 | 54.8 / 3.88 |
| 4x throttle zoom | 58.3 / 3.09 | 57.6 / 2.67 |
| 4x throttle pan+zoom | 54.1 / 3.69 | 56.0 / 3.14 |
| phone 4x pan / zoom / both | 59.3 / 59.5 / 56.7 | 58.5 / 60.0 / 59.0 |
Frame times are within run-to-run noise; clips drawn per frame drop slightly because taller lanes show fewer tracks. Nothing is allocated per frame: the new chips are one path per lane and their labels are cached strings (`fitName`, `durLabel`). Filmstrip bitmaps and waveform tiles were already cached (`media-layer.ts`).

## Left out, and why
- **Per-kind lane heights (video 64 / audio 44, phone 56).** Lane geometry is one constant (`LANE`) shared by hit-testing, drag rows, scrolling, the bench and ~15 unit and smoke specs (`row * LANE`). Different heights need a cumulative row table through all of them; that is a refactor of its own. This PR uses one 60 px lane everywhere (the taller lane is what makes the filmstrip and waveform read). Follow-up if wanted.
- **Tabular ruler figures.** The 2D canvas has no font-feature API; the ruler keeps Inter's default figures.
- **Track-header tooltips.** Headers are painted on the canvas, which has no native title; a tooltip layer belongs with the toolbar work (lane B).
- Preview drop shadow and card chrome are gone; a first-run empty project keeps its existing DOM hint instead of a second drop zone.

## Tests touched
Smoke specs that hard-coded the 52 px lane now use 60 (`activation`, `tl-tools`, `drag-move` comment, `lanes`, `tracks`, `smoke`). New: `tests/smoke/ux-r14-a.spec.ts` (first-run dark, flush panels), a unit test for the stored theme default. No check was skipped or loosened.
