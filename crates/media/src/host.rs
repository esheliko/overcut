//! Host-backed decoder (M1-016): the engine plans, the host decodes.
//!
//! [`HostDecoder`] implements [`Decoder`] on top of a demuxed [`Track`] (the packet table from `probe`) and a host-implemented
//! [`PacketDecoder`]. Rust does everything that is pure logic and testable natively: frame index to packet, previous-keyframe
//! pre-roll, which packets to feed, which timestamp is the target. The host does the part only it can: read the packet bytes
//! (`Blob.slice` on the web), run the codec (WebCodecs `VideoDecoder` / `AudioDecoder` in a Worker), drop intermediate frames,
//! close what it does not return, and keep the requested frame alive behind a [`GpuFrameHandle`] or hand back RGBA.
//! Cancellation of a superseded seek is host-side (a generation counter): the host fails the stale request with
//! [`MediaError::Cancelled`].

use crate::demux::{Packet, Track, TrackKind};
use crate::traits::*;
use app_model::{Time, TICKS_PER_SECOND};
use std::sync::Arc;

/// One compressed packet as the host needs it: where its bytes are and the timestamps to put on the `EncodedVideoChunk`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PacketRef {
    pub offset: u64,
    pub size: u32,
    pub keyframe: bool,
    /// Presentation time in microseconds (the WebCodecs timestamp unit); unique per frame, so the host matches output by it.
    pub ts_us: i64,
    pub dur_us: i64,
}

/// "Decode this and give me the last packet's frame." `packets` are in decode order, start at a keyframe (pre-roll) and end at the
/// target frame's packet; every earlier output frame is an intermediate to drop.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VideoRequest {
    pub frame_index: i64,
    pub target_ts_us: i64,
    pub packets: Vec<PacketRef>,
}

/// "Give me `count` frames of f32 PCM starting at `start_sample`, at `rate` Hz (resampled from the file's rate if it differs)."
/// `packets` cover the range with `preroll_packets` leading packets that only prime the decoder (codec delay, e.g. Opus 80 ms).
#[derive(Clone, Debug, PartialEq)]
pub struct AudioRequest {
    pub start_sample: i64,
    pub count: usize,
    pub rate: u32,
    pub packets: Vec<PacketRef>,
    pub preroll_packets: usize,
    /// The packets start at the first packet of the stream (codecs that trim a start delay, like Opus pre-skip, do so only then).
    pub from_start: bool,
    /// Source-time of the first packet's first sample, in microseconds.
    pub first_ts_us: i64,
}

/// What a video decode returns.
pub struct VideoOut {
    pub width: u32,
    pub height: u32,
    pub data: FrameData,
}

/// Implemented by the host (WebCodecs backend in `engine-client`, native libav later). Futures need not be `Send`.
#[allow(async_fn_in_trait)]
pub trait PacketDecoder {
    /// Frame variants this host can return.
    fn frame_kinds(&self) -> FrameKinds;
    async fn decode_video(
        &mut self,
        req: &VideoRequest,
        kind: FrameKind,
    ) -> Result<VideoOut, MediaError>;
    /// Interleaved f32 PCM, exactly `count * channels` values, silence past the end of the stream.
    async fn decode_audio(&mut self, req: &AudioRequest) -> Result<Vec<f32>, MediaError>;
}

/// Ticks to WebCodecs microseconds, rounded to nearest.
pub fn ticks_to_us(t: Time) -> i64 {
    let n = t.ticks() as i128 * 1_000_000;
    let d = TICKS_PER_SECOND as i128;
    ((n + if n >= 0 { d / 2 } else { -(d / 2) }) / d) as i64
}

/// A packet as the host sees it.
pub fn packet_ref(p: &Packet) -> PacketRef {
    PacketRef {
        offset: p.offset,
        size: p.size,
        keyframe: p.keyframe,
        ts_us: ticks_to_us(p.pts),
        dur_us: ticks_to_us(p.duration),
    }
}

/// Decoder over a probed file. `audio_rate` is the project rate: `audio()` addresses and returns samples at that rate.
pub struct HostDecoder<H: PacketDecoder> {
    host: H,
    info: MediaInfo,
    video: Option<Track>,
    audio: Option<Track>,
    /// Video packet indices (decode order) sorted by presentation time: frame `i` is `present[i]`.
    present: Vec<usize>,
    audio_rate: u32,
    kind: FrameKind,
}

impl<H: PacketDecoder> HostDecoder<H> {
    /// `tracks`: the first video and first audio track of a `probe` (pass `None` to ignore one). Errors if neither is given.
    pub fn new(
        host: H,
        video: Option<Track>,
        audio: Option<Track>,
        audio_rate: u32,
    ) -> Result<Self, MediaError> {
        if video.is_none() && audio.is_none() {
            return Err(MediaError::Invalid("no audio or video track".into()));
        }
        if video.as_ref().is_some_and(|t| t.kind != TrackKind::Video)
            || audio.as_ref().is_some_and(|t| t.kind != TrackKind::Audio)
            || audio_rate == 0
        {
            return Err(MediaError::Invalid("wrong track kind or rate".into()));
        }
        let mut present: Vec<usize> = Vec::new();
        let mut info = MediaInfo::default();
        if let Some(v) = &video {
            present = (0..v.packets.len()).collect();
            present.sort_by_key(|&i| (v.packets[i].pts, i));
            // Container frame rate; VFR sources are mapped to CFR by the caller (M1-013), here we report the nominal rate.
            let fps = v
                .nominal_fps
                .or_else(|| {
                    let n = (v.packets.len() as i64).checked_mul(TICKS_PER_SECOND)?;
                    app_model::Rational::new(n, v.duration.ticks())
                })
                .unwrap_or(app_model::Rational::FPS_30);
            info.video = Some(VideoInfo {
                width: v.width,
                height: v.height,
                fps,
                frame_count: v.packets.len() as i64,
            });
        }
        if let Some(a) = &audio {
            let samples = a
                .duration
                .sample_index(audio_rate)
                .ok_or_else(|| MediaError::Invalid("audio duration".into()))?;
            info.audio = Some(AudioInfo {
                sample_rate: audio_rate,
                channels: a.channels,
                sample_count: samples,
            });
        }
        Ok(HostDecoder {
            host,
            info,
            video,
            audio,
            present,
            audio_rate,
            kind: FrameKind::Cpu,
        })
    }

    pub fn host(&self) -> &H {
        &self.host
    }
    pub fn host_mut(&mut self) -> &mut H {
        &mut self.host
    }

    /// The decode request for video frame `index` (pure; tested without a host).
    pub fn plan_video(&self, index: i64) -> Result<VideoRequest, MediaError> {
        let v = self.video.as_ref().ok_or(MediaError::OutOfRange)?;
        let target = usize::try_from(index)
            .ok()
            .and_then(|i| self.present.get(i).copied())
            .ok_or(MediaError::OutOfRange)?;
        let tpts = v.packets[target].pts;
        // Latest keyframe at or before the target in decode order whose pts is not after the target (an open-GOP leading frame
        // needs the previous GOP, so an earlier keyframe is chosen for it). No such keyframe: the stream starts mid-GOP.
        let key = (0..=target)
            .rev()
            .find(|&i| v.packets[i].keyframe && v.packets[i].pts <= tpts)
            .ok_or_else(|| MediaError::Invalid("no keyframe before frame".into()))?;
        Ok(VideoRequest {
            frame_index: index,
            target_ts_us: ticks_to_us(tpts),
            packets: v.packets[key..=target].iter().map(packet_ref).collect(),
        })
    }

    /// The decode request for `count` samples at `start_sample` of the output rate (pure).
    pub fn plan_audio(&self, start_sample: i64, count: usize) -> Result<AudioRequest, MediaError> {
        let a = self.audio.as_ref().ok_or(MediaError::OutOfRange)?;
        let total = self.info.audio.as_ref().map_or(0, |i| i.sample_count);
        if start_sample < 0 || start_sample.saturating_add(count as i64) > total {
            return Err(MediaError::OutOfRange);
        }
        let from =
            Time::from_sample_index(start_sample, self.audio_rate).ok_or(MediaError::OutOfRange)?;
        let to = Time::from_sample_index(start_sample + count as i64, self.audio_rate)
            .ok_or(MediaError::OutOfRange)?;
        // Packets overlapping [from, to), plus some before them to prime the codec: 4 packets cover AAC/MP3 overlap, but an Opus decoder has not
        // converged after 4 packets (peak -20 % at 0.19 s, converged by 0.6 s: ADR 0004 S4 results), so Opus gets a time-based pre-roll.
        const PREROLL: usize = 4;
        let opus_preroll =
            Time::from_sample_index(self.audio_rate as i64 * 6 / 10, self.audio_rate)
                .ok_or(MediaError::OutOfRange)?;
        let ps = &a.packets;
        let first = ps
            .iter()
            .position(|p| p.pts.checked_add(p.duration).is_some_and(|e| e > from))
            .unwrap_or(ps.len());
        let end = ps.iter().position(|p| p.pts >= to).unwrap_or(ps.len());
        let mut begin = first.saturating_sub(PREROLL);
        if a.codec.starts_with("opus") {
            let wanted = from.checked_sub(opus_preroll).unwrap_or(from);
            while begin > 0 && ps[begin].pts > wanted {
                begin -= 1;
            }
        }
        let end = end.max(first);
        let slice = &ps[begin..end];
        Ok(AudioRequest {
            start_sample,
            count,
            rate: self.audio_rate,
            packets: slice.iter().map(packet_ref).collect(),
            preroll_packets: first - begin,
            // "At the stream start" means the request itself lies in the first few packets. A longer Opus pre-roll can reach packet 0 for a request at 0.5 s;
            // that is still a mid-stream request as far as the decoder's pre-skip handling goes (measured: the web decoder needs the shift there).
            from_start: first <= PREROLL,
            first_ts_us: slice.first().map_or(0, |p| ticks_to_us(p.pts)),
        })
    }
}

impl<H: PacketDecoder> HostDecoder<H> {
    /// Like [`Decoder::audio`] but keeps the host's f32 PCM (interleaved, at the output rate) instead of narrowing to i16.
    pub async fn audio_f32(
        &mut self,
        start_sample: i64,
        count: usize,
    ) -> Result<Vec<f32>, MediaError> {
        // Silence past the end of the stream (the contract of `MediaHandle.audio`): phone clips routinely carry an audio track a few frames shorter than the
        // video, and the export asks for audio up to the end of the picture. Only the part inside the stream is decoded; the rest is zeros.
        let total = self.info.audio.as_ref().map_or(0, |i| i.sample_count);
        let channels = self.info.audio.as_ref().map_or(2, |a| a.channels) as usize;
        if self.audio.is_none() || start_sample < 0 {
            return Err(MediaError::OutOfRange);
        }
        let avail = (total.saturating_sub(start_sample)).clamp(0, count as i64) as usize;
        if avail == 0 {
            return Ok(vec![0.0; count * channels]);
        }
        let req = self.plan_audio(start_sample, avail)?;
        let mut pcm = self.host.decode_audio(&req).await?;
        if pcm.len() != avail * channels {
            return Err(MediaError::Io(format!(
                "host returned {} samples, expected {}",
                pcm.len(),
                avail * channels
            )));
        }
        pcm.resize(count * channels, 0.0);
        Ok(pcm)
    }
}

impl<H: PacketDecoder> Decoder for HostDecoder<H> {
    fn info(&self) -> &MediaInfo {
        &self.info
    }
    fn frame_kinds(&self) -> FrameKinds {
        self.host.frame_kinds()
    }
    fn set_frame_kind(&mut self, kind: FrameKind) -> Result<(), MediaError> {
        if !self.frame_kinds().contains(kind) {
            return Err(MediaError::Unsupported(format!(
                "decoder cannot produce {kind:?} frames"
            )));
        }
        self.kind = kind;
        Ok(())
    }

    async fn video_frame(&mut self, index: i64) -> Result<VideoFrame, MediaError> {
        let req = self.plan_video(index)?;
        let pts = self.video.as_ref().map(|v| {
            let t = self.present[index as usize];
            v.packets[t].pts
        });
        let out = self.host.decode_video(&req, self.kind).await?;
        let pts = pts.ok_or(MediaError::OutOfRange)?;
        Ok(VideoFrame {
            index,
            pts,
            width: out.width,
            height: out.height,
            data: out.data,
        })
    }

    async fn audio(&mut self, start_sample: i64, count: usize) -> Result<AudioChunk, MediaError> {
        let channels = self.info.audio.as_ref().map_or(2, |a| a.channels);
        let pcm = self.audio_f32(start_sample, count).await?;
        let samples = pcm
            .iter()
            .map(|&f| (f.clamp(-1.0, 1.0) * 32767.0).round() as i16)
            .collect();
        Ok(AudioChunk {
            start_sample,
            channels,
            samples,
        })
    }
}

/// Convenience for hosts returning RGBA.
pub fn cpu_out(width: u32, height: u32, data: Vec<u8>) -> Result<VideoOut, MediaError> {
    if data.len() != width as usize * height as usize * 4 {
        return Err(MediaError::Io("RGBA buffer has the wrong size".into()));
    }
    let data: Arc<[u8]> = data.into();
    Ok(VideoOut {
        width,
        height,
        data: FrameData::Cpu(RgbaFrame {
            width,
            height,
            data,
        }),
    })
}
