//! WebM / Matroska (EBML) demuxer. Reads `Info` and `Tracks`, then walks `Cluster` headers; block payloads are never read, only
//! each block's 4-byte header. Not supported (`Unsupported`): laced blocks (virtually never used for video or Opus/WebM; see docs/features/media-io.md).

use super::codec;
use super::reader::{invalid, Reader};
use super::{
    analyze_steps, snap_fps, to_time, ContainerFormat, Packet, Probe, Track, TrackKind,
    MAX_PACKETS_PER_TRACK, MAX_TRACKS,
};
use crate::{MediaError, Source};
use app_model::{Rational, Time};

const ID_EBML: u32 = 0x1A45_DFA3;
const ID_SEGMENT: u32 = 0x1853_8067;
const ID_INFO: u32 = 0x1549_A966;
const ID_TRACKS: u32 = 0x1654_AE6B;
const ID_CLUSTER: u32 = 0x1F43_B675;
const ID_CUES: u32 = 0x1C53_BB6B;
const ID_TAGS: u32 = 0x1254_C367;
const ID_SEEKHEAD: u32 = 0x114D_9B74;
const ID_CHAPTERS: u32 = 0x1043_A770;
const ID_ATTACHMENTS: u32 = 0x1941_A469;
const MAX_META: u64 = 16 * 1024 * 1024;
const MAX_ELEMENTS: usize = 50_000_000;

/// (id, header length, body size or `None` for unknown size)
fn header(b: &[u8]) -> Result<(u32, usize, Option<u64>), MediaError> {
    let first = *b.first().ok_or_else(|| invalid("truncated element"))?;
    let idlen = first.leading_zeros() as usize + 1;
    if idlen > 4 || b.len() < idlen {
        return Err(invalid("bad element id"));
    }
    let id = b[..idlen]
        .iter()
        .fold(0u32, |a, &x| (a << 8) | u32::from(x));
    let s0 = *b.get(idlen).ok_or_else(|| invalid("truncated element"))?;
    let slen = s0.leading_zeros() as usize + 1;
    if slen > 8 || b.len() < idlen + slen {
        return Err(invalid("bad element size"));
    }
    let mut v = u64::from(s0) & ((1u64 << (8 - slen)) - 1);
    for &x in &b[idlen + 1..idlen + slen] {
        v = (v << 8) | u64::from(x);
    }
    let unknown = v == (1u64 << (7 * slen)) - 1;
    Ok((id, idlen + slen, (!unknown).then_some(v)))
}

/// Variable-length integer (track number in a block header): (value, length).
fn vint(b: &[u8]) -> Option<(u64, usize)> {
    let first = *b.first()?;
    let n = first.leading_zeros() as usize + 1;
    if n > 8 || b.len() < n {
        return None;
    }
    let mut v = u64::from(first) & ((1u64 << (8 - n)) - 1);
    for &x in &b[1..n] {
        v = (v << 8) | u64::from(x);
    }
    Some((v, n))
}

fn children(d: &[u8]) -> Result<Vec<(u32, &[u8])>, MediaError> {
    let mut out = Vec::new();
    let mut pos = 0;
    while pos < d.len() {
        let (id, hl, size) = header(&d[pos..])?;
        let body_start = pos + hl;
        let end = match size {
            Some(s) => usize::try_from(s)
                .ok()
                .and_then(|s| body_start.checked_add(s))
                .filter(|e| *e <= d.len())
                .ok_or_else(|| invalid("element longer than its parent"))?,
            None => d.len(),
        };
        out.push((id, &d[body_start..end]));
        pos = end;
    }
    Ok(out)
}

fn uint(b: &[u8]) -> u64 {
    b.iter().take(8).fold(0u64, |a, &x| (a << 8) | u64::from(x))
}

fn float(b: &[u8]) -> Option<f64> {
    match b.len() {
        4 => Some(f64::from(f32::from_be_bytes([b[0], b[1], b[2], b[3]]))),
        8 => {
            let mut a = [0u8; 8];
            a.copy_from_slice(b);
            Some(f64::from_be_bytes(a))
        }
        _ => None,
    }
}

fn get<'a>(list: &[(u32, &'a [u8])], id: u32) -> Option<&'a [u8]> {
    list.iter().find(|(i, _)| *i == id).map(|(_, b)| *b)
}

struct Entry {
    number: u64,
    track: Track,
    default_duration_ns: u64,
    pts: Vec<i64>,
    explicit: Vec<Option<i64>>,
}

fn parse_tracks(d: &[u8]) -> Result<Vec<Entry>, MediaError> {
    let mut out = Vec::new();
    for (id, body) in children(d)? {
        if id != 0xAE {
            continue;
        }
        let k = children(body)?;
        let number = get(&k, 0xD7)
            .map(uint)
            .ok_or_else(|| invalid("track without number"))?;
        let kind = match get(&k, 0x83).map(uint) {
            Some(1) => TrackKind::Video,
            Some(2) => TrackKind::Audio,
            _ => continue,
        };
        let cid = String::from_utf8_lossy(get(&k, 0x86).unwrap_or(&[])).into_owned();
        let private = get(&k, 0x63A2).unwrap_or(&[]).to_vec();
        let (mut width, mut height, mut rate, mut channels) = (0u32, 0u32, 0u32, 0u16);
        if let Some(v) = get(&k, 0xE0) {
            let vk = children(v)?;
            width = get(&vk, 0xB0).map_or(0, uint).try_into().unwrap_or(0);
            height = get(&vk, 0xBA).map_or(0, uint).try_into().unwrap_or(0);
        }
        if let Some(a) = get(&k, 0xE1) {
            let ak = children(a)?;
            rate = get(&ak, 0xB5).and_then(float).map_or(0, |f| f as u32);
            channels = get(&ak, 0x9F).map_or(1, uint).try_into().unwrap_or(1);
        }
        let (codec, description) = codec_for(&cid, &private);
        out.push(Entry {
            number,
            default_duration_ns: get(&k, 0x23E383).map_or(0, uint),
            track: Track {
                id: number as u32,
                kind,
                codec,
                codec_description: description,
                width,
                height,
                rotation: 0,
                sample_rate: rate,
                channels,
                timescale: 0,
                duration: Time::ZERO,
                nominal_fps: None,
                vfr: false,
                packets: Vec::new(),
            },
            pts: Vec::new(),
            explicit: Vec::new(),
        });
        if out.len() > MAX_TRACKS {
            return Err(invalid("too many tracks"));
        }
    }
    Ok(out)
}

fn codec_for(cid: &str, private: &[u8]) -> (String, Vec<u8>) {
    let keep = || private.to_vec();
    match cid {
        "V_VP8" => ("vp8".into(), Vec::new()),
        "V_VP9" => {
            // CodecPrivate is optional (id, len, value) triples: 1 profile, 2 level, 3 bit depth.
            let (mut p, mut l, mut d) = (0u8, 10u8, 8u8);
            for t in private.chunks_exact(3) {
                match t[0] {
                    1 => p = t[2],
                    2 => l = t[2],
                    3 => d = t[2],
                    _ => {}
                }
            }
            (format!("vp09.{p:02}.{l:02}.{d:02}"), Vec::new())
        }
        "V_AV1" => (codec::av1(private), keep()),
        "V_MPEG4/ISO/AVC" => (codec::avc("avc1", private), keep()),
        "V_MPEGH/ISO/HEVC" => (codec::hevc("hvc1", private), keep()),
        "A_OPUS" => ("opus".into(), keep()),
        "A_VORBIS" => ("vorbis".into(), keep()),
        "A_FLAC" => ("flac".into(), keep()),
        "A_AAC" => (
            format!("mp4a.40.{}", codec::audio_object_type(private).unwrap_or(2)),
            keep(),
        ),
        other => (other.to_ascii_lowercase(), keep()),
    }
}

struct State {
    scale_ns: u64,
    duration_units: Option<f64>,
    tracks: Vec<Entry>,
    seen_elements: usize,
}

fn clamp_end(start: u64, size: Option<u64>, limit: u64) -> u64 {
    size.map_or(limit, |s| start.saturating_add(s).min(limit))
}

pub(crate) async fn probe<S: Source>(r: &mut Reader<'_, S>) -> Result<Probe, MediaError> {
    let len = r.len();
    let mut format = ContainerFormat::WebM;
    let mut pos = 0u64;
    let mut st = State {
        scale_ns: 1_000_000,
        duration_units: None,
        tracks: Vec::new(),
        seen_elements: 0,
    };
    let mut have_segment = false;
    while pos < len && !have_segment {
        let (id, hl, size) = header(&r.bytes_upto(pos, 12).await?)?;
        let body = pos + hl as u64;
        match (id, size) {
            (ID_EBML, Some(s)) => {
                let doc = r.bytes_upto(body, s.min(256) as usize).await?;
                if let Ok(kids) = children(&doc) {
                    if get(&kids, 0x4282).is_some_and(|t| t == b"matroska") {
                        format = ContainerFormat::Matroska;
                    }
                }
                pos = body.saturating_add(s);
            }
            (ID_SEGMENT, size) => {
                have_segment = true;
                let end = clamp_end(body, size, len);
                scan_segment(r, &mut st, body, end).await?;
            }
            (_, Some(s)) => pos = body.saturating_add(s),
            (_, None) => return Err(invalid("unknown-size element outside segment")),
        }
    }
    if !have_segment {
        return Err(invalid("no Segment element"));
    }
    finish(st, format)
}

async fn scan_segment<S: Source>(
    r: &mut Reader<'_, S>,
    st: &mut State,
    start: u64,
    end: u64,
) -> Result<(), MediaError> {
    let mut pos = start;
    while pos < end {
        st.seen_elements += 1;
        if st.seen_elements > MAX_ELEMENTS {
            return Err(invalid("too many elements"));
        }
        let (id, hl, size) = header(&r.bytes_upto(pos, 12).await?)?;
        let body = pos + hl as u64;
        match id {
            ID_INFO | ID_TRACKS => {
                let s = size.ok_or_else(|| invalid("unknown-size metadata element"))?;
                if s > MAX_META || body.saturating_add(s) > r.len() {
                    return Err(invalid("metadata element truncated or too large"));
                }
                let data = r.bytes(body, s as usize).await?;
                if id == ID_INFO {
                    let k = children(&data)?;
                    if let Some(v) = get(&k, 0x2AD7B1) {
                        st.scale_ns = uint(v).max(1);
                    }
                    st.duration_units = get(&k, 0x4489).and_then(float);
                } else {
                    st.tracks = parse_tracks(&data)?;
                }
                pos = body + s;
            }
            ID_CLUSTER => {
                pos = scan_cluster(r, st, body, clamp_end(body, size, end), size.is_none()).await?;
            }
            _ => match size {
                Some(s) => pos = body.saturating_add(s),
                None => return Err(invalid("unknown-size element")),
            },
        }
    }
    Ok(())
}

fn is_top_level(id: u32) -> bool {
    matches!(
        id,
        ID_CLUSTER
            | ID_CUES
            | ID_TAGS
            | ID_SEEKHEAD
            | ID_INFO
            | ID_TRACKS
            | ID_CHAPTERS
            | ID_ATTACHMENTS
    )
}

/// Walks one cluster; returns the position just after it.
async fn scan_cluster<S: Source>(
    r: &mut Reader<'_, S>,
    st: &mut State,
    start: u64,
    end: u64,
    unknown: bool,
) -> Result<u64, MediaError> {
    let mut tc: i64 = 0;
    let mut pos = start;
    while pos < end {
        st.seen_elements += 1;
        if st.seen_elements > MAX_ELEMENTS {
            return Err(invalid("too many elements"));
        }
        let (id, hl, size) = header(&r.bytes_upto(pos, 12).await?)?;
        if unknown && is_top_level(id) {
            return Ok(pos);
        }
        let body = pos + hl as u64;
        let s = size.ok_or_else(|| invalid("unknown-size element in cluster"))?;
        let next = body.saturating_add(s);
        match id {
            0xE7 => {
                let b = r.bytes(body, s.min(8) as usize).await?;
                tc = i64::try_from(uint(&b)).map_err(|_| invalid("cluster timecode"))?;
            }
            0xA3 => block(r, st, body, s, tc, true, None).await?,
            0xA0 => scan_group(r, st, body, next.min(end), tc).await?,
            _ => {}
        }
        pos = next;
    }
    Ok(pos.min(end).max(start))
}

async fn scan_group<S: Source>(
    r: &mut Reader<'_, S>,
    st: &mut State,
    start: u64,
    end: u64,
    tc: i64,
) -> Result<(), MediaError> {
    let mut pos = start;
    let (mut blk, mut dur, mut has_ref) = (None, None, false);
    while pos < end {
        let (id, hl, size) = header(&r.bytes_upto(pos, 12).await?)?;
        let body = pos + hl as u64;
        let s = size.ok_or_else(|| invalid("unknown-size element in block group"))?;
        match id {
            0xA1 => blk = Some((body, s)),
            0x9B => dur = Some(uint(&r.bytes(body, s.min(8) as usize).await?) as i64),
            0xFB => has_ref = true,
            _ => {}
        }
        pos = body.saturating_add(s);
    }
    if let Some((body, s)) = blk {
        block(r, st, body, s, tc, !has_ref, dur).await?;
    }
    Ok(())
}

async fn block<S: Source>(
    r: &mut Reader<'_, S>,
    st: &mut State,
    body: u64,
    size: u64,
    cluster_tc: i64,
    keyframe: bool,
    duration: Option<i64>,
) -> Result<(), MediaError> {
    if body.saturating_add(size) > r.len() {
        return Err(invalid("block extends past the end of the file"));
    }
    let head = r.bytes_upto(body, 12.min(size as usize)).await?;
    let (number, n) = vint(&head).ok_or_else(|| invalid("bad block header"))?;
    let rest = head
        .get(n..n + 3)
        .ok_or_else(|| invalid("bad block header"))?;
    let rel = i64::from(i16::from_be_bytes([rest[0], rest[1]]));
    let flags = rest[2];
    let Some(e) = st.tracks.iter_mut().find(|e| e.number == number) else {
        return Ok(());
    };
    if flags & 0x06 != 0 {
        return Err(MediaError::Unsupported("laced Matroska blocks".into()));
    }
    let header_len = (n + 3) as u64;
    let payload = size
        .checked_sub(header_len)
        .ok_or_else(|| invalid("block shorter than its header"))?;
    if e.track.packets.len() >= MAX_PACKETS_PER_TRACK {
        return Err(invalid("implausible packet count"));
    }
    let units = cluster_tc
        .checked_add(rel)
        .ok_or_else(|| invalid("timestamp overflow"))?;
    let key = if keyframe && duration.is_none() {
        flags & 0x80 != 0
    } else {
        keyframe
    };
    let to_ticks = |u: i64| {
        u.checked_mul(st.scale_ns as i64)
            .and_then(|ns| to_time(ns, 1_000_000_000))
            .ok_or_else(|| invalid("timestamp overflow"))
    };
    let pts = to_ticks(units)?;
    e.pts.push(units);
    e.explicit.push(duration);
    e.track.packets.push(Packet {
        pts,
        dts: pts,
        duration: Time::ZERO,
        offset: body + header_len,
        size: u32::try_from(payload).map_err(|_| invalid("block too large"))?,
        keyframe: key,
    });
    Ok(())
}

fn finish(st: State, format: ContainerFormat) -> Result<Probe, MediaError> {
    let scale = st.scale_ns as i64;
    let to_ticks = |u: i64| {
        u.checked_mul(scale)
            .and_then(|ns| to_time(ns, 1_000_000_000))
            .ok_or_else(|| invalid("timestamp overflow"))
    };
    let mut tracks = Vec::new();
    for mut e in st.tracks {
        let n = e.pts.len();
        let mut order: Vec<usize> = (0..n).collect();
        order.sort_by_key(|&i| e.pts[i]);
        // Frame steps in timecode units, in presentation order.
        let mut runs: Vec<(u64, u64)> = Vec::new();
        for w in order.windows(2) {
            let d = e.pts[w[1]].saturating_sub(e.pts[w[0]]).max(0) as u64;
            match runs.last_mut() {
                Some((c, s)) if *s == d => *c += 1,
                _ => runs.push((1, d)),
            }
        }
        let default_units = (e.default_duration_ns / st.scale_ns.max(1)) as i64;
        let (mode, vfr) = analyze_steps(&runs, 1);
        for (k, &i) in order.iter().enumerate() {
            let units = match (e.explicit[i], order.get(k + 1)) {
                (Some(d), _) => d,
                (None, Some(&j)) => e.pts[j].saturating_sub(e.pts[i]),
                (None, None) if default_units > 0 => default_units,
                (None, None) => mode.unwrap_or(0) as i64,
            };
            e.track.packets[i].duration = to_ticks(units)?;
        }
        let end = e
            .track
            .packets
            .iter()
            .map(|p| p.pts + p.duration)
            .max()
            .unwrap_or(Time::ZERO);
        e.track.duration = end;
        e.track.timescale = (1_000_000_000 / st.scale_ns.max(1)).min(u64::from(u32::MAX)) as u32;
        if e.track.kind == TrackKind::Video {
            e.track.vfr = vfr;
            if !vfr {
                e.track.nominal_fps = if e.default_duration_ns > 0 {
                    Rational::new(1_000_000_000, e.default_duration_ns as i64).map(snap_fps)
                } else {
                    let span = to_ticks(
                        e.pts
                            .iter()
                            .max()
                            .copied()
                            .unwrap_or(0)
                            .saturating_sub(e.pts.iter().min().copied().unwrap_or(0)),
                    )
                    .ok();
                    span.filter(|s| s.ticks() > 0 && n > 1).and_then(|s| {
                        Rational::new(
                            (n as i64 - 1).checked_mul(app_model::TICKS_PER_SECOND)?,
                            s.ticks(),
                        )
                    })
                };
            }
        }
        tracks.push(e.track);
    }
    let longest = tracks
        .iter()
        .map(|t| t.duration)
        .max()
        .unwrap_or(Time::ZERO);
    let from_info = st
        .duration_units
        .filter(|d| d.is_finite() && *d > 0.0 && *d < 1e15)
        .and_then(|d| to_ticks(d.round() as i64).ok());
    Ok(Probe {
        format,
        duration: from_info.unwrap_or(longest),
        tracks,
    })
}
