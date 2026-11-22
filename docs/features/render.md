# Feature: render (compositor)

Crate `app-render`. ADR 0003. Milestone M1 (M1-020/021; export path M1-022).

## Behaviour
- `Compositor::render(w, h, layers)` blends layers bottom-first over opaque black and returns a persistent `Rgba8Unorm` texture (sRGB-encoded). Layer = pixels + centre/scale/rotation/opacity.
- Pixels: `Rgba8Srgb` (straight alpha) or `Yuv420` (planar, tight, with `YuvRange` and `YuvMatrix` from the frame metadata).
- Colour pipeline v0: sRGB -> linear on sampling (RGBA) or YCbCr -> R'G'B' -> treated as sRGB -> linear (video); linear premultiplied blending; sRGB encode in the shader. Clamp, no HDR/wide gamut yet.
- `read_rgba8_into` (async, `map_async`) for export; `render_to_rgba8` is a blocking native wrapper.

## Data model
`Compositor` owns persistent per-layer-slot textures and bind groups, one dynamic-offset uniform buffer, target textures (rebuilt only when output size changes), one readback buffer.

## Rules
- Steady state allocates no GPU objects (`alloc_stats()` unchanged). New per-frame resources need the same proof.
- Accumulation format is chosen from adapter capabilities (`AccumFormat::for_adapter`): `Float16`, else `Srgb8` (documented quality loss in ADR 0003). Same shader for both.
- WGSL only; no storage buffers/compute in the base path (WebGL2).

## Edge cases
Odd widths/heights use `ceil(w/2)` chroma; plane byte lengths are asserted. Opacity is clamped to 0..=1. Zero layers renders black. Chroma is bilinearly upsampled with centred siting (v0; left-sited MPEG-2 chroma is a later refinement).

## Tests
`crates/render/tests/golden.rs`: goldens (`three_layers`, `colour_chart`) on Vulkan and GL, float and 8-bit accumulation (tolerance 3/255); linear-blend and sRGB round-trip assertions; YUV bars for both ranges and matrices; zero-allocation steady state; slot rebuild accounting. `colour.rs` has unit tests. Skips when no adapter exists. Regenerate: `UPDATE_GOLDENS=1 cargo test -p app-render --test golden`.
