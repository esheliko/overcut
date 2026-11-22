//! ISO BMFF (MP4, MOV) demuxer: reads `moov`, builds packet tables from the sample tables (`stts ctts stss stsz stsc stco/co64`).
//! Fragmented MP4 (`mvex` + `moof`/`traf`/`trun`, `tfdt`, defaults from `tfhd`/`trex`) is read by walking the top-level `moof` boxes
//! (only their headers, never `mdat`). Base offset is the `tfhd` base-data-offset, else the start of the `moof` (the
//! `default-base-is-moof` rule, also what every real muxer produces). A file cut short mid-fragment keeps the complete fragments before
//! the cut (recorders crash and phones lose power). Not supported (reported as `Unsupported`): QuickTime sound sample-entry version 2,
//! encrypted tracks.

use super::codec;
use super::reader::{invalid, Cur, Reader};
use super::{
    analyze_steps, to_time, ContainerFormat, Packet, Probe, Track, TrackKind,
    MAX_PACKETS_PER_TRACK, MAX_TRACKS,
};
use crate::{MediaError, Source};
use app_model::{Rational, Time};

const MAX_MOOV: u64 = 256 * 1024 * 1024;
const MAX_TOP_LEVEL_BOXES: usize = 400_000;
/// Total bytes of `moof` headers kept in memory for a fragmented file.
const MAX_MOOF_BYTES: u64 = 256 * 1024 * 1024;

type Fourcc = [u8; 4];
type BoxList<'a> = Vec<(Fourcc, &'a [u8])>;

/// Child boxes of `d`. Sizes are validated against the buffer.
fn boxes(d: &[u8]) -> Result<BoxList<'_>, MediaError> {
    let mut c = Cur::new(d);
    let mut out = Vec::new();
    while c.remaining() > 0 {
        if c.remaining() < 8 {
            return Err(invalid("trailing bytes inside a box"));
        }
        let size = c.u32()?;
        let t = c.take(4)?;
        let ty = [t[0], t[1], t[2], t[3]];
        let (hdr, size) = match size {
            0 => (8usize, d.len() - c.pos + 8),
            1 => (
                16,
                usize::try_from(c.u64()?).map_err(|_| invalid("box too large"))?,
            ),
            n => (8, n as usize),
        };
        if size < hdr {
            return Err(invalid("box smaller than its header"));
        }
        let body = c.take(size - hdr)?;
        out.push((ty, body));
    }
    Ok(out)
}

fn find<'a>(list: &BoxList<'a>, ty: &[u8; 4]) -> Option<&'a [u8]> {
    list.iter().find(|(t, _)| t == ty).map(|(_, b)| *b)
}

pub(crate) async fn probe<S: Source>(r: &mut Reader<'_, S>) -> Result<Probe, MediaError> {
    let len = r.len();
    let mut off = 0u64;
    let mut moov: Option<Vec<u8>> = None;
    let mut fragmented = false;
    let mut moofs: Vec<Moof> = Vec::new();
    let mut moof_bytes = 0u64;
    let mut format = ContainerFormat::Mp4;
    let mut seen = 0usize;
    while off < len && (moov.is_none() || fragmented) {
        seen += 1;
        if seen > MAX_TOP_LEVEL_BOXES {
            return Err(invalid("too many top-level boxes"));
        }
        let head = r.bytes_upto(off, 16).await?;
        if head.len() < 8 {
            break;
        }
        let size32 = u64::from(u32::from_be_bytes([head[0], head[1], head[2], head[3]]));
        let ty = [head[4], head[5], head[6], head[7]];
        let (hdr, size) = match size32 {
            0 => (8u64, len - off),
            1 => {
                if head.len() < 16 {
                    return Err(invalid("truncated box header"));
                }
                let mut a = [0u8; 8];
                a.copy_from_slice(&head[8..16]);
                (16, u64::from_be_bytes(a))
            }
            n => (8, n),
        };
        if size < hdr {
            return Err(invalid("box smaller than its header"));
        }
        match &ty {
            b"ftyp" if size >= 12 && off == 0 => {
                let brand = r.bytes(8, 4).await?;
                if brand == b"qt  " {
                    format = ContainerFormat::Mov;
                }
            }
            b"moov" => {
                let body = size - hdr;
                if body > MAX_MOOV || off.saturating_add(size) > len {
                    return Err(invalid("moov box is truncated or implausibly large"));
                }
                let bytes = r.bytes(off + hdr, body as usize).await?;
                fragmented = find(&boxes(&bytes)?, b"mvex").is_some();
                moov = Some(bytes);
            }
            b"moof" => {
                // A moof cut off by the end of the file is the unfinished tail of a recording: stop there.
                if off.saturating_add(size) > len {
                    break;
                }
                moof_bytes += size - hdr;
                if moof_bytes > MAX_MOOF_BYTES {
                    return Err(invalid("fragment headers implausibly large"));
                }
                fragmented = true;
                moofs.push(Moof {
                    start: off,
                    body: r.bytes(off + hdr, (size - hdr) as usize).await?,
                });
            }
            _ => {}
        }
        off = match off.checked_add(size) {
            Some(n) => n,
            None => break,
        };
    }
    let moov = moov.ok_or_else(|| invalid("no moov box (file truncated or not finalised)"))?;
    parse_moov(&moov, len, format, &moofs)
}

/// One `moof` box: its absolute start (the default base for sample offsets) and its body (children).
struct Moof {
    start: u64,
    body: Vec<u8>,
}

/// `trex` defaults for one track.
#[derive(Clone, Copy, Default)]
struct Trex {
    id: u32,
    duration: u32,
    size: u32,
    flags: u32,
}

/// What a fragmented file adds to a track: the `trex` defaults and the fragments.
struct Frags<'a> {
    trex: &'a [Trex],
    moofs: &'a [Moof],
}

fn parse_trex(mvex: &[u8]) -> Result<Vec<Trex>, MediaError> {
    let mut out = Vec::new();
    for (ty, b) in boxes(mvex)? {
        if &ty == b"trex" {
            let mut c = Cur::new(b);
            full_box(&mut c)?;
            let id = c.u32()?;
            c.skip(4)?; // default_sample_description_index
            out.push(Trex {
                id,
                duration: c.u32()?,
                size: c.u32()?,
                flags: c.u32()?,
            });
            if out.len() > MAX_TRACKS * 4 {
                return Err(invalid("too many trex boxes"));
            }
        }
    }
    Ok(out)
}

fn parse_moov(
    moov: &[u8],
    file_len: u64,
    format: ContainerFormat,
    moofs: &[Moof],
) -> Result<Probe, MediaError> {
    let kids = boxes(moov)?;
    let mvex = find(&kids, b"mvex");
    let trex = match mvex {
        Some(m) => parse_trex(m)?,
        None => Vec::new(),
    };
    let frags = (mvex.is_some() || !moofs.is_empty()).then_some(Frags { trex: &trex, moofs });
    let (movie_ts, movie_dur) = match find(&kids, b"mvhd") {
        Some(b) => mvhd(b)?,
        None => (0, 0),
    };
    let mut tracks = Vec::new();
    for (ty, body) in &kids {
        if ty == b"trak" {
            if let Some(t) = parse_trak(body, movie_ts, file_len, frags.as_ref())? {
                if tracks.len() >= MAX_TRACKS {
                    return Err(invalid("too many tracks"));
                }
                tracks.push(t);
            }
        }
    }
    let longest = tracks
        .iter()
        .map(|t| t.duration)
        .max()
        .unwrap_or(Time::ZERO);
    let duration = to_time(movie_dur as i64, u64::from(movie_ts))
        .filter(|d| d.ticks() > 0)
        .unwrap_or(longest);
    Ok(Probe {
        format,
        duration,
        tracks,
    })
}

fn full_box(c: &mut Cur<'_>) -> Result<u8, MediaError> {
    let v = c.u8()?;
    c.skip(3)?;
    Ok(v)
}

fn mvhd(b: &[u8]) -> Result<(u32, u64), MediaError> {
    let mut c = Cur::new(b);
    if full_box(&mut c)? == 1 {
        c.skip(16)?;
        Ok((c.u32()?, c.u64()?))
    } else {
        c.skip(8)?;
        Ok((c.u32()?, u64::from(c.u32()?)))
    }
}

fn parse_trak(
    trak: &[u8],
    movie_ts: u32,
    file_len: u64,
    frags: Option<&Frags<'_>>,
) -> Result<Option<Track>, MediaError> {
    let kids = boxes(trak)?;
    let tkhd = find(&kids, b"tkhd").ok_or_else(|| invalid("trak without tkhd"))?;
    let mdia = boxes(find(&kids, b"mdia").ok_or_else(|| invalid("trak without mdia"))?)?;
    let hdlr = find(&mdia, b"hdlr").ok_or_else(|| invalid("mdia without hdlr"))?;
    let kind = match hdlr.get(8..12) {
        Some(b"vide") => TrackKind::Video,
        Some(b"soun") => TrackKind::Audio,
        _ => return Ok(None),
    };
    let (id, rotation) = tkhd_info(tkhd)?;
    let mdhd = find(&mdia, b"mdhd").ok_or_else(|| invalid("mdia without mdhd"))?;
    let (timescale, mdhd_dur) = mvhd(mdhd)?; // same leading layout as mvhd
    if timescale == 0 {
        return Err(invalid("zero media timescale"));
    }
    let minf = boxes(find(&mdia, b"minf").ok_or_else(|| invalid("mdia without minf"))?)?;
    let stbl = boxes(find(&minf, b"stbl").ok_or_else(|| invalid("minf without stbl"))?)?;
    let stsd = find(&stbl, b"stsd").ok_or_else(|| invalid("stbl without stsd"))?;
    let entry = sample_entry(stsd, kind)?;

    let shift = match find(&boxes(find(&kids, b"edts").unwrap_or(&[]))?, b"elst") {
        Some(e) => edit_shift(e, movie_ts, timescale)?,
        None => Time::ZERO,
    };

    let need =
        |t: &[u8; 4]| find(&stbl, t).ok_or_else(|| invalid("stbl is missing a sample table"));
    let stts = read_pairs(need(b"stts")?, false)?;
    let ctts = match find(&stbl, b"ctts") {
        Some(b) => Some(read_pairs(b, true)?),
        None => None,
    };
    let sizes = read_sizes(need(b"stsz")?)?;
    let stsc = read_stsc(need(b"stsc")?)?;
    let chunks = match find(&stbl, b"stco") {
        Some(b) => read_chunk_offsets(b, false)?,
        None => read_chunk_offsets(need(b"co64")?, true)?,
    };
    let sync = match find(&stbl, b"stss") {
        Some(b) => Some(read_u32_list(b)?),
        None => None,
    };

    let mut packets = build_packets(
        &sizes,
        &stts,
        ctts.as_deref(),
        &stsc,
        &chunks,
        sync.as_deref(),
        timescale,
        shift,
        file_len,
    )?;
    let mut runs: Vec<(u64, u64)> = stts
        .iter()
        .map(|&(c, d)| (u64::from(c), d as u64))
        .collect();
    if let Some(f) = frags {
        let next_dts = runs
            .iter()
            .fold(0u64, |a, &(c, d)| a.saturating_add(c.saturating_mul(d)));
        let trex = f
            .trex
            .iter()
            .find(|t| t.id == id)
            .copied()
            .unwrap_or_default();
        append_fragments(
            &FragCtx {
                id,
                trex,
                timescale,
                shift,
                file_len,
            },
            f.moofs,
            i64::try_from(next_dts).map_err(|_| invalid("timestamp overflow"))?,
            &mut packets,
            &mut runs,
        )?;
    }
    let (mode, vfr) = if kind == TrackKind::Video {
        if let Some(last) = runs.last_mut() {
            last.0 = last.0.saturating_sub(1); // the final sample's duration is arbitrary
        }
        analyze_steps(&runs, 1)
    } else {
        (None, false)
    };
    let nominal_fps = if kind == TrackKind::Video && !vfr {
        mode.filter(|m| *m > 0)
            .and_then(|m| Rational::new(i64::from(timescale), m as i64))
    } else {
        None
    };
    let end = packets
        .iter()
        .map(|p| p.pts + p.duration)
        .max()
        .unwrap_or(Time::ZERO);
    let duration = to_time(mdhd_dur as i64, u64::from(timescale))
        .filter(|d| d.ticks() > 0)
        .unwrap_or(end);
    Ok(Some(Track {
        id,
        kind,
        codec: entry.codec,
        codec_description: entry.description,
        width: entry.width,
        height: entry.height,
        rotation,
        sample_rate: entry.sample_rate,
        channels: entry.channels,
        timescale,
        duration,
        nominal_fps,
        vfr,
        packets,
    }))
}

fn tkhd_info(b: &[u8]) -> Result<(u32, u16), MediaError> {
    let mut c = Cur::new(b);
    let id = if full_box(&mut c)? == 1 {
        c.skip(16)?;
        let id = c.u32()?;
        c.skip(4 + 8)?;
        id
    } else {
        c.skip(8)?;
        let id = c.u32()?;
        c.skip(4 + 4)?;
        id
    };
    c.skip(16)?; // reserved, layer, alternate group, volume, reserved
    let a = c.i32()?;
    let bb = c.i32()?;
    // Matrix [a b; c d] in 16.16: (1,0) = 0, (0,1) = 90 cw, (-1,0) = 180, (0,-1) = 270. Mirroring is ignored.
    let rotation = if a.unsigned_abs() >= bb.unsigned_abs() {
        if a >= 0 {
            0
        } else {
            180
        }
    } else if bb > 0 {
        90
    } else {
        270
    };
    Ok((id, rotation))
}

/// Presentation shift from the first edit list: leading empty edits delay, the first real edit's `media_time` starts the media there.
fn edit_shift(b: &[u8], movie_ts: u32, media_ts: u32) -> Result<Time, MediaError> {
    let mut c = Cur::new(b);
    let v = full_box(&mut c)?;
    let n = c.u32()?;
    let mut empty = Time::ZERO;
    for _ in 0..n {
        let (seg, mt) = if v == 1 {
            let s = c.u64()?;
            (s as i64, c.u64()? as i64)
        } else {
            (i64::from(c.u32()?), i64::from(c.i32()?))
        };
        c.skip(4)?;
        if mt == -1 {
            let t = to_time(seg, u64::from(movie_ts)).ok_or_else(|| invalid("bad edit list"))?;
            empty = empty
                .checked_add(t)
                .ok_or_else(|| invalid("bad edit list"))?;
        } else {
            let m = to_time(mt, u64::from(media_ts)).ok_or_else(|| invalid("bad edit list"))?;
            return empty.checked_sub(m).ok_or_else(|| invalid("bad edit list"));
        }
    }
    Ok(empty)
}

struct Entry {
    codec: String,
    description: Vec<u8>,
    width: u32,
    height: u32,
    sample_rate: u32,
    channels: u16,
}

fn sample_entry(stsd: &[u8], kind: TrackKind) -> Result<Entry, MediaError> {
    let mut c = Cur::new(stsd);
    full_box(&mut c)?;
    if c.u32()? == 0 {
        return Err(invalid("stsd without entries"));
    }
    let size = c.u32()? as usize;
    let fcc = c.take(4)?;
    let fourcc = [fcc[0], fcc[1], fcc[2], fcc[3]];
    let body = c.take(
        size.checked_sub(8)
            .ok_or_else(|| invalid("bad sample entry"))?,
    )?;
    let mut e = Cur::new(body);
    let mut entry = Entry {
        codec: String::new(),
        description: Vec::new(),
        width: 0,
        height: 0,
        sample_rate: 0,
        channels: 0,
    };
    let name = || String::from_utf8_lossy(&fourcc).trim().to_ascii_lowercase();
    match kind {
        TrackKind::Video => {
            e.skip(24)?;
            entry.width = u32::from(e.u16()?);
            entry.height = u32::from(e.u16()?);
            e.skip(78 - 28)?;
            let kids = boxes(e.rest())?;
            let take = |t: &[u8; 4]| find(&kids, t).map(<[u8]>::to_vec);
            match &fourcc {
                b"avc1" | b"avc3" => {
                    entry.description = take(b"avcC").unwrap_or_default();
                    entry.codec = codec::avc(&name(), &entry.description);
                }
                b"hvc1" | b"hev1" => {
                    entry.description = take(b"hvcC").unwrap_or_default();
                    entry.codec = codec::hevc(&name(), &entry.description);
                }
                b"vp09" => {
                    let vpcc = take(b"vpcC").unwrap_or_default();
                    entry.codec = codec::vp9(vpcc.get(4..).unwrap_or(&[]));
                }
                b"av01" => {
                    entry.description = take(b"av1C").unwrap_or_default();
                    entry.codec = codec::av1(&entry.description);
                }
                _ => entry.codec = name(),
            }
        }
        TrackKind::Audio => {
            e.skip(8)?;
            let version = e.u16()?;
            e.skip(6)?;
            entry.channels = e.u16()?;
            e.skip(6)?;
            entry.sample_rate = e.u32()? >> 16;
            match version {
                0 => {}
                1 => e.skip(16)?,
                _ => return Err(MediaError::Unsupported("QuickTime sound entry v2".into())),
            }
            let kids = boxes(e.rest())?;
            match &fourcc {
                b"mp4a" => {
                    // QuickTime (version 1) entries nest `esds` inside a `wave` box.
                    let wave = find(&kids, b"wave").map(boxes).transpose()?;
                    let esds = find(&kids, b"esds")
                        .or_else(|| wave.as_ref().and_then(|w| find(w, b"esds")))
                        .unwrap_or(&[]);
                    let (oti, asc) = parse_esds(esds).unwrap_or((0x40, Vec::new()));
                    entry.codec = codec::mp4a(oti, &asc);
                    entry.description = asc;
                }
                b"Opus" => {
                    entry.codec = "opus".into();
                    entry.description = find(&kids, b"dOps").map(opus_head).unwrap_or_default();
                }
                _ => entry.codec = name(),
            }
        }
    }
    Ok(entry)
}

/// `esds` -> (objectTypeIndication, AudioSpecificConfig).
fn parse_esds(b: &[u8]) -> Result<(u8, Vec<u8>), MediaError> {
    fn desc<'a>(c: &mut Cur<'a>) -> Result<(u8, &'a [u8]), MediaError> {
        let tag = c.u8()?;
        let mut len = 0usize;
        for _ in 0..4 {
            let b = c.u8()?;
            len = (len << 7) | usize::from(b & 0x7f);
            if b & 0x80 == 0 {
                break;
            }
        }
        Ok((tag, c.take(len)?))
    }
    let mut c = Cur::new(b);
    c.skip(4)?;
    let (tag, es) = desc(&mut c)?;
    if tag != 0x03 {
        return Err(invalid("esds without ES descriptor"));
    }
    let mut e = Cur::new(es);
    e.skip(2)?;
    let flags = e.u8()?;
    if flags & 0x80 != 0 {
        e.skip(2)?;
    }
    if flags & 0x40 != 0 {
        let n = usize::from(e.u8()?);
        e.skip(n)?;
    }
    if flags & 0x20 != 0 {
        e.skip(2)?;
    }
    let (tag, dc) = desc(&mut e)?;
    if tag != 0x04 {
        return Err(invalid("esds without decoder config"));
    }
    let mut d = Cur::new(dc);
    let oti = d.u8()?;
    d.skip(12)?;
    let asc = match desc(&mut d) {
        Ok((0x05, s)) => s.to_vec(),
        _ => Vec::new(),
    };
    Ok((oti, asc))
}

/// ISO `dOps` (big-endian) -> RFC 7845 `OpusHead` (little-endian), the form WebCodecs wants as `description`.
fn opus_head(dops: &[u8]) -> Vec<u8> {
    let mut c = Cur::new(dops);
    let go = |c: &mut Cur<'_>| -> Result<Vec<u8>, MediaError> {
        c.skip(1)?;
        let ch = c.u8()?;
        let pre = c.u16()?;
        let rate = c.u32()?;
        let gain = c.u16()?;
        let mut v = b"OpusHead".to_vec();
        v.push(1);
        v.push(ch);
        v.extend_from_slice(&pre.to_le_bytes());
        v.extend_from_slice(&rate.to_le_bytes());
        v.extend_from_slice(&gain.to_le_bytes());
        v.extend_from_slice(c.rest());
        Ok(v)
    };
    go(&mut c).unwrap_or_default()
}

/// `stts` / `ctts`: (count, value). `ctts` values are signed.
fn read_pairs(b: &[u8], signed: bool) -> Result<Vec<(u32, i64)>, MediaError> {
    let mut c = Cur::new(b);
    full_box(&mut c)?;
    let n = c.u32()? as usize;
    if n > c.remaining() / 8 {
        return Err(invalid("sample table longer than its box"));
    }
    let mut v = Vec::with_capacity(n);
    for _ in 0..n {
        let count = c.u32()?;
        let val = if signed {
            i64::from(c.i32()?)
        } else {
            i64::from(c.u32()?)
        };
        v.push((count, val));
    }
    Ok(v)
}

fn read_u32_list(b: &[u8]) -> Result<Vec<u32>, MediaError> {
    let mut c = Cur::new(b);
    full_box(&mut c)?;
    let n = c.u32()? as usize;
    if n > c.remaining() / 4 {
        return Err(invalid("sample table longer than its box"));
    }
    (0..n).map(|_| c.u32()).collect()
}

enum Sizes {
    Fixed(u32, usize),
    Table(Vec<u32>),
}

impl Sizes {
    fn count(&self) -> usize {
        match self {
            Sizes::Fixed(_, n) => *n,
            Sizes::Table(v) => v.len(),
        }
    }
    fn get(&self, i: usize) -> u32 {
        match self {
            Sizes::Fixed(s, _) => *s,
            Sizes::Table(v) => v[i],
        }
    }
}

fn read_sizes(b: &[u8]) -> Result<Sizes, MediaError> {
    let mut c = Cur::new(b);
    full_box(&mut c)?;
    let fixed = c.u32()?;
    let n = c.u32()? as usize;
    if n > MAX_PACKETS_PER_TRACK {
        return Err(invalid("implausible sample count"));
    }
    if fixed != 0 {
        return Ok(Sizes::Fixed(fixed, n));
    }
    if n > c.remaining() / 4 {
        return Err(invalid("sample table longer than its box"));
    }
    Ok(Sizes::Table(
        (0..n).map(|_| c.u32()).collect::<Result<_, _>>()?,
    ))
}

/// (first_chunk, samples_per_chunk), first_chunk 1-based and ascending.
fn read_stsc(b: &[u8]) -> Result<Vec<(u32, u32)>, MediaError> {
    let mut c = Cur::new(b);
    full_box(&mut c)?;
    let n = c.u32()? as usize;
    if n > c.remaining() / 12 {
        return Err(invalid("sample table longer than its box"));
    }
    let mut v: Vec<(u32, u32)> = Vec::with_capacity(n);
    for _ in 0..n {
        let first = c.u32()?;
        let spc = c.u32()?;
        c.skip(4)?;
        if first == 0 || v.last().is_some_and(|l| l.0 >= first) {
            return Err(invalid("bad chunk table"));
        }
        v.push((first, spc));
    }
    Ok(v)
}

fn read_chunk_offsets(b: &[u8], wide: bool) -> Result<Vec<u64>, MediaError> {
    let mut c = Cur::new(b);
    full_box(&mut c)?;
    let n = c.u32()? as usize;
    if n > c.remaining() / if wide { 8 } else { 4 } {
        return Err(invalid("sample table longer than its box"));
    }
    (0..n)
        .map(|_| {
            if wide {
                c.u64()
            } else {
                c.u32().map(u64::from)
            }
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn build_packets(
    sizes: &Sizes,
    stts: &[(u32, i64)],
    ctts: Option<&[(u32, i64)]>,
    stsc: &[(u32, u32)],
    chunks: &[u64],
    sync: Option<&[u32]>,
    timescale: u32,
    shift: Time,
    file_len: u64,
) -> Result<Vec<Packet>, MediaError> {
    let n = sizes.count();
    let ts = u64::from(timescale);
    let mut keyframe = vec![sync.is_none(); n];
    if let Some(s) = sync {
        for &k in s {
            if let Some(slot) = (k as usize)
                .checked_sub(1)
                .and_then(|i| keyframe.get_mut(i))
            {
                *slot = true;
            }
        }
    }
    // Sample byte offsets from chunk layout.
    let mut offsets = Vec::with_capacity(n);
    'chunks: for (ci, &chunk_off) in chunks.iter().enumerate() {
        let chunk_no = ci as u64 + 1;
        let spc = match stsc.partition_point(|r| u64::from(r.0) <= chunk_no) {
            0 => return Err(invalid("chunk table does not cover the first chunk")),
            i => stsc[i - 1].1,
        };
        let mut o = chunk_off;
        for _ in 0..spc {
            if offsets.len() == n {
                break 'chunks;
            }
            let i = offsets.len();
            offsets.push(o);
            o = o
                .checked_add(u64::from(sizes.get(i)))
                .ok_or_else(|| invalid("sample offset overflow"))?;
        }
    }
    if offsets.len() < n {
        return Err(invalid(
            "chunk table covers fewer samples than the size table",
        ));
    }
    // Timestamps from absolute positions.
    let mut packets = Vec::with_capacity(n);
    let (mut dts, mut ri, mut left) = (0i64, 0usize, stts.first().map_or(0, |r| r.0));
    let (mut ci, mut cleft) = (0usize, ctts.and_then(|c| c.first()).map_or(0, |r| r.0));
    for (i, &offset) in offsets.iter().enumerate() {
        while left == 0 {
            ri += 1;
            left = stts
                .get(ri)
                .ok_or_else(|| invalid("time table covers fewer samples"))?
                .0;
        }
        let delta = stts[ri].1;
        let comp = match ctts {
            Some(c) => {
                while cleft == 0 {
                    ci += 1;
                    cleft = c
                        .get(ci)
                        .ok_or_else(|| invalid("composition table covers fewer samples"))?
                        .0;
                }
                c[ci].1
            }
            None => 0,
        };
        let conv = |v: i64| to_time(v, ts).and_then(|t| t.checked_add(shift));
        let bad = || invalid("timestamp overflow");
        let next = dts.checked_add(delta).ok_or_else(bad)?;
        let size = sizes.get(i);
        if offset
            .checked_add(u64::from(size))
            .is_none_or(|e| e > file_len)
        {
            return Err(invalid("sample lies outside the file"));
        }
        let t0 = conv(dts).ok_or_else(bad)?;
        packets.push(Packet {
            pts: conv(dts.checked_add(comp).ok_or_else(bad)?).ok_or_else(bad)?,
            dts: t0,
            duration: conv(next)
                .ok_or_else(bad)?
                .checked_sub(t0)
                .ok_or_else(bad)?,
            offset,
            size,
            keyframe: keyframe[i],
        });
        dts = next;
        left -= 1;
        cleft = cleft.saturating_sub(1);
    }
    Ok(packets)
}

struct FragCtx {
    id: u32,
    trex: Trex,
    timescale: u32,
    shift: Time,
    file_len: u64,
}

/// `tfhd` fields (only what we use).
#[derive(Default)]
struct Tfhd {
    id: u32,
    base: Option<u64>,
    duration: Option<u32>,
    size: Option<u32>,
    flags: Option<u32>,
}

fn parse_tfhd(b: &[u8]) -> Result<Tfhd, MediaError> {
    let mut c = Cur::new(b);
    let flags = {
        let v = c.u32()?;
        v & 0x00FF_FFFF
    };
    let mut t = Tfhd {
        id: c.u32()?,
        ..Tfhd::default()
    };
    if flags & 0x01 != 0 {
        t.base = Some(c.u64()?);
    }
    if flags & 0x02 != 0 {
        c.skip(4)?; // sample_description_index
    }
    if flags & 0x08 != 0 {
        t.duration = Some(c.u32()?);
    }
    if flags & 0x10 != 0 {
        t.size = Some(c.u32()?);
    }
    if flags & 0x20 != 0 {
        t.flags = Some(c.u32()?);
    }
    Ok(t)
}

/// Appends the samples of every `traf` for this track, in file (decode) order. A fragment whose samples reach past the end of the
/// file ends the walk: that is a recording cut short, and everything before it is kept.
fn append_fragments(
    cx: &FragCtx,
    moofs: &[Moof],
    mut next_dts: i64,
    packets: &mut Vec<Packet>,
    runs: &mut Vec<(u64, u64)>,
) -> Result<(), MediaError> {
    let ts = u64::from(cx.timescale);
    let bad = || invalid("timestamp overflow");
    for moof in moofs {
        for (ty, traf) in boxes(&moof.body)? {
            if &ty != b"traf" {
                continue;
            }
            let kids = boxes(traf)?;
            let tfhd =
                parse_tfhd(find(&kids, b"tfhd").ok_or_else(|| invalid("traf without tfhd"))?)?;
            if tfhd.id != cx.id {
                continue;
            }
            if let Some(b) = find(&kids, b"tfdt") {
                let mut c = Cur::new(b);
                let v = full_box(&mut c)?;
                let t = if v == 1 {
                    c.u64()?
                } else {
                    u64::from(c.u32()?)
                };
                next_dts = i64::try_from(t).map_err(|_| bad())?;
            }
            let mut cursor = tfhd.base.unwrap_or(moof.start);
            let mut staged: Vec<Packet> = Vec::new();
            let mut staged_runs: Vec<u64> = Vec::new();
            let mut dts = next_dts;
            for (ty, trun) in &kids {
                if ty != b"trun" {
                    continue;
                }
                let mut c = Cur::new(trun);
                let version = c.u8()?;
                let f = u32::from_be_bytes([0, c.u8()?, c.u8()?, c.u8()?]);
                let count = c.u32()?;
                if packets
                    .len()
                    .saturating_add(staged.len())
                    .saturating_add(count as usize)
                    > MAX_PACKETS_PER_TRACK
                {
                    return Err(invalid("implausible packet count"));
                }
                if f & 0x1 != 0 {
                    let off = i64::from(c.i32()?);
                    cursor = tfhd
                        .base
                        .unwrap_or(moof.start)
                        .checked_add_signed(off)
                        .ok_or_else(|| invalid("sample offset overflow"))?;
                }
                let first_flags = if f & 0x4 != 0 { Some(c.u32()?) } else { None };
                for i in 0..count {
                    let dur = if f & 0x100 != 0 {
                        c.u32()?
                    } else {
                        tfhd.duration.unwrap_or(cx.trex.duration)
                    };
                    let size = if f & 0x200 != 0 {
                        c.u32()?
                    } else {
                        tfhd.size.unwrap_or(cx.trex.size)
                    };
                    let mut sflags = if f & 0x400 != 0 {
                        c.u32()?
                    } else {
                        tfhd.flags.unwrap_or(cx.trex.flags)
                    };
                    if i == 0 {
                        sflags = first_flags.unwrap_or(sflags);
                    }
                    let comp = if f & 0x800 != 0 {
                        let raw = c.u32()?;
                        if version == 0 {
                            i64::from(raw)
                        } else {
                            i64::from(raw as i32)
                        }
                    } else {
                        0
                    };
                    let end = cursor.checked_add(u64::from(size));
                    if end.is_none_or(|e| e > cx.file_len) {
                        // Truncated tail: drop this whole fragment and everything after it.
                        return Ok(());
                    }
                    let conv = |v: i64| to_time(v, ts).and_then(|t| t.checked_add(cx.shift));
                    let next = dts.checked_add(i64::from(dur)).ok_or_else(bad)?;
                    let t0 = conv(dts).ok_or_else(bad)?;
                    staged.push(Packet {
                        pts: conv(dts.checked_add(comp).ok_or_else(bad)?).ok_or_else(bad)?,
                        dts: t0,
                        duration: conv(next)
                            .ok_or_else(bad)?
                            .checked_sub(t0)
                            .ok_or_else(bad)?,
                        offset: cursor,
                        size,
                        keyframe: sflags & 0x0001_0000 == 0,
                    });
                    staged_runs.push(u64::from(dur));
                    cursor = end.unwrap_or(cursor);
                    dts = next;
                }
            }
            packets.extend(staged);
            for d in staged_runs {
                match runs.last_mut() {
                    Some((c, s)) if *s == d => *c += 1,
                    _ => runs.push((1, d)),
                }
            }
            next_dts = dts;
        }
    }
    Ok(())
}
