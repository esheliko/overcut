//! Demux tests on tiny ffmpeg-generated fixtures (`tests/fixtures/make.sh`) plus hostile-input robustness.
use app_media::*;
use app_model::{Rational, Time};
use std::future::Future;
use std::task::{Context, Poll, Waker};

fn block_on<F: Future>(f: F) -> F::Output {
    let mut f = std::pin::pin!(f);
    let mut cx = Context::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(v) = f.as_mut().poll(&mut cx) {
            return v;
        }
    }
}

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!(
        "{}/tests/fixtures/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

fn probe_bytes(d: &[u8]) -> Result<Probe, MediaError> {
    block_on(probe(&MemSource(d)))
}

const FRAME_30: i64 = 705_600_000 / 30;

fn video(p: &Probe) -> &Track {
    p.video().expect("video track")
}

fn pts_sorted(t: &Track) -> Vec<i64> {
    let mut v: Vec<i64> = t.packets.iter().map(|p| p.pts.ticks()).collect();
    v.sort_unstable();
    v
}

#[test]
fn mp4_h264_aac() {
    let p = probe_bytes(&fixture("h264_aac.mp4")).unwrap();
    assert_eq!(p.format, ContainerFormat::Mp4);
    assert_eq!(p.duration, Time::from_seconds(1).unwrap());
    assert_eq!(p.tracks.len(), 2);
    let v = video(&p);
    assert_eq!(
        (v.codec.as_str(), v.width, v.height, v.rotation),
        ("avc1.64001e", 160, 120, 0)
    );
    assert!(
        !v.codec_description.is_empty(),
        "avcC kept for WebCodecs description"
    );
    assert_eq!(v.nominal_fps, Some(Rational::FPS_30));
    assert!(!v.vfr);
    assert_eq!(v.packets.len(), 30);
    // Presentation times are exact multiples of the frame duration: no drift, no float.
    let want: Vec<i64> = (0..30).map(|i| i * FRAME_30).collect();
    assert_eq!(pts_sorted(v), want);
    // Composition delay (B-frame encode): dts leads pts by two frames at the start.
    assert_eq!(v.packets[0].dts.ticks(), -2 * FRAME_30);
    assert!(v.packets.windows(2).all(|w| w[0].dts < w[1].dts));
    let keys: Vec<usize> = (0..30).filter(|&i| v.packets[i].keyframe).collect();
    assert_eq!(keys, vec![0, 15]);
    assert!(v
        .packets
        .iter()
        .all(|p| p.size > 0 && p.duration.ticks() == FRAME_30));

    let a = p.audio().unwrap();
    assert_eq!(
        (a.codec.as_str(), a.sample_rate, a.channels),
        ("mp4a.40.2", 48_000, 1)
    );
    assert!(
        a.codec_description.starts_with(&[0x11, 0x88]),
        "AudioSpecificConfig bytes kept for WebCodecs"
    );
    assert!(a.packets.len() >= 47 && a.packets.iter().all(|p| p.keyframe));
    // 1024 samples per AAC frame at 48 kHz, exact in ticks (the last packet's length is up to the muxer).
    assert!(a.packets[..a.packets.len() - 1]
        .iter()
        .all(|p| p.duration.ticks() == 705_600_000 * 1024 / 48_000));

    let info = p.media_info();
    let vi = info.video.unwrap();
    assert_eq!(
        (vi.width, vi.height, vi.frame_count, vi.fps),
        (160, 120, 30, Rational::FPS_30)
    );
    assert_eq!(info.audio.unwrap().sample_rate, 48_000);
}

#[test]
fn mov_matches_mp4() {
    let mp4 = probe_bytes(&fixture("h264_aac.mp4")).unwrap();
    let mov = probe_bytes(&fixture("h264_aac.mov")).unwrap();
    assert_eq!(mov.format, ContainerFormat::Mov);
    assert_eq!(pts_sorted(video(&mov)), pts_sorted(video(&mp4)));
    assert_eq!(video(&mov).codec, video(&mp4).codec);
    let a = mov.audio().unwrap();
    assert_eq!(
        a.codec, "mp4a.40.2",
        "esds found inside the QuickTime `wave` box"
    );
    assert_eq!(a.codec_description, mp4.audio().unwrap().codec_description);
}

#[test]
fn rotation_from_matrix() {
    let p = probe_bytes(&fixture("rotated90.mp4")).unwrap();
    // ffmpeg `-display_rotation 90` is counter-clockwise, i.e. 270 clockwise; coded size is unchanged.
    assert_eq!(video(&p).rotation, 270);
    assert_eq!((video(&p).width, video(&p).height), (160, 120));
}

#[test]
fn variable_frame_rate_is_detected() {
    let p = probe_bytes(&fixture("vfr.mp4")).unwrap();
    let v = video(&p);
    assert!(v.vfr);
    assert_eq!(v.nominal_fps, None);
    assert_eq!(v.packets.len(), 13);
    let t = |n: i64, d: i64| 705_600_000 * n / d;
    let pts = pts_sorted(v);
    assert_eq!(&pts[..4], &[0, t(1, 15), t(3, 15), t(4, 15)]);
    // Constant-rate files are not flagged.
    assert!(!video(&probe_bytes(&fixture("h264_aac.mp4")).unwrap()).vfr);
    assert!(!video(&probe_bytes(&fixture("vp9_opus.webm")).unwrap()).vfr);
}

#[test]
fn webm_vp9_opus() {
    let p = probe_bytes(&fixture("vp9_opus.webm")).unwrap();
    assert_eq!(p.format, ContainerFormat::WebM);
    let v = video(&p);
    assert_eq!(
        (v.codec.as_str(), v.width, v.height),
        ("vp09.00.10.08", 160, 120)
    );
    assert_eq!(v.nominal_fps, Some(Rational::FPS_30));
    assert_eq!(v.packets.len(), 30);
    let keys: Vec<usize> = (0..30).filter(|&i| v.packets[i].keyframe).collect();
    assert_eq!(keys, vec![0, 15]);
    // WebM timestamps are whole milliseconds: 33 ms = 23_284_800 ticks.
    assert_eq!(v.packets[0].pts, Time::ZERO);
    assert_eq!(v.packets[1].pts.ticks(), 33 * 705_600);
    assert!(v
        .packets
        .windows(2)
        .all(|w| w[0].pts < w[1].pts && w[0].dts == w[0].pts));
    let a = p.audio().unwrap();
    assert_eq!((a.codec.as_str(), a.sample_rate), ("opus", 48_000));
    assert!(a.codec_description.starts_with(b"OpusHead"));
    assert!(p.duration.ticks() >= 705_600_000);
}

/// A host `Source` that returns at most 7 bytes per read: partial reads must be handled.
struct Dribble<'a>(&'a [u8]);
impl Source for Dribble<'_> {
    fn len(&self) -> u64 {
        self.0.len() as u64
    }
    async fn read_at(&self, offset: u64, buf: &mut [u8]) -> Result<usize, MediaError> {
        let n = buf.len().min(7);
        MemSource(self.0).read_at(offset, &mut buf[..n]).await
    }
}

#[test]
fn partial_reads_give_the_same_answer() {
    for n in ["h264_aac.mp4", "vp9_opus.webm"] {
        let d = fixture(n);
        assert_eq!(
            block_on(probe(&Dribble(&d))).unwrap(),
            probe_bytes(&d).unwrap(),
            "{n}"
        );
    }
}

const ALL: [&str; 5] = [
    "h264_aac.mp4",
    "h264_aac.mov",
    "rotated90.mp4",
    "vfr.mp4",
    "vp9_opus.webm",
];

#[test]
fn truncated_input_errors_never_panics() {
    for n in ALL {
        let d = fixture(n);
        for cut in 0..d.len() {
            let _ = probe_bytes(&d[..cut]); // any outcome but a panic
        }
        // Cutting into the media data or the index is an error, not a partial answer.
        for cut in [d.len() / 2, d.len() * 9 / 10] {
            assert!(probe_bytes(&d[..cut]).is_err(), "{n} cut at {cut}");
        }
    }
    assert!(probe_bytes(&[]).is_err());
    assert!(probe_bytes(b"not a media file at all").is_err());
}

#[test]
fn corrupted_input_never_panics() {
    let mut x = 0x2545_F491_4F6C_DD1Du64;
    let mut next = move || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x
    };
    for n in ALL {
        let d = fixture(n);
        // Mutate mostly the front where the structure lives, sometimes anywhere.
        for _ in 0..1500 {
            let mut m = d.clone();
            for _ in 0..=(next() % 6) {
                let span = if next() % 4 == 0 {
                    m.len()
                } else {
                    m.len().min(1024)
                } as u64;
                let i = (next() % span) as usize;
                m[i] = next() as u8;
            }
            let _ = probe_bytes(&m);
        }
    }
}

#[test]
fn huge_counts_are_rejected_without_allocating() {
    let mut d = fixture("h264_aac.mp4");
    let at = d.windows(4).position(|w| w == b"stsz").unwrap() + 4;
    d[at + 4..at + 8].copy_from_slice(&1u32.to_be_bytes()); // every sample "1 byte"
    d[at + 8..at + 12].copy_from_slice(&u32::MAX.to_be_bytes()); // 4 billion samples
    assert!(matches!(probe_bytes(&d), Err(MediaError::Invalid(_))));
    // A table count larger than its box.
    let mut d = fixture("h264_aac.mp4");
    let at = d.windows(4).position(|w| w == b"stts").unwrap() + 8;
    d[at..at + 4].copy_from_slice(&u32::MAX.to_be_bytes());
    assert!(matches!(probe_bytes(&d), Err(MediaError::Invalid(_))));
}

#[test]
fn unknown_formats_are_reported_plainly() {
    // The sentence is shown to the person as it is (after the file name and format), so it must read as one.
    for head in [&b"RIFF\0\0\0\0AVI LIST\0\0\0\0"[..], &[0x7f; 64][..]] {
        match probe_bytes(head) {
            Err(MediaError::Unsupported(m)) => {
                assert!(
                    m.starts_with(|c: char| c.is_uppercase()) && m.ends_with('.'),
                    "{m}"
                )
            }
            other => panic!("{other:?}"),
        }
    }
}

/// What must survive fragmentation: timing relative to the first presented frame, sync flags and sizes of every packet. (A fragmented
/// muxer writes no negative composition offsets, so it shifts the whole timeline by the B-frame delay; offsets differ by design.)
fn timing(t: &Track) -> Vec<(i64, i64, i64, u32, bool)> {
    let base = t.packets.iter().map(|p| p.pts.ticks()).min().unwrap_or(0);
    t.packets
        .iter()
        .map(|p| {
            (
                p.pts.ticks() - base,
                p.dts.ticks() - base,
                p.duration.ticks(),
                p.size,
                p.keyframe,
            )
        })
        .collect()
}

#[test]
fn fragmented_mp4_matches_the_plain_file() {
    let plain = probe_bytes(&fixture("h264_aac.mp4")).unwrap();
    for name in ["frag.mp4", "frag_legacy.mp4"] {
        let d = fixture(name);
        let p = probe_bytes(&d).unwrap();
        assert_eq!(p.format, ContainerFormat::Mp4);
        assert_eq!(p.tracks.len(), 2, "{name}");
        for (a, b) in [
            (video(&p), video(&plain)),
            (p.audio().unwrap(), plain.audio().unwrap()),
        ] {
            assert_eq!(
                (a.codec.as_str(), a.width, a.height),
                (b.codec.as_str(), b.width, b.height),
                "{name}"
            );
            assert_eq!(a.codec_description, b.codec_description, "{name}");
            if a.kind == TrackKind::Video {
                assert_eq!(timing(a), timing(b), "{name}");
            } else {
                // ffmpeg writes AAC priming as an edit list in the plain file and as a longer first sample here: compare what is
                // exact in both (count, sizes, and the steady-state durations).
                let sizes = |t: &Track| t.packets.iter().map(|p| p.size).collect::<Vec<_>>();
                assert_eq!(sizes(a), sizes(b), "{name}");
                let mid = |t: &Track| {
                    t.packets[1..t.packets.len() - 1]
                        .iter()
                        .map(|p| p.duration)
                        .collect::<Vec<_>>()
                };
                assert_eq!(mid(a), mid(b), "{name}");
            }
            // Every sample lies inside the file and the bytes are the ones the plain file has.
            let plain_bytes = fixture("h264_aac.mp4");
            for (pa, pb) in a.packets.iter().zip(&b.packets) {
                let (x, y) = (pa.offset as usize, pb.offset as usize);
                assert_eq!(
                    d[x..x + pa.size as usize],
                    plain_bytes[y..y + pb.size as usize],
                    "{name}"
                );
            }
        }
        let v = video(&p);
        assert_eq!(v.nominal_fps, Some(Rational::FPS_30), "{name}");
        assert!(!v.vfr, "{name}");
        assert_eq!(p.media_info().video.unwrap().frame_count, 30, "{name}");
        // No `mvhd` duration in a fragmented file: it is the end of the longest track (shifted by the B-frame delay).
        assert!(
            p.duration >= plain.duration
                && p.duration.ticks() <= plain.duration.ticks() + 3 * FRAME_30,
            "{name}"
        );
    }
}

#[test]
fn fragmented_mp4_cut_short_keeps_the_complete_fragments() {
    let d = fixture("frag.mp4");
    let full = video(&probe_bytes(&d).unwrap()).packets.len();
    let mut prev = 0;
    for cut in 0..d.len() {
        if let Ok(p) = probe_bytes(&d[..cut]) {
            let n = p.video().map_or(0, |t| t.packets.len());
            assert!(n <= full);
            assert!(n >= prev, "more data never means fewer frames (cut {cut})");
            prev = n;
        }
    }
    // A recording that lost its tail still imports what is complete.
    let cut = d.len() * 7 / 10;
    let p = probe_bytes(&d[..cut]).unwrap();
    let n = video(&p).packets.len();
    assert!(n > 0 && n < full, "{n} of {full}");
}

#[test]
fn fragmented_mp4_corruption_never_panics() {
    let mut x = 0x9E37_79B9_7F4A_7C15u64;
    let mut next = move || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x
    };
    for name in ["frag.mp4", "frag_legacy.mp4"] {
        let d = fixture(name);
        for _ in 0..1500 {
            let mut m = d.clone();
            for _ in 0..=(next() % 6) {
                let span = if next() % 3 == 0 {
                    m.len()
                } else {
                    m.len().min(2048)
                } as u64;
                let i = (next() % span) as usize;
                m[i] = next() as u8;
            }
            let _ = probe_bytes(&m);
        }
    }
}

#[test]
fn huge_trun_count_is_rejected_without_allocating() {
    let mut d = fixture("frag.mp4");
    let at = d.windows(4).position(|w| w == b"trun").unwrap() + 4;
    d[at + 4..at + 8].copy_from_slice(&u32::MAX.to_be_bytes());
    assert!(matches!(probe_bytes(&d), Err(MediaError::Invalid(_))));
}

#[test]
fn the_containers_colour_description_is_carried_with_its_range() {
    // WebM `Colour` element: full range, bt709 primaries/matrix, sRGB transfer (13).
    let p = probe_bytes(&fixture("colour_full.webm")).unwrap();
    assert_eq!(
        video(&p).colour,
        ColourInfo {
            primaries: 1,
            transfer: 13,
            matrix: 1,
            full_range: Some(true)
        }
    );
    // MP4 `colr`/nclx: the full-range flag.
    let p = probe_bytes(&fixture("colour_full.mp4")).unwrap();
    let c = video(&p).colour;
    assert_eq!(
        (c.primaries, c.transfer, c.matrix, c.full_range),
        (1, 1, 1, Some(true))
    );
    // A file that declares nothing declares nothing (no guessed range): this H.264 has no `colr`.
    let p = probe_bytes(&fixture("h264_aac.mp4")).unwrap();
    assert_eq!(video(&p).colour.full_range, None);
}
