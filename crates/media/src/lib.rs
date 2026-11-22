//! # app-media
//!
//! **Owns**: probing (duration, tracks, rotation, VFR detection), demuxers (MP4/MOV, WebM/MKV) that compile to WASM, the `Decoder` trait and
//! host-implemented backends, the frame cache with look-ahead and a byte budget, proxy and thumbnail jobs, VFR-to-CFR mapping, waveform peaks.
//!
//! **Does not own**: encoding (`app-export`) or compositing (`app-render`).
//!
//! **Rules**: decoders are traits implemented by the host (WebCodecs on the web, libav/OS codecs natively) so the engine tests with fakes;
//! demuxers and parsers are fuzzed; see ADR 0004 for what may and may not be linked (no GPL/patent-encumbered encoders).
//!
//! Status: M0 skeleton, empty. First content: `M1-011`, `M1-012`, `M1-013`.
