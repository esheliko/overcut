//! RIFF/WAVE demuxer for uncompressed PCM audio (8, 16, 24, 32-bit integer and 32-bit float). The data chunk is cut into fixed-size
//! packets so the decode planner (`HostDecoder::plan_audio`) can ask for a window of samples; the host turns the bytes into f32 without
//! a codec (the codec strings are WebCodecs' `pcm-*` names, `docs/features/media-io.md`). Pure `std`, bounds-checked.

use super::reader::{invalid, Reader};
use super::{
    to_time, ContainerFormat, Packet, Probe, Track, TrackKind, MAX_PACKETS_PER_TRACK,
};
use crate::{MediaError, Source};

/// Frames (one sample per channel) per packet: about 93 ms at 44.1 kHz.
const FRAMES_PER_PACKET: u64 = 4096;
const MAX_CHANNELS: u16 = 8;

pub(crate) fn is_wav(head: &[u8]) -> bool {
    head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WAVE"
}

struct Fmt {
    codec: &'static str,
    channels: u16,
    rate: u32,
    block_align: u32,
}

fn parse_fmt(b: &[u8]) -> Result<Fmt, MediaError> {
    if b.len() < 16 {
        return Err(invalid("WAV fmt chunk too short"));
    }
    let tag = u16::from_le_bytes([b[0], b[1]]);
    let channels = u16::from_le_bytes([b[2], b[3]]);
    let rate = u32::from_le_bytes([b[4], b[5], b[6], b[7]]);
    let block_align = u32::from(u16::from_le_bytes([b[12], b[13]]));
    let bits = u16::from_le_bytes([b[14], b[15]]);
    // WAVE_FORMAT_EXTENSIBLE carries the real format tag in the first two bytes of its sub-format GUID.
    let tag = if tag == 0xFFFE && b.len() >= 26 {
        u16::from_le_bytes([b[24], b[25]])
    } else {
        tag
    };
    if channels == 0 || channels > MAX_CHANNELS {
        return Err(MediaError::Unsupported(format!(
            "This WAV has {channels} channels; OverCut reads 1 to {MAX_CHANNELS}."
        )));
    }
    if !(8_000..=384_000).contains(&rate) {
        return Err(invalid("WAV sample rate out of range"));
    }
    let codec = match (tag, bits) {
        (1, 8) => "pcm-u8",
        (1, 16) => "pcm-s16",
        (1, 24) => "pcm-s24",
        (1, 32) => "pcm-s32",
        (3, 32) => "pcm-f32",
        _ => {
            return Err(MediaError::Unsupported(
                "This WAV is compressed or uses a rare encoding. Export it as 16-bit PCM WAV, or use MP3 or M4A.".into(),
            ))
        }
    };
    let bytes_per_sample = u32::from(bits / 8);
    // A block_align that disagrees with the format would make every packet boundary wrong: trust the format.
    if block_align != bytes_per_sample * u32::from(channels) {
        return Err(invalid("WAV block alignment does not match its format"));
    }
    Ok(Fmt {
        codec,
        channels,
        rate,
        block_align,
    })
}

pub(crate) async fn probe<S: Source>(r: &mut Reader<'_, S>) -> Result<Probe, MediaError> {
    let len = r.len();
    let mut fmt: Option<Fmt> = None;
    let mut pos: u64 = 12;
    let mut data: Option<(u64, u64)> = None; // (offset, size)
    while pos + 8 <= len {
        let h = r.bytes(pos, 8).await?;
        let size = u64::from(u32::from_le_bytes([h[4], h[5], h[6], h[7]]));
        let body = pos + 8;
        match &h[..4] {
            b"fmt " => {
                if size > 1024 || body + size > len {
                    return Err(invalid("WAV fmt chunk is the wrong size"));
                }
                fmt = Some(parse_fmt(&r.bytes(body, size as usize).await?)?);
            }
            b"data" => {
                // A streamed WAV may say 0 or 0xFFFFFFFF: the data then runs to the end of the file.
                let avail = len - body;
                let size = if size == 0 || size > avail { avail } else { size };
                data = Some((body, size));
                break;
            }
            _ => {}
        }
        pos = body
            .checked_add(size + (size & 1))
            .ok_or_else(|| invalid("WAV chunk size overflow"))?;
    }
    let f = fmt.ok_or_else(|| invalid("WAV has no fmt chunk"))?;
    let (off, size) = data.ok_or_else(|| invalid("WAV has no audio data"))?;
    let frames = size / u64::from(f.block_align);
    if frames == 0 {
        return Err(invalid("WAV has no audio data"));
    }
    let n_packets = frames.div_ceil(FRAMES_PER_PACKET) as usize;
    if n_packets > MAX_PACKETS_PER_TRACK {
        return Err(invalid("WAV is too long"));
    }
    let rate = u64::from(f.rate);
    let at = |frame: u64| to_time(frame as i64, rate);
    let mut packets = Vec::with_capacity(n_packets);
    for i in 0..n_packets as u64 {
        let first = i * FRAMES_PER_PACKET;
        let n = FRAMES_PER_PACKET.min(frames - first);
        let pts = at(first).ok_or_else(|| invalid("WAV time overflow"))?;
        let end = at(first + n).ok_or_else(|| invalid("WAV time overflow"))?;
        packets.push(Packet {
            pts,
            dts: pts,
            duration: end
                .checked_sub(pts)
                .ok_or_else(|| invalid("WAV time overflow"))?,
            offset: off + first * u64::from(f.block_align),
            size: (n * u64::from(f.block_align)) as u32,
            keyframe: true,
        });
    }
    let duration = at(frames).ok_or_else(|| invalid("WAV time overflow"))?;
    Ok(Probe {
        format: ContainerFormat::Wav,
        duration,
        tracks: vec![Track {
            id: 1,
            kind: TrackKind::Audio,
            codec: f.codec.to_string(),
            codec_description: Vec::new(),
            width: 0,
            height: 0,
            rotation: 0,
            colour: Default::default(),
            sample_rate: f.rate,
            channels: f.channels,
            timescale: f.rate,
            duration,
            nominal_fps: None,
            vfr: false,
            packets,
        }],
    })
}
