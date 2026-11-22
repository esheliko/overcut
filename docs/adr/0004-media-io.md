# 0004 Media I/O per platform; codec and patent policy
**Status**: proposed (validate with S1, S3, S4)

**Context.** Decoding and encoding must be fast (hardware) and legally safe for a free app. H.264, HEVC and AAC are patent-encumbered; shipping software encoders (x264/x265 are GPL) is a licence and patent liability. Browsers and operating systems already license and expose hardware codecs.

**Decision.**
- **Web**: WebCodecs for decode/encode, with Rust demux/mux compiled to WASM. Codec availability is probed (`Capabilities`) and the UI offers only what works.
- **Desktop**: FFmpeg libav, **LGPL build only, dynamically linked**, no GPL components; hardware encoders (NVENC, AMF, QSV, VideoToolbox, VAAPI/MediaFoundation) first. **openh264** (Cisco binary, royalty-covered) as H.264 software fallback. AV1/VP9/Opus encode in software are royalty-free and allowed.
- **Mobile**: WebView WebCodecs first; native plugins calling MediaCodec / VideoToolbox when the WebView lacks a codec.
- **Defaults**: offer AV1/VP9/Opus where the destination accepts them, H.264/AAC through platform encoders for compatibility; never bundle x264/x265/FDK-AAC.
- Input formats beyond platform support (ProRes, DNxHD, odd containers) are handled by libav on desktop and by an explicit "convert" step on web/mobile.
- A per-platform support matrix lives in this file once S1-S5 produce data.

**Consequences.** Some codec/platform combinations will be unavailable and say so plainly. A legal review before 1.0 (budget in ADR 0011) confirms the policy, in particular for distributing libav and openh264 in app stores.
