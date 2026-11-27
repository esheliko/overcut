//! Container demuxers (MP4/MOV, WebM/Matroska) over the async [`Source`] trait. Pure `std`: no threads, no fs, WASM-safe.
//!
//! Hand-rolled, read-only, no dependencies: the available crates read through blocking `Read + Seek`, which cannot sit on the host's
//! async `Source` (browser Blobs, network ranges), and a small parser is easier to bound and fuzz. See `docs/features/media-io.md`.
//! Hostile input returns [`MediaError::Invalid`] / [`MediaError::Unsupported`]; every count and size is checked against the bytes
//! that exist, so a tiny file cannot make us allocate gigabytes. Timestamps are integer ticks (ADR 0010), converted from the
//! container timescale with exact 128-bit arithmetic from absolute positions (no accumulated rounding drift).

mod codec;
mod matroska;
mod mp4;
mod reader;

use crate::{AudioInfo, MediaError, MediaInfo, Source, VideoInfo};
use app_model::{Rational, Time, TICKS_PER_SECOND};
use reader::Reader;

/// Hard cap on packets per track (about 9 h at 60 fps); a bigger count is treated as corrupt.
pub const MAX_PACKETS_PER_TRACK: usize = 2_000_000;
/// Hard cap on tracks kept.
pub const MAX_TRACKS: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContainerFormat {
    Mp4,
    Mov,
    WebM,
    Matroska,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrackKind {
    Video,
    Audio,
}

/// One compressed access unit. `dts <= pts` order differs only with B-frames. `offset`/`size` address the bytes in the source.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Packet {
    pub pts: Time,
    pub dts: Time,
    pub duration: Time,
    pub offset: u64,
    pub size: u32,
    pub keyframe: bool,
}

/// The colour description a container carries for a video track (WebM `Colour`, MP4 `colr`/`nclx`, VP9 `vpcC`), in the ISO 23001-8 code points
/// WebCodecs' `VideoColorSpace` is derived from. `0` = not given; `full_range` is `None` when the container does not say (then the decoder decides).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ColourInfo {
    pub primaries: u8,
    pub transfer: u8,
    pub matrix: u8,
    pub full_range: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Track {
    pub id: u32,
    pub kind: TrackKind,
    /// WebCodecs codec string (`avc1.64001f`, `hvc1.1.6.L93.B0`, `vp09.00.10.08`, `av01.0.04M.08`, `vp8`, `mp4a.40.2`, `opus`, ...),
    /// ready for `isConfigSupported`.
    pub codec: String,
    /// WebCodecs `description` bytes (avcC / hvcC / AudioSpecificConfig / OpusHead), empty when the codec has none.
    pub codec_description: Vec<u8>,
    /// Coded size (0 for audio). The display size is this rotated by `rotation`.
    pub width: u32,
    pub height: u32,
    /// Clockwise degrees to apply when displaying: 0, 90, 180 or 270 (from the MP4 `tkhd` matrix; WebM carries none here).
    pub rotation: u16,
    /// Colour primaries, transfer, matrix and range the container declares (default: nothing declared; audio: always default).
    pub colour: ColourInfo,
    pub sample_rate: u32,
    pub channels: u16,
    /// Container timescale for this track (ticks per second of the source timestamps), informational.
    pub timescale: u32,
    pub duration: Time,
    /// Constant frame rate if the track has one (most common frame step), `None` for audio.
    pub nominal_fps: Option<Rational>,
    /// True when frame steps differ from the common step by more than rounding: needs VFR-to-CFR mapping.
    pub vfr: bool,
    /// In decode order.
    pub packets: Vec<Packet>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Probe {
    pub format: ContainerFormat,
    pub duration: Time,
    pub tracks: Vec<Track>,
}

impl Probe {
    pub fn video(&self) -> Option<&Track> {
        self.tracks.iter().find(|t| t.kind == TrackKind::Video)
    }
    pub fn audio(&self) -> Option<&Track> {
        self.tracks.iter().find(|t| t.kind == TrackKind::Audio)
    }

    /// Summary in the shape the `Decoder` trait uses (first video and audio track).
    pub fn media_info(&self) -> MediaInfo {
        let video = self.video().and_then(|t| {
            let fps = t.nominal_fps.or_else(|| {
                let secs = t.duration.ticks();
                (secs > 0 && !t.packets.is_empty()).then_some(())?;
                Rational::new(
                    (t.packets.len() as i64).checked_mul(TICKS_PER_SECOND)?,
                    secs,
                )
            })?;
            Some(VideoInfo {
                width: t.width,
                height: t.height,
                fps,
                frame_count: t.packets.len() as i64,
            })
        });
        let audio = self.audio().map(|t| AudioInfo {
            sample_rate: t.sample_rate,
            channels: t.channels,
            sample_count: t.duration.sample_index(t.sample_rate).unwrap_or(0),
        });
        MediaInfo { video, audio }
    }
}

/// `value / timescale` seconds as ticks, rounded to nearest (ties away from zero). `None` on zero timescale or overflow.
pub(crate) fn to_time(value: i64, timescale: u64) -> Option<Time> {
    if timescale == 0 {
        return None;
    }
    let n = i128::from(value) * i128::from(TICKS_PER_SECOND);
    let d = i128::from(timescale);
    let half = d / 2;
    let q = if n >= 0 {
        (n + half) / d
    } else {
        (n - half) / d
    };
    i64::try_from(q).ok().map(Time::from_ticks)
}

/// Frame-step analysis over run-length `(count, step)` pairs in container units (the final sample's step must already be excluded).
/// Returns the most common step and whether any step deviates from it by more than `tol` units or 1%.
pub(crate) fn analyze_steps(runs: &[(u64, u64)], tol: u64) -> (Option<u64>, bool) {
    let mut best: Option<(u64, u64)> = None; // (step, total count)
    let mut totals: Vec<(u64, u64)> = Vec::new();
    for &(count, step) in runs {
        if let Some(slot) = totals.iter_mut().find(|(s, _)| *s == step) {
            slot.1 = slot.1.saturating_add(count);
        } else if totals.len() < 4096 {
            totals.push((step, count));
        }
    }
    for &(step, count) in &totals {
        if count > 0 && best.is_none_or(|(_, c)| count > c) {
            best = Some((step, count));
        }
    }
    let Some((mode, _)) = best else {
        return (None, false);
    };
    let allowed = tol.max(mode / 100);
    let vfr = totals
        .iter()
        .any(|&(s, c)| c > 0 && s.abs_diff(mode) > allowed);
    (Some(mode), vfr)
}

/// Probe a file: detect the container, read its index and return tracks with their packet tables.
///
/// Reads the index (MP4 `moov`) or walks cluster headers (WebM) but never the packet payloads.
pub async fn probe<S: Source>(source: &S) -> Result<Probe, MediaError> {
    let mut r = Reader::new(source);
    let head = r.bytes_upto(0, 12).await?;
    if head.len() < 8 {
        return Err(reader::invalid("file too short to be a media container"));
    }
    if head[..4] == [0x1A, 0x45, 0xDF, 0xA3] {
        return matroska::probe(&mut r).await;
    }
    match &head[4..8] {
        b"ftyp" | b"moov" | b"mdat" | b"wide" | b"free" | b"skip" | b"pnot" => {
            mp4::probe(&mut r).await
        }
        _ => Err(MediaError::Unsupported(
            "This is not a video or audio format OverCut can read.".into(),
        )),
    }
}

/// In-memory [`Source`] (tests, fuzzing, small files already in RAM).
pub struct MemSource<'a>(pub &'a [u8]);

impl Source for MemSource<'_> {
    fn len(&self) -> u64 {
        self.0.len() as u64
    }
    async fn read_at(&self, offset: u64, buf: &mut [u8]) -> Result<usize, MediaError> {
        let Ok(start) = usize::try_from(offset) else {
            return Ok(0);
        };
        let Some(avail) = self.0.get(start..) else {
            return Ok(0);
        };
        let n = avail.len().min(buf.len());
        buf[..n].copy_from_slice(&avail[..n]);
        Ok(n)
    }
}

/// Snap a measured frame rate to the nearest standard rate when within 0.1% (`1e9 / 33333333 ns` -> 30/1).
pub(crate) fn snap_fps(fps: Rational) -> Rational {
    const STANDARD: [Rational; 11] = [
        Rational {
            num: 24000,
            den: 1001,
        },
        Rational { num: 24, den: 1 },
        Rational { num: 25, den: 1 },
        Rational {
            num: 30000,
            den: 1001,
        },
        Rational { num: 30, den: 1 },
        Rational { num: 50, den: 1 },
        Rational {
            num: 60000,
            den: 1001,
        },
        Rational { num: 60, den: 1 },
        Rational {
            num: 120000,
            den: 1001,
        },
        Rational { num: 120, den: 1 },
        Rational { num: 15, den: 1 },
    ];
    let measured = i128::from(fps.num);
    let md = i128::from(fps.den);
    STANDARD
        .into_iter()
        .find(|s| {
            // |measured/md - s| <= s/1000  <=>  |measured*s.den - s.num*md| * 1000 <= s.num*md
            let diff = (measured * i128::from(s.den) - i128::from(s.num) * md).abs();
            diff * 1000 <= i128::from(s.num) * md
        })
        .unwrap_or(fps)
}
