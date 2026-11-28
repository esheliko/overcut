//! MP3 (MPEG-1/2/2.5 Layer III) demuxer: skips an ID3v2 tag, walks the frame headers (each frame is one packet) and drops a Xing/Info/VBRI
//! metadata frame. Only the 4-byte headers are read, in large windows; payloads are never touched. The decoder is the platform's
//! (WebCodecs `AudioDecoder` `mp3` on the web, libav `mp3` natively). Encoder delay (gapless trim) is not applied: documented in
//! `docs/features/media-io.md`. Layers I and II are `Unsupported`. Pure `std`, bounds-checked, bounded by the file size.

use super::reader::{invalid, Reader};
use super::{to_time, ContainerFormat, Packet, Probe, Track, TrackKind, MAX_PACKETS_PER_TRACK};
use crate::{MediaError, Source};

const WINDOW: usize = 256 * 1024;
/// How far past a broken header to look for the next frame before treating the rest as trailing data.
const RESYNC: usize = 64 * 1024;

pub(crate) fn is_mp3(head: &[u8]) -> bool {
    (head.len() >= 3 && &head[..3] == b"ID3")
        || (head.len() >= 2 && head[0] == 0xFF && head[1] & 0xE0 == 0xE0)
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Frame {
    size: usize,
    rate: u32,
    channels: u16,
    samples: u64,
    /// Offset of the Xing/Info marker inside the frame (after header and side info).
    xing_at: usize,
}

/// Parse a frame header; `None` when it is not a valid Layer III header. `Err` only for Layers I/II (so the person gets a real reason).
fn header(h: &[u8]) -> Result<Option<Frame>, MediaError> {
    if h.len() < 4 || h[0] != 0xFF || h[1] & 0xE0 != 0xE0 {
        return Ok(None);
    }
    let version = (h[1] >> 3) & 3; // 0 = 2.5, 1 reserved, 2 = MPEG-2, 3 = MPEG-1
    let layer = (h[1] >> 1) & 3; // 1 = III, 2 = II, 3 = I
    if version == 1 || layer == 0 {
        return Ok(None);
    }
    let bitrate_idx = usize::from(h[2] >> 4);
    let rate_idx = usize::from((h[2] >> 2) & 3);
    if bitrate_idx == 0 || bitrate_idx == 15 || rate_idx == 3 {
        return Ok(None); // free-format and invalid bitrates are not supported
    }
    if layer != 1 {
        return Err(MediaError::Unsupported(
            "This is MP1 or MP2 audio. Convert it to MP3 or M4A.".into(),
        ));
    }
    const BR_V1: [u32; 15] = [
        0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
    ];
    const BR_V2: [u32; 15] = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    const RATE: [u32; 3] = [44_100, 48_000, 32_000];
    let mpeg1 = version == 3;
    let kbps = if mpeg1 {
        BR_V1[bitrate_idx]
    } else {
        BR_V2[bitrate_idx]
    };
    let rate = match version {
        3 => RATE[rate_idx],
        2 => RATE[rate_idx] / 2,
        _ => RATE[rate_idx] / 4,
    };
    let pad = usize::from((h[2] >> 1) & 1);
    let size = if mpeg1 {
        144 * kbps as usize * 1000 / rate as usize + pad
    } else {
        72 * kbps as usize * 1000 / rate as usize + pad
    };
    let mono = (h[3] >> 6) == 3;
    let side = match (mpeg1, mono) {
        (true, false) => 32,
        (true, true) | (false, false) => 17,
        (false, true) => 9,
    };
    Ok(Some(Frame {
        size,
        rate,
        channels: if mono { 1 } else { 2 },
        samples: if mpeg1 { 1152 } else { 576 },
        xing_at: 4 + side,
    }))
}

/// Bytes of an ID3v2 tag at the start (header + body), 0 when there is none.
fn id3v2_len(h: &[u8]) -> u64 {
    if h.len() < 10 || &h[..3] != b"ID3" || h[6..10].iter().any(|b| b & 0x80 != 0) {
        return 0;
    }
    let body = h[6..10].iter().fold(0u64, |a, &b| (a << 7) | u64::from(b));
    10 + body + if h[5] & 0x10 != 0 { 10 } else { 0 }
}

pub(crate) async fn probe<S: Source>(r: &mut Reader<'_, S>) -> Result<Probe, MediaError> {
    let len = r.len();
    let head = r.bytes_upto(0, 10).await?;
    let mut pos = id3v2_len(&head);
    // (offset, frame) in order; `first` fixes the rate and channel count the whole file must keep.
    let mut frames: Vec<(u64, Frame)> = Vec::new();
    let mut first: Option<Frame> = None;
    'scan: while pos + 4 <= len {
        let buf = r.bytes_upto(pos, WINDOW).await?;
        let mut i = 0usize;
        while i + 4 <= buf.len() {
            let at = pos + i as u64;
            match header(&buf[i..i + 4])? {
                Some(f) if first.is_none_or(|g| g.rate == f.rate && g.channels == f.channels) => {
                    // The first frame must be followed by another valid header, so random bytes that look like a sync are not an MP3.
                    if first.is_none() {
                        let next = r.bytes_upto(at + f.size as u64, 4).await?;
                        if !matches!(header(&next), Ok(Some(n)) if n.rate == f.rate)
                            && at + (f.size as u64) < len
                        {
                            i += 1;
                            continue;
                        }
                        first = Some(f);
                    }
                    if at + f.size as u64 > len {
                        break 'scan; // a truncated last frame
                    }
                    if frames.len() >= MAX_PACKETS_PER_TRACK {
                        return Err(invalid("MP3 is too long"));
                    }
                    frames.push((at, f));
                    i += f.size;
                    if i + 4 > buf.len() {
                        pos = at + f.size as u64;
                        continue 'scan;
                    }
                }
                _ if first.is_none() => i += 1, // still looking for the first frame (junk before it)
                _ => {
                    // A broken header after audio started: resync within a bounded distance, otherwise it is trailing data (ID3v1, APE).
                    let from = pos + i as u64;
                    let tail = r.bytes_upto(from, RESYNC).await?;
                    let mut found = None;
                    for k in 1..tail.len().saturating_sub(3) {
                        if matches!(header(&tail[k..k + 4]), Ok(Some(f)) if first.is_some_and(|g| g.rate == f.rate && g.channels == f.channels))
                        {
                            found = Some(from + k as u64);
                            break;
                        }
                    }
                    match found {
                        Some(next) => {
                            pos = next;
                            continue 'scan;
                        }
                        None => break 'scan,
                    }
                }
            }
        }
        if pos + (buf.len() as u64) >= len {
            break;
        }
        pos += i.min(buf.len()) as u64;
        if i == 0 {
            pos += 1; // always make progress
        }
    }
    let f0 = first.ok_or_else(|| {
        MediaError::Unsupported("This is not a video or audio format OverCut can read.".into())
    })?;
    // A Xing / Info / VBRI first frame holds the player's index, not sound.
    if let Some(&(at, f)) = frames.first() {
        let m = r.bytes_upto(at + f.xing_at as u64, 4).await?;
        let vbri = r.bytes_upto(at + 36, 4).await?;
        if m == b"Xing" || m == b"Info" || vbri == b"VBRI" {
            frames.remove(0);
        }
    }
    if frames.is_empty() {
        return Err(invalid("MP3 has no audio frames"));
    }
    let rate = u64::from(f0.rate);
    let mut packets = Vec::with_capacity(frames.len());
    let mut samples: u64 = 0;
    for &(offset, f) in &frames {
        let pts = to_time(samples as i64, rate).ok_or_else(|| invalid("MP3 time overflow"))?;
        let end = to_time((samples + f.samples) as i64, rate)
            .ok_or_else(|| invalid("MP3 time overflow"))?;
        packets.push(Packet {
            pts,
            dts: pts,
            duration: end
                .checked_sub(pts)
                .ok_or_else(|| invalid("MP3 time overflow"))?,
            offset,
            size: f.size as u32,
            keyframe: true,
        });
        samples += f.samples;
    }
    let duration = to_time(samples as i64, rate).ok_or_else(|| invalid("MP3 time overflow"))?;
    Ok(Probe {
        format: ContainerFormat::Mp3,
        duration,
        tracks: vec![Track {
            id: 1,
            kind: TrackKind::Audio,
            codec: "mp3".to_string(),
            codec_description: Vec::new(),
            width: 0,
            height: 0,
            rotation: 0,
            colour: Default::default(),
            sample_rate: f0.rate,
            channels: f0.channels,
            timescale: f0.rate,
            duration,
            nominal_fps: None,
            vfr: false,
            packets,
        }],
    })
}
