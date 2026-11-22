# Feature: timeline view (canvas, M1-031 / spike S8)

## Behaviour
Canvas-rendered timeline in the editor's timeline panel: time ruler with adaptive tick labels, one row per `Track` of the first `Sequence` (generic for N tracks, video and audio), clips as rectangles with name and a filmstrip (video) or waveform (audio) placeholder, sticky track-label gutter and ruler, playhead. Reads `Project` from `@app/engine-client`; shows a sample project (`timeline/fixture.ts`) until media is imported. **No editing interactions yet** (M1-034).
- **Zoom** (pixels per second, 2..1200): pinch, ctrl/cmd + wheel (and trackpad pinch), `+`/`-`/`=` keys, `0` fits the project, log-scale slider and buttons. Zoom keeps the time under the pointer (or the playhead / viewport centre) fixed.
- **Scroll**: wheel (shift or no vertical overflow = horizontal), touch drag with momentum, Page Up/Down, Up/Down arrows for tracks.
- **Seek**: click/drag on the ruler or (mouse) the tracks; on touch a tap seeks and a drag pans. The playhead is followed while playing.
- **Accessibility**: the canvas is a focusable `role="slider"` "Playhead position" (arrows = 1 frame, Shift = 1 s, Home/End) with an `aria-describedby` summary (tracks, clips, length, key help). A per-clip list alternative arrives with M1-034.

## Structure (`apps/web/src/timeline/`)
- `scene.ts`: `Project` -> flat typed arrays (seconds as floats for drawing only; the model keeps integer ticks, ADR 0010), clips sorted per track, binary search.
- `view.ts`: viewport math (zoom-at-anchor, clamping, slider mapping, tick step, fling decay). `hit.ts`: pure hit-testing (ruler, gutter, clip body/edge, gap, empty) reused by M1-034. Both unit-tested in `tests/unit/timeline.test.ts`.
- `draw.ts`: painter; `TimelineCanvas.tsx`: sizing at real devicePixelRatio, input, rAF-on-dirty.

## Performance (budget: docs/PERFORMANCE.md "Timeline UI")
1000 clips x 20 tracks: 60 fps desktop, 57-59 fps at 4x CPU throttle, 34-41 fps on a phone-size dpr-3 viewport at 4x throttle (software raster). Details and method: ADR 0007 "S8 results". Run `node tests/perf/timeline-bench.mjs` (after `npm run build`).
Rules that keep it fast: draw only visible clips; no per-frame allocation; avoid path fills of many small shapes (use `fillRect`); no DOM per clip.

## Edge cases
Empty project draws ruler only; unsorted clips are sorted at build; very small clips are 1 px minimum and unlabeled; names are drawn only when they fit; clips left of the gutter are clamped under it.

## Test plan
Unit: scene build, search, hit-testing with scroll, zoom anchor, slider, tick step. Smoke: canvas paints non-blank pixels, summary present, keyboard zoom/scroll. Perf: the bench script above.
