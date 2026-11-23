//! Hardware / licence check for a machine (the S4 checks in docs/adr/0004-media-io.md): `cargo run --release --example check [-- <encoder> ...]`
//! Prints the linked libav and its licence, which H.264 encoders exist and which of them OPEN here (hardware shows up as videotoolbox / mf /
//! nvenc / qsv / amf), then encodes 1080p30 for 5 s with the default preference (or the encoder names given), decodes the result back and
//! reports speeds. Exit code 1 on any failure or when the loaded libav is not LGPL.
use app_media::Decoder;
use app_native_media::{
    block_on, libav_is_lgpl, libav_license, open_file, AudioConfig, EncoderConfig, Mp4Encoder,
    H264_PREFERENCE,
};
use std::time::Instant;

fn config(path: &std::path::Path, encoders: Option<Vec<String>>, w: u32, h: u32) -> EncoderConfig {
    EncoderConfig {
        path: path.to_path_buf(),
        width: w,
        height: h,
        fps_num: 30,
        fps_den: 1,
        video_bitrate: 12_000_000,
        keyframe_seconds: 2.0,
        audio: Some(AudioConfig {
            sample_rate: 48_000,
            channels: 2,
            bitrate: 192_000,
        }),
        video_encoders: encoders,
        creation_time: None,
    }
}

fn main() {
    app_native_media::init().expect("libav init");
    let lic = libav_license();
    println!("libav license: {lic}");
    let mut ok = true;
    if !libav_is_lgpl() {
        println!("FAIL: the loaded libav is not LGPL (GPL / nonfree build): fine for development, never for a release");
        ok = false;
    }
    let (w, h) = (1920u32, 1080u32);
    let tmp = std::env::temp_dir().join("overcut-check.mp4");
    println!("H.264 encoders that open at {w}x{h}:");
    for name in H264_PREFERENCE {
        let present = app_native_media::encoder_available(name);
        let opens =
            present && Mp4Encoder::create(config(&tmp, Some(vec![name.to_string()]), w, h)).is_ok();
        println!(
            "  {name:<20} in libav: {:<3}  opens: {}",
            if present { "yes" } else { "no" },
            if opens { "YES" } else { "no" }
        );
    }
    let names: Vec<String> = std::env::args().skip(1).collect();
    let mut enc = match Mp4Encoder::create(config(&tmp, (!names.is_empty()).then_some(names), w, h))
    {
        Ok(e) => e,
        Err(e) => {
            println!("FAIL: no encoder could start: {e}");
            std::process::exit(1);
        }
    };
    println!("using encoder: {}", enc.video_encoder());
    let frames = 150u32;
    let mut px = vec![255u8; (w * h * 4) as usize];
    let t0 = Instant::now();
    for i in 0..frames {
        // a moving gradient + noise-ish texture so the encoder has real work
        for (n, p) in px.chunks_exact_mut(4).enumerate() {
            let x = (n as u32 % w) + i * 4;
            let y = n as u32 / w;
            p[0] = (x / 8) as u8;
            p[1] = (y / 5) as u8 ^ (x as u8 & 31);
            p[2] = ((x ^ y) & 255) as u8;
        }
        enc.push_video(&px).expect("push_video");
        if i % 30 == 29 {
            let pcm: Vec<f32> = (0..48_000)
                .flat_map(|s| {
                    let v = (s as f32 * 440.0 * std::f32::consts::TAU / 48_000.0).sin() * 0.3;
                    [v, v]
                })
                .collect();
            enc.push_audio(&pcm).expect("push_audio");
        }
    }
    let st = enc.finish().expect("finish");
    let secs = t0.elapsed().as_secs_f64();
    println!(
        "encode: {} frames in {:.2}s = {:.1} fps ({:.2}x realtime), {} KiB, encoder {}",
        st.frames,
        secs,
        st.frames as f64 / secs,
        st.frames as f64 / 30.0 / secs,
        st.file_bytes / 1024,
        st.video_encoder
    );
    let mut d = open_file(&tmp, 48_000).expect("reopen");
    let n = d.info().video.as_ref().map_or(0, |v| v.frame_count);
    let t1 = Instant::now();
    for i in (0..n).step_by(5) {
        block_on(d.video_frame(i)).expect("decode");
    }
    let dsecs = t1.elapsed().as_secs_f64();
    println!(
        "decode (random access, every 5th of {n} frames, each from its keyframe): {:.1} fps",
        (n as f64 / 5.0) / dsecs
    );
    let mut d = open_file(&tmp, 48_000).expect("reopen");
    let t2 = Instant::now();
    for i in 0..n {
        block_on(d.video_frame(i)).expect("decode");
    }
    println!(
        "decode (sequential, all {n} frames): {:.1} fps",
        n as f64 / t2.elapsed().as_secs_f64()
    );
    if st.frames != frames as u64 || n != frames as i64 {
        println!(
            "FAIL: expected {frames} frames, wrote {} and read back {n}",
            st.frames
        );
        ok = false;
    }
    let _ = std::fs::remove_file(&tmp);
    println!("{}", if ok { "OK" } else { "FAILED" });
    std::process::exit(if ok { 0 } else { 1 });
}
