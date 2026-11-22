# 0007 React UI, canvas timeline, effects as data
**Status**: proposed

**Decision.** UI: React 19 + Vite + plain CSS with design tokens and container-query layouts; no large component library (bundle and control). The timeline, waveforms and scopes are canvas/GPU rendered and virtualized, not DOM. Accessibility via headless primitives and an alternative list/keyboard model of the timeline. Effects, transitions, generators and caption styles are **data + WGSL** (manifest + shader) and the built-in pack uses the same format as third-party plugins (EF-20, XT-01); plugins cannot run native code on web/mobile.

**Consequences.** (+) fast UI, small bundle, a real plugin ecosystem from day one, safe sandbox. (-) a custom timeline widget is real work (S8); the effect format must be designed carefully (versioned, with a conformance test suite) because it becomes public API.

## S8 results (canvas timeline spike, M1-031)
Question: can a canvas-rendered, virtualized timeline hold 60 fps pan/zoom with 1000 clips x 20 tracks? **Yes, with margin on desktop; the low-end proxy clears 30 fps.**

Method: `node tests/perf/timeline-bench.mjs` (page `/#timeline-bench`), headless Chromium 1243 in a CPU-only container (software canvas raster, no GPU, so conservative), 240 scripted frames per phase, frame time from consecutive `requestAnimationFrame` callbacks; "raster" forces the queued canvas commands to rasterize each frame. 1000 clips, 20 tracks, 50 clips each.

| Case | pan | zoom | pan+zoom | JS draw / +raster (ms) |
|---|---|---|---|---|
| Desktop 1280x800 | 60.0 fps | 60.0 fps | 60.0 fps | ~1.0 / ~3.3 |
| Desktop, Chrome 4x CPU throttle (low-end proxy) | 57.4 | 59.5 | 57.6 | ~3.6 / ~11.5 |
| Phone 390x844 at dpr 3, 4x CPU throttle | 41.5 | 39.3 | 34.2 | ~1.8 / ~17 |

Bar: 60 fps desktop, 30+ fps throttled: met in every case. Not measured on a real phone GPU (ADR 0013 calibrated-proxy rule applies when the device lab exists).

What mattered: (1) only visible clips are touched (binary search per visible track; <= ~600 of 1000 drawn at the widest zoom, ~50-200 on a phone); (2) **no `Path2D`/path fills for thousands of small bars or tiles**: one path of rects cost ~30-40 ms of software raster per frame, plain `fillRect` calls under one `fillStyle` cost ~3-11 ms; (3) no per-frame allocation (typed arrays, cached ruler labels); (4) redraw only when dirty. Decision: keep canvas 2D for the timeline; tile cache / OffscreenCanvas not needed at this scale. Real thumbnails and waveforms (M1) must draw from pre-rendered bitmaps with the same visible-only rule and be re-measured.
