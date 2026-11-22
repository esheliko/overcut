//! Deterministic fake decoder for tests: numbered frames and a fixed tone. Same inputs, same bytes, every platform.

use crate::traits::*;
use app_model::{Rational, Time};
use std::any::Any;
use std::cell::Cell;
use std::rc::Rc;

pub struct FakeDecoder {
    info: MediaInfo,
    /// Number of `video_frame` calls that actually decoded (cache tests assert on it).
    pub decode_calls: u64,
    kind: FrameKind,
    /// Fake GPU frames currently alive (created minus dropped): tests assert that eviction closes them.
    live_gpu: Rc<Cell<i64>>,
}

/// The "GPU resource" behind a fake GPU frame: it just remembers its frame number and counts itself while alive.
pub struct FakeGpuFrame {
    pub index: i64,
    live: Rc<Cell<i64>>,
}

impl GpuResource for FakeGpuFrame {
    fn as_any(&self) -> &dyn Any {
        self
    }
}

impl Drop for FakeGpuFrame {
    fn drop(&mut self) {
        self.live.set(self.live.get() - 1);
    }
}

impl FakeDecoder {
    pub fn new(width: u32, height: u32, fps: Rational, frame_count: i64, sample_rate: u32) -> Self {
        let spf = Time::from_frame_index(frame_count, fps)
            .and_then(|t| t.sample_index(sample_rate))
            .unwrap_or(0);
        FakeDecoder {
            info: MediaInfo {
                video: Some(VideoInfo {
                    width,
                    height,
                    fps,
                    frame_count,
                }),
                audio: Some(AudioInfo {
                    sample_rate,
                    channels: 2,
                    sample_count: spf,
                }),
            },
            decode_calls: 0,
            kind: FrameKind::Cpu,
            live_gpu: Rc::new(Cell::new(0)),
        }
    }

    /// Number of fake GPU frames not yet dropped.
    pub fn live_gpu_frames(&self) -> i64 {
        self.live_gpu.get()
    }

    /// Frame number of a fake frame: stored in the first 8 bytes (little endian) on the CPU variant, in the resource on the GPU one.
    pub fn frame_number(frame: &VideoFrame) -> i64 {
        match &frame.data {
            FrameData::Cpu(f) => {
                i64::from_le_bytes(f.data[..8].try_into().expect("frame has >= 8 bytes"))
            }
            FrameData::Gpu(h) => h.downcast_ref::<FakeGpuFrame>().map_or(-1, |g| g.index),
        }
    }

    /// Sample `n` of the 440 Hz-ish triangle tone (integer math only, so it is bit-identical everywhere).
    pub fn tone_sample(n: i64) -> i16 {
        let phase = n.rem_euclid(100); // period 100 samples
        let tri = if phase < 50 { phase } else { 100 - phase }; // 0..=50
        ((tri - 25) * 1000) as i16
    }
}

impl Decoder for FakeDecoder {
    fn info(&self) -> &MediaInfo {
        &self.info
    }

    fn frame_kinds(&self) -> FrameKinds {
        FrameKinds::BOTH
    }

    fn set_frame_kind(&mut self, kind: FrameKind) -> Result<(), MediaError> {
        self.kind = kind;
        Ok(())
    }

    async fn video_frame(&mut self, index: i64) -> Result<VideoFrame, MediaError> {
        let v = self.info.video.as_ref().ok_or(MediaError::OutOfRange)?;
        if index < 0 || index >= v.frame_count {
            return Err(MediaError::OutOfRange);
        }
        self.decode_calls += 1;
        let pts = Time::from_frame_index(index, v.fps).ok_or(MediaError::OutOfRange)?;
        if self.kind == FrameKind::Gpu {
            self.live_gpu.set(self.live_gpu.get() + 1);
            let res = FakeGpuFrame {
                index,
                live: self.live_gpu.clone(),
            };
            let est = GpuFrameHandle::estimate_bytes(v.width, v.height);
            let handle = GpuFrameHandle::new(res, est);
            return Ok(VideoFrame::gpu(index, pts, v.width, v.height, handle));
        }
        let len = (v.width as usize) * (v.height as usize) * 4;
        let mut data = vec![(index % 251) as u8; len];
        if len >= 8 {
            data[..8].copy_from_slice(&index.to_le_bytes());
        }
        Ok(VideoFrame::cpu(index, pts, v.width, v.height, data.into()))
    }

    async fn audio(&mut self, start_sample: i64, count: usize) -> Result<AudioChunk, MediaError> {
        let a = self.info.audio.as_ref().ok_or(MediaError::OutOfRange)?;
        if start_sample < 0 || start_sample + count as i64 > a.sample_count {
            return Err(MediaError::OutOfRange);
        }
        let ch = a.channels;
        let mut samples = Vec::with_capacity(count * ch as usize);
        for n in 0..count as i64 {
            let s = Self::tone_sample(start_sample + n);
            for _ in 0..ch {
                samples.push(s);
            }
        }
        Ok(AudioChunk {
            start_sample,
            channels: ch,
            samples,
        })
    }
}
