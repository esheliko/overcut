//! Host-implemented media traits (ADR 0004). No platform crates, no runtime: methods are plain `async fn`s
//! (std only), so the web host can back them with WebCodecs in a worker and native hosts with libav / OS codecs.

use app_model::{Rational, Time};
use std::any::Any;
use std::rc::Rc;
use std::sync::Arc;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MediaError {
    /// Frame or sample range outside the stream.
    OutOfRange,
    /// The host has no decoder for this codec (UI should say so plainly).
    Unsupported(String),
    /// Read or decode failure reported by the host.
    Io(String),
    /// The file is malformed or truncated (demuxers never panic on hostile input).
    Invalid(String),
}

impl std::fmt::Display for MediaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MediaError::OutOfRange => write!(f, "out of range"),
            MediaError::Unsupported(s) => write!(f, "unsupported: {s}"),
            MediaError::Io(s) => write!(f, "i/o error: {s}"),
            MediaError::Invalid(s) => write!(f, "invalid media: {s}"),
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

/// Pixels in CPU memory: RGBA8, row-major, no padding. Cheap to clone (shared buffer); large pixel data never goes through JSON.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RgbaFrame {
    pub width: u32,
    pub height: u32,
    pub data: Arc<[u8]>,
}

/// What a host keeps alive behind a [`GpuFrameHandle`]: a JS `VideoFrame` on the web, a platform texture / hardware buffer natively.
/// Implementations release the resource in `Drop` (on the web: `VideoFrame.close()`), so a frame evicted from the cache or dropped
/// by the compositor frees GPU memory immediately instead of waiting for a garbage collector. The engine never looks inside; the
/// host downcasts through [`GpuFrameHandle::downcast_ref`] when the renderer imports the frame.
pub trait GpuResource: Any {
    fn as_any(&self) -> &dyn Any;
}

/// Opaque, shared, close-on-drop reference to a decoded frame that lives in GPU (or decoder-owned) memory. Clones share one
/// resource, which is released when the last clone drops. Deliberately not `Send`/`Sync`: web resources are bound to their thread.
#[derive(Clone)]
pub struct GpuFrameHandle {
    res: Rc<dyn GpuResource>,
    est_bytes: usize,
}

impl GpuFrameHandle {
    /// `est_bytes` is what the cache charges for this frame (see [`GpuFrameHandle::estimate_bytes`]).
    pub fn new(resource: impl GpuResource + 'static, est_bytes: usize) -> Self {
        GpuFrameHandle {
            res: Rc::new(resource),
            est_bytes,
        }
    }
    /// Conservative GPU footprint of a `width` x `height` frame: 4 bytes per pixel (RGBA8, or YUV padded up). Hosts that know
    /// the real size pass it to `new` instead.
    pub fn estimate_bytes(width: u32, height: u32) -> usize {
        (width as usize)
            .saturating_mul(height as usize)
            .saturating_mul(4)
    }
    pub fn est_bytes(&self) -> usize {
        self.est_bytes
    }
    /// The host's resource, if it is a `T`.
    pub fn downcast_ref<T: GpuResource>(&self) -> Option<&T> {
        self.res.as_any().downcast_ref::<T>()
    }
    /// True when both handles refer to the same underlying resource.
    pub fn same_resource(&self, other: &GpuFrameHandle) -> bool {
        Rc::ptr_eq(&self.res, &other.res)
    }
}

impl std::fmt::Debug for GpuFrameHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "GpuFrameHandle({} B)", self.est_bytes)
    }
}

impl PartialEq for GpuFrameHandle {
    fn eq(&self, other: &Self) -> bool {
        self.same_resource(other)
    }
}
impl Eq for GpuFrameHandle {}

/// The pixels of a decoded frame, in one of the shapes a decoder can produce (ADR 0004, S1 results).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FrameData {
    Cpu(RgbaFrame),
    Gpu(GpuFrameHandle),
}

/// Which [`FrameData`] variant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameKind {
    Cpu,
    Gpu,
}

/// The set of variants a decoder can produce.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameKinds {
    pub cpu: bool,
    pub gpu: bool,
}

impl FrameKinds {
    pub const CPU: FrameKinds = FrameKinds {
        cpu: true,
        gpu: false,
    };
    pub const GPU: FrameKinds = FrameKinds {
        cpu: false,
        gpu: true,
    };
    pub const BOTH: FrameKinds = FrameKinds {
        cpu: true,
        gpu: true,
    };
    pub fn contains(self, kind: FrameKind) -> bool {
        match kind {
            FrameKind::Cpu => self.cpu,
            FrameKind::Gpu => self.gpu,
        }
    }
}

/// One decoded frame. Cheap to clone (shared pixels or shared GPU resource).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VideoFrame {
    pub index: i64,
    pub pts: Time,
    pub width: u32,
    pub height: u32,
    pub data: FrameData,
}

impl VideoFrame {
    /// A CPU RGBA frame (`data.len()` must be `width * height * 4`).
    pub fn cpu(index: i64, pts: Time, width: u32, height: u32, data: Arc<[u8]>) -> Self {
        VideoFrame {
            index,
            pts,
            width,
            height,
            data: FrameData::Cpu(RgbaFrame {
                width,
                height,
                data,
            }),
        }
    }
    pub fn gpu(index: i64, pts: Time, width: u32, height: u32, handle: GpuFrameHandle) -> Self {
        VideoFrame {
            index,
            pts,
            width,
            height,
            data: FrameData::Gpu(handle),
        }
    }
    pub fn kind(&self) -> FrameKind {
        match self.data {
            FrameData::Cpu(_) => FrameKind::Cpu,
            FrameData::Gpu(_) => FrameKind::Gpu,
        }
    }
    pub fn as_cpu(&self) -> Option<&RgbaFrame> {
        match &self.data {
            FrameData::Cpu(f) => Some(f),
            FrameData::Gpu(_) => None,
        }
    }
    pub fn as_gpu(&self) -> Option<&GpuFrameHandle> {
        match &self.data {
            FrameData::Gpu(h) => Some(h),
            FrameData::Cpu(_) => None,
        }
    }
    /// Bytes the frame cache charges: the pixel buffer, or the handle's estimated GPU footprint.
    pub fn byte_size(&self) -> usize {
        match &self.data {
            FrameData::Cpu(f) => f.data.len(),
            FrameData::Gpu(h) => h.est_bytes(),
        }
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
    /// Frame variants this decoder can produce (a WebCodecs backend: both; a software one: CPU only). Default: CPU only.
    fn frame_kinds(&self) -> FrameKinds {
        FrameKinds::CPU
    }
    /// Choose which variant `video_frame` returns from now on. `Unsupported` if the decoder cannot produce it.
    fn set_frame_kind(&mut self, kind: FrameKind) -> Result<(), MediaError> {
        if self.frame_kinds().contains(kind) {
            Ok(())
        } else {
            Err(MediaError::Unsupported(format!(
                "decoder cannot produce {kind:?} frames"
            )))
        }
    }
    async fn video_frame(&mut self, index: i64) -> Result<VideoFrame, MediaError>;
    async fn audio(&mut self, start_sample: i64, count: usize) -> Result<AudioChunk, MediaError>;
}
