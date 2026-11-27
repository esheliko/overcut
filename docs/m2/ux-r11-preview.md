# M2 UX round 11, lane "preview" (preview, transport, handles, Details, export)

Method: `npm run build` + `vite preview` of `m2`, Playwright (Chromium) at 390x844 / 320x640 / 844x390 (touch), 820x1180 (touch), 1440x900 dark and light; clips `flash_click.mp4` and `colour_full.mp4`. Per step: overflow, console, touch targets under 44 px, screenshots read by eye. Scripts and raw shots are in the session scratchpad; the kept before/after images are in `docs/features/img/m2-r11/preview/` (1x PNG). Perf numbers are "container, calibrated estimate".
The skill's `search.py` could not be run (the session's permission classifier refused to execute the downloaded script); the skill's reference text (`pro-rules.md`, SKILL.md priority table) was used as the checklist instead.

| # | Pri | Where | Steps | Saw | Expected | Status |
|---|---|---|---|---|---|---|
| 1 | P1 | Preview, move handle | Select a clip, drag the picture toward the canvas centre or an edge | No snapping at all (stops at 0.67 %, rotation was the only snap); nothing tells you where "centred" is | Pro editors snap to centre and frame edges and show a guide | Fixed: `snapMove`, 6 screen px, guide lines, Alt = free; unit test + smoke |
| 2 | P1 | Playback with a clip selected | Select a clip, press Space for 3 s, count React commits | 61 commits in 3 s (about 20 / s): the Details fields and the handles layer re-rendered on every frame | None while playing (commits during playback were the round 10 target) | Fixed: handles layer is not mounted while playing; Details follow the playhead per frame only for animated clips. 3 commits in 3 s |
| 3 | P1 | Export dialog, preset tiles (390 and 1440) | Open Export | Every tile's hint ends in an ellipsis: "Full HD at most · no file-size cap set · stays …": the cap and the black bars (the facts that tell presets apart) are cut off; on touch the title tooltip is unreachable | The whole hint readable | Fixed: the hint wraps in full and the tile grows (a clamp to two lines still cut the longest hints on the 2-column desktop grid; the smoke asserts no tile hint is clipped or `nowrap`) |
| 4 | P1 | Phone Edit sheet at 320 px | Select a clip, open Edit, measure the mini transport | Play button 43 x 44 (shrank in the tight row) | 44 x 44 | Fixed: the strip's buttons do not shrink |
| 5 | P2 | Phone Edit sheet during playback | Play with the sheet at the peek detent | The mini transport re-rendered on every frame (timecode as React state) | Time written to its text node like the preview timecode | Fixed: ref + `store.subscribe`; prev / next key are primitive selectors |
| 6 | P2 | Export "ready" | Export a clip | "OverCut export 2026-11-27.mp4" broke in the middle of the date in its half-width cell | File name on one line | Fixed: the file cell spans the row |
| 7 | P2 | Details, nothing selected | Look at the Canvas row at 1440 | "16:9 · 320 × 180 · 30" then "fps" alone on the second line | A value never breaks before its unit | Fixed: the row wraps whole (value under its label, right aligned) |
| 8 | P2 | Timeline zoom slider at 820 touch | Measure targets | 140 x 24 (round 10 item 6 says fixed for `pointer: coarse`) | 44 px | Not in this lane (timeline toolbar); reported to the lead |
| 9 | P2 | Export open right after import | Import, click Export at once | 318 ms to usable (the format probe is not warmed yet); 4-11 ms once the idle prefetch ran (4 s after import) | Under 100 ms | Not fixed: the probe is the browser's WebCodecs answer, already prefetched on hover / idle; noted |

## Perf (container, calibrated estimate)
- React commits during 3 s of playback with a clip selected (devtools-hook commit counter, desktop 1440x900, `colour_full.mp4`): **61 before, 3 after**.
- Export dialog, in-page `performance.now()` from the click to the Export button present: 318 ms right after import (probe cold), 11 ms with the probe warm. Unchanged by this PR (dialog code was not touched beyond CSS).
- `tests/perf/edit-latency.mjs` (`?sample=2h`, 2300 clips) after this PR: 1x split commit 2.6 ms, key->paint 11.6 ms, undo 13.7, redo 14.7; 4x split commit 10.1 ms, key->paint 32.6 ms, undo 34.6, redo 33.6. Round 10 recorded 3.1 / 15.8 (1x) and 12.9 / 49.5 (4x); I did not re-run the "before" on this container, so treat the difference as noise, not a gain: no regression.

## Works, keep it
- Export dialog: opens at final size, presets grid, pinned Export button on a 320 px phone, "Your video is ready" with Save / Export again / Close, light and dark.
- Details: per-field reset arrow, label drag-scrub (Shift x10, Alt x0.1), range note, keyframe diamonds with prev / next and an easing picker; no overflow at 320 / 390 / 844 / 820 / 1440 in dark or light; no console message in any run.
- Transform handles: 44 px hit areas kept inside the stage on phones; Shift snaps rotation to 15 degrees, right angles snap within 3.

## Not verified
- Export progress screen: the test clips export in under a second here, so the percent / ETA view was reviewed in code only (`Progress` in `ExportDialogView.tsx`), not by screenshot.
- Phone playback commit count and the 4x-throttled numbers (the phone run's timeline tap missed in my script); the change is the same code path as desktop.
- Real-device touch (Safari / iOS), pinch, hardware keyboard on tablet.
- Contrast was judged from screenshots (dark and light), not measured per element.

## Open ideas (not done, would be features)
- Keyboard nudge of the selected picture on the canvas (arrow keys, Shift = 10x): today only the Details fields move it from the keyboard.
- Numeric scrub only starts from the label; a drag on the number itself would be quicker for pros.
