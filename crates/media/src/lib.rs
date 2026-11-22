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
//! Status: `M1-011` traits + frame cache, `M1-012` MP4/MOV (incl. fragmented) + WebM demux and probe (`probe`), CPU/GPU frame variants. Next: `M1-013`.

mod cache;
mod demux;
mod fake;
mod traits;

pub use cache::{CacheStats, FrameCache};
pub use demux::{
    probe, ContainerFormat, MemSource, Packet, Probe, Track, TrackKind, MAX_PACKETS_PER_TRACK,
    MAX_TRACKS,
};
pub use fake::{FakeDecoder, FakeGpuFrame};
pub use traits::{
    AudioChunk, AudioInfo, Decoder, FrameData, FrameKind, FrameKinds, GpuFrameHandle, GpuResource,
    MediaError, MediaInfo, RgbaFrame, Source, VideoFrame, VideoInfo,
};
