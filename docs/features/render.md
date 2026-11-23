# Feature: render (compositor)

Crate `app-render`. ADR 0003. Milestone M1 (M1-020/021; export path M1-022; the one browser compositor M1-023).

## Behaviour
- `Compositor::render(w, h, layers)` blends layers bottom-first over opaque black and returns a persistent `Rgba8Unorm` texture (sRGB-encoded). Layer = pixels + centre/scale/rotation/opacity.
- Pixels: `Rgba8Srgb` (straight alpha), `Yuv420` (planar, tight, with `YuvRange` and `YuvMatrix` from the frame metadata) or `Resident` (the slot already holds the picture: written by `set_layer_rgba` or copied in from the platform with `copy_external_image_to_texture` on `layer_texture`, e.g. a WebCodecs `VideoFrame`).
- `Layer::display_rotation` (0/90/180/270 clockwise, from the container): the displayed size swaps width/height at 90/270 and the texture coordinates are mapped by `texture_matrix` (exact at right angles), so `scale` applies to the upright picture.
- `render_to_view(w, h, layers, view)`: the same passes, with the final sRGB-encode pass writing straight into a caller's `Rgba8Unorm` view (a canvas surface texture). Same shader pass as `render`, so the pixels are identical (tested).
- Colour pipeline v0: sRGB -> linear on sampling (RGBA) or YCbCr -> R'G'B' -> treated as sRGB -> linear (video); linear premultiplied blending; sRGB encode in the shader. Clamp, no HDR/wide gamut yet.
- `read_rgba8_into` (async, `map_async`) for export; `render_to_rgba8` is a blocking native wrapper. On the web use `read_rgba8_into_with`, whose `yield_to_host` hook gives the event loop a turn between polls (WebGL2 completes a map only when the device is polled again; without the hook it never resolves).

## Data model
`Compositor` owns persistent per-layer-slot textures and bind groups, one dynamic-offset uniform buffer, target textures (rebuilt only when output size changes), one readback buffer.

## Rules
- Steady state allocates no GPU objects (`alloc_stats()` unchanged). New per-frame resources need the same proof.
- Accumulation format is chosen from adapter capabilities (`AccumFormat::for_adapter`): `Float16`, else `Srgb8` (documented quality loss in ADR 0003). Same shader for both.
- WGSL only; no storage buffers/compute in the base path (WebGL2).

## Browser path (M1-023)
`crates/wasm/src/render.rs` binds the compositor as `GpuRenderer` (wasm32 only, thin: layer maths stays here). It runs in a Worker on a transferred `OffscreenCanvas`: `create(canvas, "auto"|"webgpu"|"webgl2")` looks for a WebGPU adapter first (before touching the canvas, since a canvas that got a `webgpu` context can never give a WebGL2 one), else wgpu's GLES backend on WebGL2; `AccumFormat::for_adapter` then picks float or 8-bit accumulation from the adapter. Per frame: `begin()`, one `add_rgba` / `add_external` per layer (a `VideoFrame` is imported on the GPU, no CPU copy), then `render(..., present)` (canvas, preview) or `read_rgba8` (export). Layer geometry is in sequence pixels and scales by `out_w / seq_w`. `@app/engine-client` wraps it as `GpuRenderer` (`render.ts`, `openRenderer`).
- **`"auto"` trusts WebGPU only after a self-test** on a scratch canvas: import a `VideoFrame`, composite, read back, check the pixel. A failing test means WebGL2. Reason: in headless Chromium 1243 on SwiftShader (flags `--enable-unsafe-webgpu`), importing a `VideoFrame` and then mapping the readback buffer fails ("A valid external Instance reference no longer exists"), and presenting then reading back on the same renderer fails too. Real WebGPU hardware is **not verified**; this environment only proves the WebGPU adapter, CPU-layer rendering and readback, and the fallback decision. The WebGL2 path is verified end to end (below).
- WebGL2 cannot copy from a canvas (`UNRESTRICTED_EXTERNAL_TEXTURE_COPIES` missing): sources are `VideoFrame`, `ImageBitmap` or RGBA bytes only.
- The `Instance` is kept alive for the renderer's lifetime. wgpu's default error handler would abort the module: validation errors go to `console.error` instead.
- Build: `.cargo/config.toml` sets `--cfg=web_sys_unstable_apis` for wasm32 (web-sys gates the `VideoFrame` binding behind it).
- Size: `app_wasm_bg.wasm` 881 KB -> 3.40 MB (gzip 329 KB -> 1.19 MB; no `wasm-opt` here). It is loaded by the UI thread, the preview Worker and each export Worker. Follow-up: split the GPU code into its own module so only the Workers that composite load it.

## Edge cases
Odd widths/heights use `ceil(w/2)` chroma; plane byte lengths are asserted. Opacity is clamped to 0..=1. Zero layers renders black. Chroma is bilinearly upsampled with centred siting (v0; left-sited MPEG-2 chroma is a later refinement).

## Tests
`crates/render/tests/golden.rs`: goldens (`three_layers`, `colour_chart`) on Vulkan and GL, float and 8-bit accumulation (tolerance 3/255); linear-blend and sRGB round-trip assertions; YUV bars for both ranges and matrices; zero-allocation steady state; slot rebuild accounting. `display_rotation_makes_the_layer_upright_and_swaps_its_size` and `resident_layers_and_rendering_into_a_view_match_the_uploaded_readback_exactly` (view path == readback path, exact, both backends). `colour.rs` has unit tests. Skips when no adapter exists. Browser: `tests/smoke/preview.spec.ts` (parity, no per-frame allocation), `tests/smoke/export.spec.ts`, `tests/unit/render.test.ts` (the TS wrapper). Regenerate: `UPDATE_GOLDENS=1 cargo test -p app-render --test golden`.
