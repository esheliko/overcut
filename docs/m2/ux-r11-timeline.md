# M2 UX round 11, lane "timeline" (feel of editing)

Method: `npm run build` + `vite preview`, Playwright/Chromium with `?sample` at 390x844, 320x640, 844x390, 820x1180 (touch) and 1440x900 (mouse + keyboard). Checked per size: overflow, console, targets under 44 px (touch), tab order, tooltips, selection, trim, move, context menu, long press, pinch, empty state. Perf numbers are "container, calibrated estimate".

| # | Pri | Where | Steps | Saw | Expected | Status |
|---|---|---|---|---|---|---|
| 1 | P1 | Timeline zoom slider, coarse pointer (tablet 820) | Open `?sample` on a touch tablet, measure the slider | 24 px high: the R10 "44 px" rule (`.zoom input`) lost to the later `.zoom input[type=range] { height: 24px }` | 44 px target | Fixed: the 44 px is now stated in the coarse block that wins; smoke `timeline-r11.spec.ts` |
| 2 | P2 | Clip long press on touch (390) | Press and hold a clip 0.4 s | Only the selection outline appeared, identical to a tap; the buzz does not exist on iOS or most desktops | A visible "picked up" state | Fixed: the clip is drawn as its move ghost (name + length) while held, so there is no jump when the drag starts; letting go without moving puts it back. Unit test (`lifted`), before/after `img/m2-r11/timeline/lift-*.png` |

Checked, no finding: no page overflow at 320 / 390 / 844 / 820 / 1440, no console error or warning, touch targets on phone all >= 44 px (the 20 px playhead canvas is the scrub handle with a larger hit zone), trim and move ghosts carry a timecode / name + length and a dashed snap guide, context menu (Split, Duplicate, Delete, Ripple delete, Unlink, Speed) opens at the pointer, toolbar tooltips carry shortcuts, empty timeline says what to do on every size, pinch zoom works and the overview window stays readable, the toast is at the top of the picture (K-03 is closed), the overview strip is light (22 % / 40 % clip layers, 10 % window wash) and hides when the clips fit.

## Works, keep it
Selection outline + grips (44 px hit zone around 6x20 px grips), seam roll, drag ghost with snap guide, empty-state hint, track-header tinting, overview window.

## Not verified
Real-device touch (iOS pinch, haptics), two-finger pan on a real screen, a long project on a phone CPU. Waveform at very deep zoom draws as separate blocks (cosmetic, synthetic sample audio).

## Perf (container, calibrated estimate; same scripts, after the change, hot paths untouched)
- `timeline-bench`: desktop 60.0 fps pan/zoom/pan+zoom (p95 16.7 ms); 4x desktop 57.6 / 57.8 / 53.3 fps; phone 4x 59.5 / 60.0 / 60.0 fps. Drag input-to-paint p95 4.0 ms (single), 1.7 ms (1000 selected).
- `edit-latency` (2300 clips): 1x split commit 2.5 ms, key->paint 11.6 ms; 4x 11.5 / 36.8 ms. Round 10 numbers: 3.1 / 15.8 and 12.9 / 49.5.
