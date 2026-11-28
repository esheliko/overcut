# Feature: project background (TL-19, M2-003 background part + M2-025)

Milestone M2. Plan items M2-003 and M2-025. Lead decision 2026-11-27: black, flat colour and blur are in M2; an **image** background is M2.1.

## Behaviour
- Where no clip covers the canvas (a 16:9 clip on a 9:16 canvas, a scaled-down clip, a picture-in-picture over an empty V1) the sequence's **background** shows:
  - **Black** (the default; every M1 and earlier M2 file opens unchanged),
  - **Colour**: one flat colour, any sRGB colour,
  - **Blur**: the bottom-most picture of the frame (V1, or the lowest visible video track), enlarged to *cover* the canvas and blurred. The CapCut-style look for vertical video.
- It is one setting per **sequence** (a per-clip override is not built). It is behind every layer, so it is only seen where the layers leave the canvas uncovered, and through any layer that is transparent.
- **Blur strength** 0..=100 (default 50). The blurred picture ignores the bottom layer's own transform: moving, scaling or keyframing V1 does not move the backdrop, which is the clip enlarged to the canvas. Crop and flip of that layer are ignored too.
- **Where to set it**: the Canvas dialog (the button at the right of the player bar; Cancel and Apply are in a footer that stays on screen, down to 320 x 640, with one short line under Background): "Background: Black / Colour / Blur", with the swatch row (nine design-system colours plus an "Other colour" input) for Colour and a "Blur amount" slider for Blur. Apply sends the canvas change and the background change as one batch, so **one Undo** takes back both ("Undo canvas change"). The Details panel with nothing selected shows the current background in its project summary. All controls are >= 44 px, keyboard and touch operable, in both themes.
- **Preview = export.** The preview presents and the exporter reads back through the same compositor call; `desc.background` of the evaluated frame is handed to both. The blur's working size follows the *shape* of the output, not its size, so the blur is the same fraction of the picture at the preview's size and at the export's (tested to within 1 code value).
- A bottom layer that already fills the canvas at full opacity without a turn skips the blur passes (nothing could be seen of it).

## Data model
- `Sequence.background: Background { mode: black | colour | blur, colour: [u8; 3] (sRGB), blur: u8 (0..=100) }`, `app_model` (`crates/model/src/project.rs`). Absent in the file while it is the default (black, colour 0/0/0, blur 50), so a file that never chose one is as small as before; the unused parts are kept when the mode changes, so switching back restores them.
- **Schema 5** (`SCHEMA_VERSION`, migration `v4_to_v5` changes only the version; fixture `crates/model/fixtures/project.v5.json` has a blur background; every older fixture still migrates). The version is bumped so an older app does not open and flatten a file that carries a background (it opens read-only).
- `Op::SetBackground { sequence, background }` (`app_timeline`): undoable, journaled, refuses `blur > 100` (`BadBackground`) and an unknown sequence; the inverse is the old background. It is in the S7/E2 property generator (every op kind must succeed sometimes) and in the wire contract `edit-contract.json` (36 ops).
- `evaluate`: `FrameDescription.background` carries the sequence's background to the compositor; omitted from the JSON while it is the default.
- ABI 5 (`ABI_VERSION` / `EXPECTED_ABI`): the compositor binding gained `set_background`.
- Engine boundary: the op is generic (wasm `apply` and the Tauri command take any op JSON); the compositor runs in the webview on both platforms (`GpuRenderer`), so no native command is added.

## How the compositor draws it (`crates/render`)
- `Compositor::set_background(Background)` (wasm: `GpuRenderer::set_background(mode, r, g, b, blur)`), called by `wrapRenderer` before the layers of every frame; it sticks until set again.
- **Colour**: the accumulation target is cleared to the colour (linear light, alpha 1) instead of transparent; layers blend over it. sRGB-exact through the float accumulation, within 1-2 codes through the 8-bit fallback.
- **Blur** (rewritten in M2 round 10 after the first version showed stripes and banding): four small passes and one full-canvas draw, all in the accumulation format, on targets whose long side is **48 texels** (short side by the output's aspect, never above the output), so preview and export blur by the same fraction of the picture:
  1. **prefilter**: the bottom layer, cover-fit (centred, ignoring its own transform), into target A where every texel averages a 10 x 10 grid of taps over the source area it covers (from the uv derivatives, so display rotation is handled). A single bilinear sample of 1080p into a tiny target aliased into stripes;
  2. a 9-tap Gaussian (sigma 2 taps) along x, A -> B; 3. along y, B -> A. The tap spacing grows with the strength (0.3 .. 2.2 texels, never wider than the Gaussian can be sampled without gaps), which is "Blur amount" = radius;
  4. A is enlarged over the canvas with a **cubic B-spline** (four bilinear fetches; plain bilinear shows diamond artefacts), **dimmed** (x0.7 in linear light, about 15 % in sRGB terms, so the sharp picture stands out; Colour mode is not dimmed) and **dithered** by one 8-bit code (hash noise, gamma-2 steps) so the smooth gradient does not band, as the first draw of the layer pass; then the layers on top.
  Targets and bind groups are built once per output shape and size and reused (steady state allocates nothing). WGSL only, no compute: works on WebGL2 and WebGPU.

## Edge cases
- No layers: black (blur has nothing to show; colour fills the whole frame).
- The bottom layer is a still, a video frame or a stand-in during scrubbing: whichever picture is the bottom layer of that draw is blurred. The paused preview settles on the exact frame, like every layer.
- The bottom layer is rotated 90/270 by the container: blurred upright (display rotation applied).
- A bottom layer with transparency that covers the canvas still skips the blur (opaque black or the colour show through it, never the blur): put an opaque clip below it.
- The prefilter is a 10 x 10 tap box over each target texel's footprint: a very sharp, high-frequency source (a test pattern) can still show a faint residue, which the Gaussian and the cubic enlargement hide.
- Opening a project with blur on a device without float render targets uses the 8-bit accumulation like every layer.

## Cost
Blur adds four passes over a 48 x 27 (or 27 x 48) target and one full-canvas draw with four fetches and a dither: the full-canvas draw is the cost (measured in the PR and `docs/PERFORMANCE.md`). Numbers in the PR and `docs/PERFORMANCE.md` ("Background blur"). No per-frame allocation (`alloc_stats` unchanged after warm-up).

## Test plan
- Rust model: `a_v4_file_opens_with_a_black_background_and_the_v5_one_keeps_its_blur` (migration, defaults not written, save/reopen), schema and generated types in sync.
- Rust timeline: `set_background_is_one_undoable_step_carried_by_evaluate_and_validates` (undo/redo, refusal untouched, evaluate carries it, default omitted from the JSON), the property generator (undo(do(x)) == x with the new op), the wire contract.
- Rust render (`crates/render/tests/golden.rs`, Vulkan and GL, float and 8-bit): colour exact and layer untouched; blur smears the picture into the bands, deterministic, stronger = smoother, picture drawn on top untouched; skipped under a covering layer and independent of the layer's animation; **blur at 90x160 equals blur at 360x640 (within 1 code)**; goldens `background_blur_9x16`, `background_colour_9x16`. Unit: `layer_covers_output`, `backdrop_size`.
- TypeScript: `canvas.test.ts` (choice, op, what the dialog sends), `render.test.ts` (the background is set before the layers of every frame).
- Smoke `tests/smoke/background.spec.ts` (desktop and phone): 4:3 clip on a 9:16 canvas: black band by default; Blur -> the top band is lit and the export frame is the same pixels (`parity`); Colour -> the swatch colour in the band; undo twice back to black; 44 px targets on the phone.
- Smoke `tests/smoke/export-parity.spec.ts` (M2-030, below).

## Export parity test (M2-030)
`tests/smoke/export-parity.spec.ts`: V1 (2x) + V2 (keyframed position, opacity 0.7, same file) + blur on a 360x640 canvas; export through the production pipeline to VP9 WebM, decode it again, compare frames 2, 7 and 12 of 15 with the preview's frames (mean absolute difference on a 36 x 64 area average: 3 for the same frame, >= 13 for a different one; bound 6), exact length (15 frames, 0.5 s, last frame at 14/30 s within the WebM millisecond), the top band lit in both. Runs in `verify` (headless WebGL2, software VP9, no ffprobe).

## Not covered / follow-ups
Image background, gradient background, per-clip override, a background for a clip that is itself transparent. A prefilter (mips) for the blur's source if sparse sampling ever shows.
