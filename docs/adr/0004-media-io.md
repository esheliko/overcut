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

## S3 results (M1-014, browser encode and mux)
Spike: `spikes/s3-encode/` (Worker harness, runner, ffmpeg-based verifier; README there). Question and bar: WebCodecs encode + MP4/WebM mux in a Worker, 1080p30 5 min at >= 1x on a reference phone browser, A/V sync drift < 1 frame.

**What was measured, and where.** Chromium 153 (Playwright build), headless, Linux, 4 shared vCPU, **no GPU, no hardware encoder** (`prefer-hardware` unsupported for every codec). All speeds below are **software encode in a sandbox and are not representative** of any reference device. Scene: 1080p30 synthetic (moving bar, frame counter, gradient), one all-white flash frame each second; audio: 48 kHz stereo, 3 ms click starting at the exact timestamp of each flash frame; 8 Mbps target, keyframe every 2 s, `latencyMode: quality`. Output verified by decoding with ffmpeg as a player would and comparing flash-frame pts with click onsets, once per second.

| Output | Length | Encode speed (x realtime / fps) | File size | Sync (max abs offset, drift) | Frames out |
|---|---|---|---|---|---|
| H.264 High 4.0 + Opus, MP4 | 5 min | 2.17x / 65 fps (138 s) | 249 MB | 0.31 ms (0.01 frame), 0 ms/min | 9000 of 9000 |
| VP9 + Opus, WebM | 5 min | 2.34x / 70 fps (128 s) | 198 MB | 0.31 ms, 0 ms/min | 9000 of 9000 |
| VP9 + Opus, MP4 | 1 min | 2.15x / 65 fps | 39 MB | 0.31 ms, 0 ms/min | 1800 of 1800 |
| AV1 + Opus, MP4 and WebM | 1 min | 1.55x / 46 fps | 16 MB | 0.31 ms, 0 ms/min | 1800 of 1800 |

All 300 (or 60) flashes and clicks were found in every run. The constant 0.31 ms is the click-onset detector's own bias (same value in every file), not drift. The scene generator cost about 0.4 s of the 130 s (0.3%), so the numbers are encoder-bound. File sizes reflect a noisy synthetic scene at a fixed target and say nothing about real footage.

**Findings.**
1. **Sync is correct by construction, drift is zero.** Timestamps are integer microseconds `round(i * 1e6 / fps)` for video and `round(samples / 48000 * 1e6)` for audio, both from 0, muxed with `firstTimestampBehavior: strict`. No edit list was needed or written (video and audio both start at 0). Video and audio durations agree (300.00 s vs 300.02 s, the last Opus frame). Caveat: ffmpeg decodes Opus honouring the pre-skip; a player that ignores `dOps` pre-skip would shift audio by up to 6.5 ms, still far under one frame (33 ms).
2. **Codecs that exist in this Chromium:** H.264 (via the browser's bundled OpenH264, High 4.0 yes, Constrained Baseline 3.1 `avc1.42001f` no), VP8, VP9, AV1, Opus. **Not available: AAC (`mp4a.40.2`), HEVC, FLAC.** So the "MP4 with AAC" default could not be exercised here; the MP4 files carry Opus (valid per spec, but weak player support, see presets). The spike code selects AAC automatically where `AudioEncoder.isConfigSupported` says yes; that path is untested.
3. **Progress and cancel work.** One progress event per second (fraction, frames, fps). Cancel closes both encoders without a flush and drops the muxer: 2.5 ms to close in the encoder-bound steady state, no output produced. Backpressure (`encodeQueueSize > 4` waits for `dequeue`) kept memory flat while encoding.
4. **Memory is the real constraint, not speed.** An in-memory muxer target held the whole 249 MB file, and handing it to `fetch` as one body crashed the tab (Target crashed; slicing the upload into 8 MB parts fixed the harness). A shipped exporter must **stream the muxer output to OPFS or disk** (`StreamTarget` + `FileSystemSyncAccessHandle` in the Worker, with `fastStart: false` or fragmented MP4, accepting moov-at-end unless a second pass moves it), and never hold the file in a JS heap, least of all on a phone.
5. **Muxing cost is negligible:** `finalize()` took 0.1 to 0.6 s for a 5 min file.

**Muxer decision.** Use **`mp4-muxer` and `webm-muxer` (Vanilagy, MIT, pure TypeScript, no dependencies)** for M1, behind a narrow `Muxer` interface in `engine-client` so the implementation can be swapped. Why: the encoded chunks are born in JS (`EncodedVideoChunk`), crossing into WASM would copy every frame for no gain; the libraries already do B-frame composition offsets, AV1/VP9/AVC/AAC/Opus boxes and streaming targets; MIT is compatible with "free means free". A Rust muxer in `crates/export` stays the plan for desktop and for the later libav-free native path; it is not needed to answer S3. Check before pinning: the author's README now points users to a successor library (Mediabunny); confirm its licence (we believe MPL-2.0, file-level copyleft) and maintenance before choosing between them. Dev-only: the spike's `package.json` is not a workspace member, so these libraries are not in the root lockfile or the bundle yet.

**Muxer decision, confirmed (M1-022, 2026-11-22): Mediabunny 1.66.2 (MPL-2.0), pinned exactly in `packages/engine-client`.** `mp4-muxer` 5.2.2 (MIT) is marked deprecated on npm ("superseded by Mediabunny", last release July 2025); Mediabunny is the same author's successor, released continuously (1.66.x, last publish 19 Nov 2026), one library for MP4 and WebM, no runtime dependencies (types only). MPL-2.0 is file-level copyleft: it may be combined into a GPL-3.0 application (MPL 2.0 section 3.3, "Secondary License"), and we do not modify its files; the apps are GPL-3.0 and `engine-client` is MIT OR Apache-2.0, so **the licence note for the package is: Mediabunny stays MPL-2.0 and its notice ships with the app** (add to the third-party notices when they exist). It is imported only in `export/mux.ts` behind the `Muxer` interface and bundles into the export Worker chunk only (the main bundle is unchanged). Behaviour confirmed in a real browser: `StreamTarget` with positioned writes to an OPFS `FileSystemSyncAccessHandle`, MP4 `fastStart: "reserve"` (index at the start, no whole-file memory; about 2 MB reserve for a 5 min file), WebM clusters, timestamps snapped to the frame rate. See `docs/features/export.md`.

**Recommended default export presets** (probe with `VideoEncoder.isConfigSupported` / `AudioEncoder.isConfigSupported` at startup and offer only what passes; hardware first; follows the policy above: never bundle a patent-encumbered software encoder, rely on codecs the browser or OS has licensed).

| Platform | Default | Why / fallback |
|---|---|---|
| Chrome / Edge desktop | **H.264 High + AAC in MP4** when the probe passes (hardware where present); else **VP9 + Opus in WebM** | Most compatible file; VP9/Opus is the royalty-free fallback and encodes at 2.3x even in software here. AV1 + Opus as an optional "smaller file" preset only if hardware AV1 encode is present (software AV1 was the slowest, 1.55x). |
| Android Chrome | **H.264 + AAC MP4**, hardware (MediaCodec) | Software VP9/AV1 on a phone is expected to be < 1x; do not default to them. If H.264 fails the probe, offer VP9/WebM with a "slow" warning and a time estimate. |
| Safari macOS / iOS | **H.264 + AAC MP4** (VideoToolbox) | Expected to be the only supported encode path; VP9/AV1 WebCodecs encode is not assumed. Unmeasured. |
| Firefox | Whatever the probe reports; default **VP9 + Opus WebM** if H.264 is absent | Unmeasured. |
| Any browser, no AAC | MP4 with H.264 + **Opus** is spec-valid but poorly supported by phones, TVs and some editors: default to **WebM (VP9 + Opus)** and label MP4/Opus "limited compatibility" | This is exactly the situation in the sandbox. |
| Desktop app | Platform hardware H.264/HEVC encoders, openh264 fallback, AV1/VP9/Opus software | Unchanged from the Decision above. |

Always show an estimated time before export (from a short measured trial encode), keep the preset list free of codecs the probe rejected, and keep resolution/bitrate choices in the preset, not in per-codec UI.

**Must be confirmed on reference hardware** (S24 Chrome, iPhone 14 Safari, M1 Mac Safari and Chrome, i5 laptop Chrome and Firefox, and a low-end Android as proxy for the worst case). Run `node spikes/s3-encode/run.mjs --hw prefer-hardware ...` or call `window.__start` from `spikes/s3-encode/index.html` per browser:
1. 1080p30 5 min speed with **hardware** H.264 (and AAC) vs the >= 1x bar; also 1080p60 and 4K to find the ceiling; whether software VP9 ever reaches 1x on a phone.
2. Whether AAC (`mp4a.40.2`) encode is offered on each browser, and Safari's H.264 profile/level constraints.
3. Sync with **B-frames** and with real AAC priming (1024-sample delay, edit list expected): this spike's encoders produced no B-frames and Opus only.
4. Memory and thermal behaviour on a phone over a 5 min export, with a streaming target (OPFS) and with the tab backgrounded (Safari and Android suspend workers); resume/cancel behaviour.
5. Real footage (not a synthetic scene): bitrate control (`bitrateMode` constant vs variable), quality at the preset bitrates, and the frame-upload cost from the render path (`VideoFrame` from a WebGPU canvas or `copyTo`, S2), which this spike did not include.

Success bar status: **sync < 1 frame: met** (0.01 frame, no drift, 5 min H.264 and VP9). **>= 1x on a reference phone: not confirmed** (software sandbox only, 1.5x to 2.3x on 4 shared vCPU). If hardware H.264 fails the bar or is absent, the plan's fallback applies: narrow default presets (VP9/WebM or lower resolution) and WASM software encoders only as an explicit, opt-in fallback.

## S4 results (M1-015, desktop: libav behind the same traits)
Spike: `apps/desktop/native-media/` (crate `app-native-media`, its own cargo workspace so `verify` never needs libav; GPL-3.0-or-later like the app that links it; the engine crates stay MIT/Apache). Question: can the desktop app decode and export with libav through the **same** interfaces as the web (`app_media::PacketDecoder` under `HostDecoder`; the export loop's encoder ports), so an OS-framework backend (VideoToolbox / Media Foundation direct) can replace libav later without touching the engine or the UI.

**Verdict: yes on Linux in software; hardware paths written but unverified (no GPU here).** All numbers below are from a 4-vCPU Linux container with Ubuntu's libav 6.1 (a **GPL** build: it has `libx264` and no `libopenh264`, so the software encoder measured is libx264, a dev stand-in. It is never in `H264_PREFERENCE`).

### What was built
- **Decode** (`decode.rs`, `LibavHost`): the Rust demuxer (`probe`) and `HostDecoder` plan which packets to feed, exactly as on the web; the host reads those bytes from the file, runs a libav codec (extradata = avcC / hvcC / AudioSpecificConfig / OpusHead from the probe, no libavformat demux at all) and returns RGBA or f32 PCM. Same frame selection, same timestamps, same `MediaInfo` JSON as the web decoder.
- **GOP cache**: the first request inside a GOP decodes the whole GOP once and keeps its raw YUV frames (budget 384 MB, longer GOPs fall back to decode-to-target). Without it a sequential walk (export) is O(GOP^2): measured 8 fps at 1080p, 2 s GOP; with it 172 fps sequential, 47 fps random access.
- **Encode** (`encode.rs`, `Mp4Encoder`): RGBA frames + interleaved f32 PCM in, MP4 (`+faststart`) with H.264 + AAC out. H.264 is the first of `H264_PREFERENCE` that opens: `h264_videotoolbox`, `h264_nvenc`, `h264_qsv`, `h264_amf`, `h264_mf`, then **`libopenh264`** (Cisco binary). AAC is libav's own native encoder. No B-frames (pts == dts, no edit list, export order == display order). QSV / MF / AMF get NV12. VAAPI is not in the list: it needs a hardware frame context (follow-up).
- **Licence guards**: `libav_license()` / `libav_is_lgpl()` read `avcodec_license()` of the loaded library; the `check` example fails on a GPL build; a unit test pins that `H264_PREFERENCE` never names x264 / x265 / fdk.
- **Wiring**: Tauri commands `native_media_*`, `native_export_*`, `native_stash_*` (`apps/desktop/src-tauri/src/native.rs`, behind the cargo feature `native-media`; pixels and PCM cross as raw binary IPC, never JSON). `packages/engine-client/src/tauri.ts` now implements `Engine.media.open` (`native-media.ts`: same `MediaHandle` contract, frames are CPU RGBA) and `Engine.export` (`export/native.ts`): the **same** loop (`runExport`: evaluate, decode, composite on the GPU with the wasm compositor in the webview, encode) with the browser's WebCodecs + muxer replaced by the native encoder. Cancel, progress, back-pressure (one frame in flight) and the typed `ExportError`s are the browser's. Files picked in the webview without a path are staged to a temp file in 8 MB chunks; a path-carrying `Blob` (dialog / drop) is decoded in place.
- `ExportSettings` the desktop cannot honour yet (WebM, VP9, AV1, Opus) reject with `unsupported` up front; `auto` is MP4 H.264 + AAC.

### Parity (Linux, software; `apps/desktop/native-media/tests/parity.rs`, run with `cargo test --release` there)
- Video: frames of `h264_aac.mp4`, `h264_aac.mov`, `frag.mp4`, `vp9_opus.webm` vs the `ffmpeg` CLI (RGBA): mean absolute error <= 2/255 per channel on every 7th frame + the last (measured below the bound; swscale rounding only). Flash fixture: frame 30 is white, 29 and 31 black; frame count and index/pts preserved.
- Audio: AAC vs `ffmpeg` f32: max abs error <= 0.02 over 0.5 s mid-stream; the 1 kHz click starts within 10 ms of 1.000 s. **Opus: aligned to the sample at stream start; mid-stream up to 1 ms (48 samples) off**, because Matroska timestamps are whole milliseconds (a chirp, not a sine, so an offset cannot hide). Finding that applies to the web decoder too: with the engine's 4-packet pre-roll an Opus decoder has **not converged 0.19 s into the stream** (steady tone at 24 kbps: peak -20 %; converged by 0.6 s). A larger Opus pre-roll (8 to 10 packets) in `crates/media` `plan_audio` is the fix; not done here (shared with the web; its tests pin <= 4).
- Encoder round trip: 30 synthetic frames + 1 s of 440 Hz through `Mp4Encoder`, re-opened by the native decoder: 30 frames, grey ramp within 12/255 (lossy), tone peak 0.35..0.6, `finish` reports 30 frames / 48 000 samples.
- Not covered (no fixtures or hardware): HEVC / AV1 / ProRes, hardware decode, VFR export (refused as on the web), 10-bit.

### Speed (1080p30, 150 frames, synthetic moving texture, software libx264, 4 shared vCPU: **not a device number**)
Encode 46 fps (1.5x realtime) incl. RGBA -> YUV conversion; sequential decode 172 fps; random access 47 fps. The per-frame IPC cost of the webview export (8 MB RGBA out of the GPU readback, into Rust) is **unmeasured** (no webview here); at 1080p30 that is 249 MB/s of copies through Tauri's binary IPC. If it shows up on the M1 / i5, the follow-up is to encode from a GPU-shared buffer or to composite natively (wgpu in the shell).

### Known gaps / follow-ups
- Hardware encoders: compile-checked only. VideoToolbox, Media Foundation, NVENC, QSV, AMF each need a run on real hardware (checks below). VAAPI missing.
- Hardware **decode** is not wired (`frame_kinds()` is CPU only): GPU frames need the compositor to import them (S1 / S2 path).
- `MediaHandle.stream()` is frame-by-frame over `videoFrame` (correct, benefits from the GOP cache, no read-ahead).
- Export runs its loop on the webview main thread (Tauri `invoke` is unavailable in Workers); everything heavy is native or on the GPU, per-frame JS work is a readback hand-off. Revisit if the M1 / i5 numbers show UI jank.
- Audio export is always 2 channels (mono media is copied to both), AAC-LC only, 192 kb/s default. Priming / edit-list for AAC unmeasured (as on the web).
- CI: nothing builds `apps/desktop/native-media` or the `native-media` feature yet (no libav on the runners): process issue filed.

### Shipping plan (needs the owner's go-ahead; not implemented)
**Rule: the app only ever loads an LGPL libav that we build ourselves from a pinned source, as shared libraries, and replaceable by the user.**
1. **Pinned build script** (`scripts/libav/build.sh`, one per OS, run by a release job on tag): downloads the FFmpeg release tarball by version + SHA-256, builds with `--enable-shared --disable-static --disable-gpl --disable-nonfree --disable-autodetect --disable-everything` plus an allow-list: decoders `h264 hevc vp8 vp9 av1(libdav1d, BSD) aac aac_latm mp3 opus vorbis flac pcm_*`; encoders `aac` + the hardware ones per OS (`h264_videotoolbox` on macOS; `h264_mf h264_nvenc h264_qsv h264_amf` on Windows via `--enable-mediafoundation --enable-nvenc --enable-libvpl --enable-amf`, nv-codec-headers / AMF headers are MIT and NVENC / AMF load their driver DLLs at run time; `libopenh264` on all three); muxer `mov` / `mp4`; protocols `file`; filters none; libswscale + libswresample. libavformat's demuxers are **not needed** (the Rust demuxer feeds packets), which is what makes the trimmed build small. `libx264`, `libx265`, `libfdk_aac` never appear.
2. **Bundling**: macOS `OverCut.app/Contents/Frameworks/libav*.dylib` (codesigned + notarised with the app, `@rpath`); Windows `libav*.dll` beside `OverCut.exe` (the installer's `resources`); Linux AppImage / deb `usr/lib/overcut/libav*.so`. Tauri `bundle.resources` / `externalBin` carry them; the Rust crates link dynamically (`ffmpeg-next` without its `build` feature, `FFMPEG_DIR` pointing at our build in CI).
3. **LGPL obligations**: (a) dynamic linking only; (b) an in-app "Open source licences" page listing FFmpeg (LGPL 2.1+) with the exact version, our `configure` line and a link to the matching source tarball + our build script, hosted with the release; (c) the app is GPL-3.0 so relinking is not a restriction, but we still ship the libs as separate files a user can replace, and `libav_license()` is checked at start (a GPL-flavoured library is refused for H.264 export in release builds); (d) no patent grant is claimed for HEVC / AAC beyond what the platform or the user's own licence gives (ADR 0004, legal review before 1.0).
4. **openh264**: per Cisco's terms the royalty cover applies to **Cisco's binary, downloaded from Cisco's host unmodified**. We do not build it from source. The app fetches `libopenh264-<ver>-<os>-<arch>` from Cisco on first use of software H.264 export (hash-pinned, stored in the app data dir, opt-out and offline fallback = "H.264 hardware only, or VP9 / AV1 export in a later milestone"), and `dlopen`s it through libav (`--enable-libopenh264 --enable-runtime-cpudetect`). Until that downloader exists, software H.264 on the desktop is unavailable and the UI says so.
5. **Size budget**: trimmed libs <= **10 MB per platform** in total (estimate from comparable trimmed builds, **not built yet**: Ubuntu's full libav here is 15.8 MB libavcodec + 2.7 libavformat + 1.0 libavutil + 0.6 libswscale + 0.1 libswresample = 20 MB, before its codec dependencies). The linking Rust code itself is small (the `check` example binary is 0.8 MB). The release job fails if the bundled libav exceeds 12 MB. A fully dropped libavformat (own MP4 muxer) saves ~1 MB later if wanted.
6. **Replaceability for later**: the traits are the seam: `PacketDecoder` (decode) and the loop's `VideoPort` / `AudioPort` (encode). A VideoToolbox / Media Foundation backend implements the same two interfaces (`kind: Gpu` frames are already in `FrameKind`), and the libav dependency can be deleted per OS with no change in `crates/*` or the UI.

### Checks to run on the owner's machines (about 10 minutes each; send me the output)
Install Rust (rustup) and a **LGPL** libav dev build (macOS: `brew install ffmpeg` is GPL-flavoured: use the pinned build script once it exists, or for this first look accept the GPL warning, which is expected and harmless in the check; Windows: a shared LGPL build from BtbN `ffmpeg-n7.1-latest-win64-lgpl-shared-7.1` and `FFMPEG_DIR` pointing at it, plus LLVM for bindgen).
1. `cd apps/desktop/native-media && cargo run --release --example check` (add `-- libx264` only to see a software number on a GPL build).
   - Expect: the list "H.264 encoders that open at 1920x1080" shows **`h264_videotoolbox` = YES on the M1**, and **`h264_mf` and/or `h264_nvenc` / `h264_qsv` / `h264_amf` = YES on the i5 laptop** (Intel iGPU: QSV or MF). `using encoder:` names the hardware one. Write down: encode fps (target >= 30 for 1080p30 = realtime), decode fps sequential (target >= 60), the licence line (LGPL on a pinned build).
2. `cargo test --release` in the same folder (decode parity and the encoder round trip; needs `ffmpeg` on the PATH for the reference comparisons, otherwise they print "skipping").
3. Desktop app: `cd apps/desktop && cargo tauri dev --features native-media` (Windows / macOS). Import an H.264 + AAC clip (a phone video), put it on the timeline, scrub (frames must appear), then export with the default settings: the file must play in QuickTime / Windows Media Player / VLC with sound in sync, duration equal to the timeline. Write down: export time for a 1 min 1080p30 clip, whether the window stayed responsive, CPU / GPU use from Activity Monitor / Task Manager (hardware encoder should show the media engine, not 100 % CPU).
4. Same with an HEVC clip (iPhone default, "Most Compatible" off) and a VFR phone clip: expect HEVC to decode (libav software HEVC) and VFR to be refused with the plain message.
5. Battery / thermal: a 5 min 1080p30 export on battery, note the laptop temperature behaviour (S5 territory, one line is enough).
