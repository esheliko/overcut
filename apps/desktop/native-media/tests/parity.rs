//! Native decode parity (S4): the libav host, driven by the engine's own demuxer and `HostDecoder`, against the demux fixtures.
//! Expected pixels / samples come from (a) known content of `flash_click.mp4` and (b) the `ffmpeg` CLI when it is installed (skipped with a note otherwise).
//! Tolerances: video mean absolute error <= 2.0 / 255 per channel (swscale rounding differs between builds); audio max abs error <= 0.02.
use app_media::Decoder;
use app_native_media::{encoder_available, open_file, AudioConfig, EncoderConfig, Mp4Encoder};
use std::future::Future;
use std::path::PathBuf;
use std::process::Command;

fn block_on<F: Future>(f: F) -> F::Output {
    use std::task::{Context, Poll, Waker};
    let mut f = std::pin::pin!(f);
    let mut cx = Context::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(v) = f.as_mut().poll(&mut cx) {
            return v;
        }
    }
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../crates/media/tests/fixtures")
        .join(name)
}

fn have_ffmpeg() -> bool {
    Command::new("ffmpeg").arg("-version").output().is_ok()
}

fn ffmpeg_rgba(path: &PathBuf) -> Vec<u8> {
    let o = Command::new("ffmpeg")
        .args(["-v", "error", "-i"])
        .arg(path)
        .args([
            "-map",
            "0:v:0",
            "-fps_mode",
            "passthrough",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "-",
        ])
        .output()
        .expect("ffmpeg");
    assert!(o.status.success());
    o.stdout
}

fn ffmpeg_pcm(path: &PathBuf, rate: u32) -> Vec<f32> {
    let o = Command::new("ffmpeg")
        .args(["-v", "error", "-i"])
        .arg(path)
        .args([
            "-map",
            "0:a:0",
            "-ar",
            &rate.to_string(),
            "-f",
            "f32le",
            "-",
        ])
        .output()
        .expect("ffmpeg");
    assert!(o.status.success());
    o.stdout
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect()
}

fn mean_abs_err(a: &[u8], b: &[u8]) -> f64 {
    assert_eq!(a.len(), b.len());
    a.iter()
        .zip(b)
        .map(|(x, y)| (*x as i32 - *y as i32).unsigned_abs() as f64)
        .sum::<f64>()
        / a.len() as f64
}

fn rgba_of(f: &app_media::VideoFrame) -> Vec<u8> {
    match &f.data {
        app_media::FrameData::Cpu(c) => c.data.to_vec(),
        _ => panic!("expected a CPU frame"),
    }
}

#[test]
fn flash_frame_is_white_exactly_where_the_fixture_says() {
    let mut d = open_file(&fixture("flash_click.mp4"), 48_000).expect("open");
    let n = d.info().video.as_ref().unwrap().frame_count;
    assert_eq!(n, 90);
    for (i, white) in [
        (0, false),
        (29, false),
        (30, true),
        (31, false),
        (32, false),
        (89, false),
    ] {
        let f = block_on(d.video_frame(i)).expect("frame");
        let rgba = rgba_of(&f);
        let mean = rgba.iter().step_by(4).map(|&v| v as u32).sum::<u32>() / (rgba.len() as u32 / 4);
        assert_eq!(mean > 200, white, "frame {i} mean luma {mean}");
        assert_eq!(f.index, i);
    }
}

#[test]
fn click_sits_at_one_second_in_the_decoded_audio() {
    let mut d = open_file(&fixture("flash_click.mp4"), 48_000).expect("open");
    let pcm = block_on(d.audio_f32(0, 3 * 48_000)).expect("audio");
    let ch = d.info().audio.as_ref().unwrap().channels as usize;
    let first = pcm
        .chunks(ch)
        .position(|s| s[0].abs() > 0.2)
        .expect("click") as i64;
    // The click starts at 1.000 s; AAC priming and the encoder's frame grid allow a few ms.
    assert!(
        (first - 48_000).abs() < 48_000 / 100,
        "first loud sample at {first}"
    );
}

#[test]
fn video_matches_ffmpeg_within_tolerance() {
    if !have_ffmpeg() {
        eprintln!("ffmpeg CLI not installed: skipping the reference comparison");
        return;
    }
    for name in ["h264_aac.mp4", "h264_aac.mov", "frag.mp4", "vp9_opus.webm"] {
        let path = fixture(name);
        let want = ffmpeg_rgba(&path);
        let mut d = open_file(&path, 48_000).expect(name);
        let v = d.info().video.clone().unwrap();
        let size = v.width as usize * v.height as usize * 4;
        assert_eq!(
            want.len(),
            size * v.frame_count as usize,
            "{name} frame count"
        );
        for i in (0..v.frame_count).step_by(7).chain([v.frame_count - 1]) {
            let got = rgba_of(&block_on(d.video_frame(i)).expect("frame"));
            let err = mean_abs_err(&got, &want[i as usize * size..(i as usize + 1) * size]);
            assert!(err <= 2.0, "{name} frame {i}: mean abs error {err}");
        }
    }
}

#[test]
fn audio_matches_ffmpeg_within_tolerance() {
    if !have_ffmpeg() {
        eprintln!("ffmpeg CLI not installed: skipping the reference comparison");
        return;
    }
    let path = fixture("h264_aac.mp4");
    let want = ffmpeg_pcm(&path, 48_000);
    let mut d = open_file(&path, 48_000).expect("open");
    let ch = d.info().audio.as_ref().unwrap().channels as usize;
    let (start, count) = (9_000usize, 24_000usize);
    let got = block_on(d.audio_f32(start as i64, count)).expect("audio");
    let w = &want[start * ch..(start + count) * ch];
    let max = got
        .iter()
        .zip(w)
        .map(|(a, b)| (a - b).abs())
        .fold(0f32, f32::max);
    assert!(max <= 0.02, "AAC: max abs error {max}");
}

/// A chirp (not a steady sine, so a time offset cannot hide) in Opus: aligned to the sample at stream start; mid-stream within 1 ms
/// (Matroska stores whole-millisecond timestamps), and the level has converged (no pre-roll under-run).
#[test]
fn opus_chirp_aligns_within_one_millisecond() {
    if !have_ffmpeg() {
        eprintln!("ffmpeg CLI not installed: skipping the reference comparison");
        return;
    }
    let path = std::env::temp_dir().join(format!("overcut-chirp-{}.webm", std::process::id()));
    let made = Command::new("ffmpeg")
        .args([
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "aevalsrc=0.3*sin(2*PI*(300*t+400*t*t)):s=48000:d=1.5",
            "-c:a",
            "libopus",
            "-b:a",
            "64k",
        ])
        .arg(&path)
        .status();
    if !made.is_ok_and(|s| s.success()) {
        eprintln!("this ffmpeg cannot encode Opus: skipping");
        return;
    }
    let want = ffmpeg_pcm(&path, 48_000);
    let mut d = open_file(&path, 48_000).expect("open");
    let ch = d.info().audio.as_ref().unwrap().channels as usize;
    for (start, max_lag) in [(0usize, 0i64), (20_000, 64), (40_000, 64)] {
        let got = block_on(d.audio_f32(start as i64, 8_000)).expect("audio");
        let (mut best, mut best_lag) = (f32::MAX, 0i64);
        for lag in -max_lag..=0 {
            let m = (1000..3000usize)
                .map(|i| (got[i * ch] - want[((start + i) as i64 + lag) as usize * ch]).abs())
                .fold(0f32, f32::max);
            if m < best {
                (best, best_lag) = (m, lag);
            }
        }
        assert!(
            best <= 0.02,
            "start {start}: error {best} at lag {best_lag}"
        );
    }
    let _ = std::fs::remove_file(path);
}

/// Encoder round trip: encode a synthetic clip, decode it with the same host, check frames, timing and audio length.
#[test]
fn mp4_encoder_round_trips_through_the_native_decoder() {
    let Some(name) = ["libopenh264", "libx264"]
        .into_iter()
        .find(|n| encoder_available(n))
    else {
        eprintln!("no software H.264 encoder in this libav: skipping");
        return;
    };
    let path = std::env::temp_dir().join(format!("overcut-native-{}.mp4", std::process::id()));
    let (w, h, fps) = (320u32, 180u32, 30u32);
    let mut enc = Mp4Encoder::create(EncoderConfig {
        path: path.clone(),
        width: w,
        height: h,
        fps_num: fps,
        fps_den: 1,
        video_bitrate: 1_000_000,
        keyframe_seconds: 1.0,
        audio: Some(AudioConfig {
            sample_rate: 48_000,
            channels: 2,
            bitrate: 96_000,
        }),
        video_encoders: Some(vec![name.to_string()]),
        creation_time: Some(0),
    })
    .expect("create");
    for i in 0..30u32 {
        let v = (i * 8).min(255) as u8;
        let rgba: Vec<u8> = (0..w * h).flat_map(|_| [v, v, v, 255]).collect();
        enc.push_video(&rgba).unwrap();
    }
    let pcm: Vec<f32> = (0..48_000)
        .flat_map(|i| {
            let s = (i as f32 * 440.0 * std::f32::consts::TAU / 48_000.0).sin() * 0.5;
            [s, s]
        })
        .collect();
    enc.push_audio(&pcm).unwrap();
    let st = enc.finish().expect("finish");
    assert_eq!((st.frames, st.audio_samples), (30, 48_000));
    assert!(st.file_bytes > 1000);

    let mut d = open_file(&path, 48_000).expect("reopen");
    assert_eq!(d.info().video.as_ref().unwrap().frame_count, 30);
    for i in [0i64, 15, 29] {
        let f = rgba_of(&block_on(d.video_frame(i)).unwrap());
        let want = (i as u32 * 8).min(255) as i32;
        let got = f[0] as i32;
        assert!(
            (got - want).abs() <= 12,
            "frame {i}: grey {got}, wanted about {want}"
        );
    }
    let a = block_on(d.audio_f32(12_000, 12_000)).unwrap();
    let peak = a.iter().fold(0f32, |m, v| m.max(v.abs()));
    assert!((0.35..0.6).contains(&peak), "audio peak {peak}");
    let _ = std::fs::remove_file(path);
}

#[test]
fn native_media_reports_the_same_info_shape_as_the_web_decoder() {
    let mut m =
        app_native_media::NativeMedia::open(&fixture("flash_click.mp4"), 48_000).expect("open");
    let info: serde_json::Value = serde_json::from_str(m.info_json()).unwrap();
    assert_eq!(
        info["video"]["codec"].as_str().unwrap().get(..4),
        Some("avc1")
    );
    assert_eq!(
        (
            info["video"]["width"].as_u64(),
            info["video"]["packets"].as_u64()
        ),
        (Some(320), Some(90))
    );
    assert!(info["audio"]["channels"].as_u64().is_some_and(|c| c >= 1));
    assert_eq!(m.pts_ticks().len(), 90);
    assert!(m.pts_ticks().windows(2).all(|w| w[0] < w[1]));
    let (w, h, px) = m.video_frame(10).unwrap();
    assert_eq!(px.len(), (w * h * 4) as usize);
    // Past the end of the stream is silence, not an error: the exporter asks for whole blocks.
    let tail = m.audio(3 * 48_000 - 100, 400).unwrap();
    assert!(tail[200..].iter().all(|&v| v == 0.0));
    assert_eq!(
        app_native_media::libav_is_lgpl(),
        app_native_media::libav_license().starts_with("LGPL")
    );
}
