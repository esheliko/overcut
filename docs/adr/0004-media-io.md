# 0004 Media I/O per platform; codec and patent policy
**Status**: proposed (validate with S1, S3, S4; S1 software-only results below, hardware confirmation pending)

**Context.** Decoding and encoding must be fast (hardware) and legally safe for a free app. H.264, HEVC and AAC are patent-encumbered; shipping software encoders (x264/x265 are GPL) is a licence and patent liability. Browsers and operating systems already license and expose hardware codecs.

**Decision.**
- **Web**: WebCodecs for decode/encode, with Rust demux/mux compiled to WASM. Codec availability is probed (`Capabilities`) and the UI offers only what works.
- **Desktop**: FFmpeg libav, **LGPL build only, dynamically linked**, no GPL components; hardware encoders (NVENC, AMF, QSV, VideoToolbox, VAAPI/MediaFoundation) first. **openh264** (Cisco binary, royalty-covered) as H.264 software fallback. AV1/VP9/Opus encode in software are royalty-free and allowed.
- **Mobile**: WebView WebCodecs first; native plugins calling MediaCodec / VideoToolbox when the WebView lacks a codec.
- **Defaults**: offer AV1/VP9/Opus where the destination accepts them, H.264/AAC through platform encoders for compatibility; never bundle x264/x265/FDK-AAC.
- Input formats beyond platform support (ProRes, DNxHD, odd containers) are handled by libav on desktop and by an explicit "convert" step on web/mobile.
- A per-platform support matrix lives in this file once S1-S5 produce data.

**Consequences.** Some codec/platform combinations will be unavailable and say so plainly. A legal review before 1.0 (budget in ADR 0011) confirms the policy, in particular for distributing libav and openh264 in app stores.

## S1 results (M1-010, web decode to GPU)
Spike: `spikes/s1-webcodecs/` (page, clip generator, runner; README there). Question: can WebCodecs `VideoFrame`s feed WebGPU textures with frame-accurate seek and < 50 ms warm seek at 1080p H.264, no CPU copy.

**What was measured, and where.** Chromium 153 (Playwright build), headless, Linux, 4 vCPU shared sandbox, **no GPU**: WebGPU adapter is SwiftShader (`fallback`, software Vulkan); `VideoDecoder` is **software** (`prefer-hardware` unsupported, `prefer-software` supported). Clips: 1080p30 H.264 High, 2 B-frames, 150 frames, GOP 30 and GOP 150; frame number burned into pixels and read back from the GPU texture. 60 random seeks after 8 warm-up seeks, plus frames 0 and last, fixed seed. Each seek: reset to the previous keyframe, decode through the target (reorder-aware), flush. Latency is wall clock from seek call to target frame delivered (decode) or to GPU work done (to GPU). Main thread, not yet a Worker.

| Measure (software decode + SwiftShader) | GOP 30 p50 / p95 | GOP 150 p50 / p95 |
|---|---|---|
| Frames decoded per seek (p50 / max) | 21 / 32 | 88 / 150 |
| Decode to target frame (ms) | 83 / 130 | 320 / 543 |
| + CPU upload path to GPU texture, done (ms) | 115 / 179 | 392 / 614 |
| Software decode cost per frame | ~3.9 ms | ~3.6 ms |
| Wrong frame (burned-in number mismatch) | 0 of 70 | 0 of 70 |
| Timestamp sweep mismatches | 0 | 0 |

**Findings.**
1. **Frame accuracy is solved.** Seek = nearest previous keyframe, feed packets in decode order through the target's pts, `flush()`, match `frame.timestamp`. 140 random seeks (including first and last frame, B-frame reordering) returned the right frame every time, verified by pixels on the GPU path that worked.
2. **The CPU-upload path works and is the only GPU path that ran here:** `VideoFrame.copyTo(RGBA)` + `writeTexture` adds about 30 to 70 ms per 1080p frame on top of decode in this environment (software-backed frame, so this is a worst case). It is correct but is the cost the no-copy path exists to avoid.
3. **`importExternalTexture` and `copyExternalImageToTexture` both failed on SwiftShader** ("Failed to import texture from video"; the second then lost the device). Software Vulkan cannot import video-frame memory, so this says nothing about real GPUs. **The zero-copy question is therefore not answered.** `VideoFrame.copyTo` also cannot show whether a frame is GPU-backed; that needs hardware.
4. **The < 50 ms bar is not met in this environment and cannot be judged here:** it is dominated by decoding N frames from the keyframe at ~4 ms each in software. With hardware decode the per-frame cost should fall by an order of magnitude, but that is untested. The real lever is frames decoded per seek: p50 is about half the GOP. A seek on a long-GOP source (GOP 150, typical for phones and screen recordings) costs 88 frames at p50.
5. Seek behaviour to design for regardless of hardware: after `flush()` the decoder needs a keyframe, so every random seek restarts at a keyframe; only sequential playback and small forward scrubs can reuse decoder state.

**Capability matrix** (M = measured here; U = not measured, expected from public browser docs, must be confirmed on the device).

| | Chrome/Edge desktop | Safari macOS/iOS | Firefox desktop | Android Chrome |
|---|---|---|---|---|
| `VideoDecoder` H.264 | M: software OK | U: expected OK (hardware) | U: expected OK | U: expected OK (MediaCodec) |
| HW decode (`prefer-hardware`) | M: not in this sandbox | U | U | U |
| WebGPU | M: SwiftShader only | U: WebGPU only in recent Safari | U: recent versions, platform dependent | U |
| `importExternalTexture(VideoFrame)` | M: **fails on SwiftShader**; U on real GPU | U | U | U |
| `copyExternalImageToTexture(VideoFrame)` | M: **fails on SwiftShader**; U on real GPU | U | U | U |
| CPU upload fallback | M: works | U (same API) | U | U |
| Frame-accurate seek logic | M: 0 errors / 140 | U | U | U |

**Recommendation.** Design the web decode interface around a **texture-source abstraction with two implementations from day one**: (a) *direct*: `VideoFrame` to `importExternalTexture` (preferred) or `copyExternalImageToTexture`, and (b) *CPU-upload fallback*: `copyTo` + `writeTexture`, selected at runtime by a capability probe plus a startup self-test (import one frame, read a pixel). The fallback is proven and is the guaranteed path; the direct path is the target and may not hold on every browser. Independently of that choice, hit the 50 ms bar by controlling frames-per-seek, not only by decode speed: short-GOP edit proxies (GOP <= 15, which also bounds worst-case seek to ~15 decodes), a decoded-frame cache around the playhead, and prefetch of the next GOP. Keep the engine/WASM boundary as is: the demuxer feeds encoded chunks to JS `VideoDecoder`; decoded frames never enter WASM memory.

**Does the `app-media` `Decoder` trait need a non-CPU frame variant? Yes.** It currently yields RGBA8 frames only, which forces the CPU-upload path (the measured fallback above) on every platform. Recommended shape: `enum FrameData { Cpu(RgbaFrame), Gpu(GpuFrameHandle) }`, where `GpuFrameHandle` is an opaque, `close()`-on-drop token with width, height, pts and colour space. Rust never touches the pixels: on web the handle refers to a JS-side `VideoFrame` held by the engine-client (held in a handle table, released explicitly), on desktop to a platform texture (D3D11/Metal/VAAPI) imported by the renderer; the render crate consumes `Gpu` via the texture-source abstraction and falls back to uploading `Cpu`. The trait should also advertise which variants a decoder can produce, so the probe can pick the path. Keep `Cpu` as the always-available variant (software decode, export, tests).

**Must be confirmed on reference hardware** (re-run `node spikes/s1-webcodecs/run.mjs --gpu default` or open the page, per browser; note `mode=` and `clip=` URL parameters):
1. Whether `importExternalTexture` and `copyExternalImageToTexture` succeed with a hardware-decoded `VideoFrame` on Chrome (Windows D3D11, macOS, Linux VAAPI, Android), Safari (macOS and iOS), Firefox; and whether the frame stays GPU-resident (no readback; compare GPU process activity or `copyTo` cost).
2. Warm seek p50/p95 at 1080p GOP 30 and GOP 150 with hardware decode, on a mid-range laptop and a mid-range phone; then a 4K check.
3. Whether the decode and the GPU work run well inside a Worker (the engine runs there on the web); the spike ran on the main thread.
4. Decoder behaviour under many seeks (memory, frames held by the decoder pool; `VideoFrame.close()` discipline).
5. Colour: `importExternalTexture` colour-space handling for BT.709 vs BT.601 and limited vs full range (the spike's flat white/black blocks do not test it).

Success bar status: **not yet confirmed**. If hardware shows the direct path failing or > 50 ms warm on Chrome or Safari, the plan's fallback applies: CPU-upload path plus a larger prefetch and short-GOP proxies; document the per-browser matrix above.
