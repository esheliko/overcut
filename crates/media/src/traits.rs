//! Host-implemented media traits (ADR 0004). No platform crates, no runtime: methods are plain `async fn`s
//! (std only), so the web host can back them with WebCodecs in a worker and native hosts with libav / OS codecs.

use app_model::{Rational, Time};
use std::sync::Arc;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MediaError {
    /// Frame or sample range outside the stream.
    OutOfRange,
    /// The host has no decoder for this codec (UI should say so plainly).
    Unsupported(String),
    /// Read or decode failure reported by the host.
    Io(String),
}

impl std::fmt::Display for MediaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MediaError::OutOfRange => write!(f, "out of range"),
            MediaError::Unsupported(s) => write!(f, "unsupported: {s}"),
            MediaError::Io(s) => write!(f, "i/o error: {s}"),
        }
    }
}
impl std::error::Error for MediaError {}

/// Random-access byte source (file, blob, network range). Hosts implement it; demuxers read through it.
// Intentional: web futures wrap JS promises and are not `Send`.
#[allow(async_fn_in_trait)]
pub trait Source {
    /// Total length in bytes.
    fn len(&self) -> u64;
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
    /// Read up to `buf.len()` bytes at `offset`; returns the count (0 only at end).
    async fn read_at(&self, offset: u64, buf: &mut [u8]) -> Result<usize, MediaError>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VideoInfo {
    pub width: u32,
    pub height: u32,
    pub fps: Rational,
    pub frame_count: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AudioInfo {
    pub sample_rate: u32,
    pub channels: u16,
    pub sample_count: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MediaInfo {
    pub video: Option<VideoInfo>,
    pub audio: Option<AudioInfo>,
}

/// One decoded RGBA8 frame. Cheap to clone (shared buffer); large pixel data never goes through JSON.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VideoFrame {
    pub index: i64,
    pub pts: Time,
    pub width: u32,
    pub height: u32,
    pub data: Arc<[u8]>,
}

impl VideoFrame {
    pub fn byte_size(&self) -> usize {
        self.data.len()
    }
}

/// Interleaved signed 16-bit PCM.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AudioChunk {
    pub start_sample: i64,
    pub channels: u16,
    pub samples: Vec<i16>,
}

/// A decoder for one media file. Frames are addressed by integer index, never by float seconds (ADR 0010);
/// use `Time::frame_index` / `Time::sample_index` to convert.
// Intentional: web futures wrap JS promises and are not `Send`.
#[allow(async_fn_in_trait)]
pub trait Decoder {
    fn info(&self) -> &MediaInfo;
    async fn video_frame(&mut self, index: i64) -> Result<VideoFrame, MediaError>;
    async fn audio(&mut self, start_sample: i64, count: usize) -> Result<AudioChunk, MediaError>;
}
