# UX round 16, lane E: the feel of the timeline canvas

Evidence: the round-16 audit reports (`desk`, `phone`, `first`). Behaviour: `docs/features/timeline-view.md` and `docs/features/preview.md` (new r16 lane E sections). Screenshots: `docs/m2/img/r16-e-*.png` (before and after at 1440x900 dark and light; the chip on a phone and on desktop).

## What changed (finding, before, after)

| ID | Before | After |
| --- | --- | --- |
| DESK-12 / r15 DESK-20 / FIRST token 5: clip colours | Video, still, overlay, camera sound and music were two colours (video, audio); a music lane looked like camera audio (`r16-e-lanes-dark-before.png`). | The canvas reads lane C's tokens by what a clip is (`scene.clipKind`): video, photo, overlay, camera sound (linked audio) and a new amber `--clip-music` for a sound file of its own; its header chip wears a note instead of "A" (`r16-e-lanes-dark-after.png`). Labels use `--clip-ink` on a chip that flips light or dark with the theme; waveforms are drawn in the same ink. |
| FIRST-13 (light theme): selected clip washed out | A 12 % accent wash over the whole clip veiled its thumbnails in the light theme. | No wash; a 3 px accent border inside a 5 px keyline of the page colour, plus the handles (`r16-e-light-selected-*.png`). |
| DESK-12: groups and header icons | No gap between the video and audio groups; lock, eye and M/S were 14 px (12 px as touch indicators). | The audio lanes carry a quiet tint and a 2 px line sits where the pictures end. Switch glyphs are 16 px in the 22 px box; touch indicators are 16 px in their own colour (they were dark on dark). On touch the whole header (60 px tall) stays the one 44 px+ target. |
| DESK-12: thumbnails | Flat colour until the thumbnails landed, then a pop (flat teal after 1.5 s). | A neutral row of frames (hairline gaps) while a slot loads, then the picture fades in over 180 ms (none with reduced motion). |
| DESK-15, PHONE-8: edge frame while trimming | The preview stayed on the playhead frame; the ghost of the trimmed clip was flat colour, so thumbnails blanked. | The preview shows the frame under the dragged edge (`trimPreview.ts`), one seek per animation frame, the playhead does not move, and it returns to the playhead on release. The trim ghost keeps the clip's thumbnails or waveform. |
| PHONE-5, r15 PHONE-13: back to the playhead | No way back after zooming or scrolling away. | A chip with an arrow at the edge the playhead is beyond; a tap centres it (no zoom change). Phone and desktop (`r16-e-chip-phone.png`, `r16-e-chip-desktop.png`). |
| PHONE-10, r15 PHONE-17: press feedback | A touch on a clip showed nothing until the pick-up at 380 ms. | The clip lights up (wash and accent keyline) in the frame of the press; on touch a ring above the fingertip fills over the 380 ms pick-up, then the lifted ghost and the haptic tick follow. |
| PHONE-9, r15 PHONE-20: frame step on hold | One step per click; holding moved 1 frame in 1.2 s. | Press steps once; held for 400 ms it repeats every 160 ms, accelerating to 33 ms, then steps of 2 and 4 frames. Touch and mouse. A keyboard activation steps once. |
| PHONE-17: zoom after a reload | The zoom store is global and starts at 40 px/s: a reloaded project opened at 40 px/s. | A project opens fitted, or at the zoom set by hand in it (saved per project id 400 ms after a change, forgotten by Fit; blocked storage means fitted). |
| Lane C note: short timeline with the Edit sheet open | With the phone sheet open the canvas can be ~120 px tall and the selected lane scrolled out of sight. | When the canvas gets shorter, the first selected clip's lane is scrolled into view. |

## Cost
Measured with `tests/perf/timeline-bench.mjs`'s project (`#timeline-bench&clips=100` is new: 10 tracks x 10; the default is 20 x 50 = 1000), 240 frames of pan, zoom and pan+zoom, Chromium headless, before = `origin/m2`, after = this branch. Same machine, back to back.

| | 100 clips desktop (draw avg) | 100 clips 4x CPU | 1000 clips desktop | 1000 clips 4x CPU |
| --- | --- | --- | --- | --- |
| before | 0.38-0.44 ms, 60 fps | 1.5-1.8 ms, 59.3-60 fps | 0.59-0.82 ms, 60 fps | 2.3-3.7 ms, 57-60 fps |
| after | 0.39-0.47 ms, 60 fps | 1.7-1.8 ms, 58-60 fps | 0.58-0.84 ms, 60 fps | 2.4-2.9 ms, 58-60 fps |

Long tasks: 0 on desktop for both sizes before and after. At 1000 clips and 4x CPU throttle the count is noise either way (three runs after: 1, 2, 0; before: 0, 11). Per frame the painter adds one `clipKind` read per clip and a second body pass only on lanes with two kinds; nothing is allocated per frame (a palette of strings, typed arrays). The frame step, the chip and the trim preview add no per-frame work: the chip is toggled from the existing playhead paint, the trim preview is one `seek` per animation frame (the player already keeps only the latest request), the press ring runs a requestAnimationFrame loop only while a touch rests on a clip and stops at the pick-up.

## Tests
`tests/unit/r16-lane-e.test.ts` (zoom per project, the hold schedule, the trim edge frame and its store, clip kinds and the music lane) and `tests/smoke/ux-r16-e.spec.ts` (the chip, a held step, the zoom after a reload; desktop and phone). On this sandbox `smoke.spec.ts:178`, `:390` and `drag-move.spec.ts` fail identically on `origin/m2` (checked), `edge-scroll` and the device check are timing flakes under a loaded run and pass alone.

## Not done (and why)
- Waveform tiles share one colour for every audio lane (the tile cache is keyed by one style), so they are drawn in the label ink instead of a hue per kind; a per-kind hue needs a second tile cache.
- Photo and overlay lanes are covered by the unit test, not by a screenshot: the sandbox's second import did not land a photo on the timeline in the screenshot script.
- The Edit-tool trims (ripple, roll) do not drive the preview frame: only the Select-tool edge trim does.
- The ring and the lit clip are drawn on the canvas and are not announced to assistive tech (the pick-up already speaks "picked up").

## Notes for the other lanes
- `Scene` gained `clipKind` and `trackMusic`; anything that builds a `Scene` literal (none today outside `buildScene`) must fill them.
- `--clip-music`, `--clip-music-wave` and `--clip-music-strip` are new tokens in `theme/tokens.css`.
- The zoom store still starts at 40 px/s; `Timeline.tsx` applies the per-project zoom or Fit when a project id first appears. A flow that opens a project without going through `Timeline` must do the same.
