//! H.264 + AAC in MP4 through libav, hardware encoders first (ADR 0004, S4 results).
//!
//! Only LGPL-licensed encoders are ever named: the OS / GPU encoders in [`H264_PREFERENCE`], Cisco's `libopenh264` as the software fallback
//! and libav's own native `aac`. Never `libx264`, `libx265` or `libfdk_aac` (GPL / non-free).
use ff::codec::{self, Id};
use ff::format::{self, Pixel, Sample};
use ff::software::scaling;
use ff::{Dictionary, Rational};
use ffmpeg_next as ff;
use std::path::PathBuf;
use std::time::Instant;

/// H.264 encoders in the order tried. Each is skipped when libav was built without it or the machine has no such hardware (open fails).
/// VAAPI is deliberately absent: it needs a hardware frame context and device (a follow-up, `docs/adr/0004`), so on Linux the fallback is openh264.
pub const H264_PREFERENCE: &[&str] = &[
    "h264_videotoolbox",
    "h264_nvenc",
    "h264_qsv",
    "h264_amf",
    "h264_mf",
    "libopenh264",
];

/// The pixel format an encoder takes from system memory: the Intel / Media Foundation / AMD hardware paths want NV12, the rest planar 4:2:0.
fn pixel_format_for(encoder: &str) -> Pixel {
    match encoder {
        "h264_qsv" | "h264_mf" | "h264_amf" => Pixel::NV12,
        _ => Pixel::YUV420P,
    }
}

/// True when libav in this process has the named encoder compiled in (it may still fail to open without the hardware).
pub fn encoder_available(name: &str) -> bool {
    let _ = crate::init();
    ff::encoder::find_by_name(name).is_some()
}

#[derive(Clone, Debug)]
pub struct EncoderConfig {
    pub path: PathBuf,
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub video_bitrate: u32,
    /// Seconds between keyframes.
    pub keyframe_seconds: f64,
    /// `None`: no audio track.
    pub audio: Option<AudioConfig>,
    /// Encoder names to try instead of [`H264_PREFERENCE`] (tests, `prefer-software` = `["libopenh264"]`).
    pub video_encoders: Option<Vec<String>>,
    /// Unix seconds written as the MP4 creation time (`None`: libav's default).
    pub creation_time: Option<i64>,
}

#[derive(Clone, Copy, Debug)]
pub struct AudioConfig {
    pub sample_rate: u32,
    pub channels: u16,
    pub bitrate: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ExportStats {
    pub frames: u64,
    pub video_encoder: String,
    pub audio_samples: u64,
    pub file_bytes: u64,
    pub encode_ms: u64,
}

pub struct Mp4Encoder {
    cfg: EncoderConfig,
    out: format::context::Output,
    video: ff::encoder::Video,
    v_stream: usize,
    v_tb: Rational,
    scaler: scaling::Context,
    video_name: String,
    frames: u64,
    audio: Option<AudioState>,
    started: Instant,
    done: bool,
}

struct AudioState {
    enc: ff::encoder::Audio,
    stream: usize,
    tb: Rational,
    cfg: AudioConfig,
    frame_size: usize,
    /// Interleaved samples waiting for a full encoder frame.
    pending: Vec<f32>,
    next_pts: i64,
    total: u64,
}

fn e<E: std::fmt::Display>(x: E) -> String {
    x.to_string()
}

impl Mp4Encoder {
    pub fn create(cfg: EncoderConfig) -> Result<Self, String> {
        crate::init()?;
        if cfg.width == 0
            || cfg.height == 0
            || cfg.width % 2 != 0
            || cfg.height % 2 != 0
            || cfg.fps_num == 0
            || cfg.fps_den == 0
        {
            return Err("width and height must be even and non-zero, frame rate positive".into());
        }
        let mut out = format::output_as(&cfg.path, "mp4").map_err(e)?;
        let global = out.format().flags().contains(format::Flags::GLOBAL_HEADER);
        let v_tb = Rational::new(cfg.fps_den as i32, cfg.fps_num as i32);

        let names: Vec<String> = cfg
            .video_encoders
            .clone()
            .unwrap_or_else(|| H264_PREFERENCE.iter().map(|s| s.to_string()).collect());
        let mut last_err = String::from(
            "no H.264 encoder is available (libav was built without hardware encoders or openh264)",
        );
        let mut opened = None;
        for name in &names {
            let Some(codec) = ff::encoder::find_by_name(name) else {
                continue;
            };
            let mut v = codec::context::Context::new_with_codec(codec)
                .encoder()
                .video()
                .map_err(e)?;
            v.set_width(cfg.width);
            v.set_height(cfg.height);
            v.set_format(pixel_format_for(name));
            v.set_time_base(v_tb);
            v.set_frame_rate(Some(Rational::new(cfg.fps_num as i32, cfg.fps_den as i32)));
            v.set_bit_rate(cfg.video_bitrate as usize);
            v.set_gop(
                ((cfg.keyframe_seconds * cfg.fps_num as f64 / cfg.fps_den as f64).round() as u32)
                    .max(1),
            );
            v.set_max_b_frames(0); // no reordering: pts == dts, the muxer needs no edit list, export order == display order
            if global {
                v.set_flags(codec::Flags::GLOBAL_HEADER);
            }
            let mut opts = Dictionary::new();
            if name == "h264_videotoolbox" {
                opts.set("realtime", "0");
                opts.set("allow_sw", "0"); // never silently fall to Apple's software path: the next entry is ours
            }
            match v.open_as_with(codec, opts) {
                Ok(enc) => {
                    opened = Some((enc, name.clone()));
                    break;
                }
                Err(err) => last_err = format!("{name}: {err}"),
            }
        }
        let (video, video_name) = opened.ok_or(last_err)?;
        let mut vs = out
            .add_stream(ff::encoder::find(Id::H264).ok_or("no H.264 codec id")?)
            .map_err(e)?;
        vs.set_parameters(&video);
        vs.set_time_base(v_tb);
        let v_stream = vs.index();

        let mut audio = None;
        if let Some(a) = cfg.audio {
            let codec = ff::encoder::find(Id::AAC).ok_or("libav has no native AAC encoder")?;
            let mut enc = codec::context::Context::new_with_codec(codec)
                .encoder()
                .audio()
                .map_err(e)?;
            let layout = ff::ChannelLayout::default(a.channels as i32);
            enc.set_rate(a.sample_rate as i32);
            enc.set_channel_layout(layout);
            enc.set_format(Sample::F32(format::sample::Type::Planar));
            enc.set_bit_rate(a.bitrate as usize);
            enc.set_time_base(Rational::new(1, a.sample_rate as i32));
            if global {
                enc.set_flags(codec::Flags::GLOBAL_HEADER);
            }
            let enc = enc.open_as(codec).map_err(e)?;
            let mut s = out.add_stream(codec).map_err(e)?;
            s.set_parameters(&enc);
            s.set_time_base(Rational::new(1, a.sample_rate as i32));
            let frame_size = enc.frame_size().max(1) as usize;
            audio = Some(AudioState {
                enc,
                stream: s.index(),
                tb: Rational::new(1, a.sample_rate as i32),
                cfg: a,
                frame_size,
                pending: Vec::new(),
                next_pts: 0,
                total: 0,
            });
        }
        if let Some(t) = cfg.creation_time {
            let mut md = Dictionary::new();
            md.set("creation_time", &format_iso(t));
            out.set_metadata(md);
        }
        let mut opts = Dictionary::new();
        opts.set("movflags", "+faststart");
        out.write_header_with(opts).map_err(e)?;
        // Stream time bases are only final after the header is written.
        let v_tb_out = out.stream(v_stream).ok_or("stream")?.time_base();
        if let Some(a) = audio.as_mut() {
            a.tb = out.stream(a.stream).ok_or("stream")?.time_base();
        }
        let scaler = scaling::Context::get(
            Pixel::RGBA,
            cfg.width,
            cfg.height,
            Pixel::YUV420P,
            cfg.width,
            cfg.height,
            scaling::Flags::BICUBIC,
        )
        .map_err(e)?;
        Ok(Mp4Encoder {
            cfg,
            out,
            video,
            v_stream,
            v_tb: v_tb_out,
            scaler,
            video_name,
            frames: 0,
            audio,
            started: Instant::now(),
            done: false,
        })
    }

    /// Name of the H.264 encoder that opened (`libopenh264`, `h264_videotoolbox`, ...).
    pub fn video_encoder(&self) -> &str {
        &self.video_name
    }

    /// One RGBA8 frame (`width * height * 4` bytes, no padding), in display order.
    pub fn push_video(&mut self, rgba: &[u8]) -> Result<(), String> {
        let (w, h) = (self.cfg.width as usize, self.cfg.height as usize);
        if rgba.len() != w * h * 4 {
            return Err(format!(
                "frame has {} bytes, expected {}",
                rgba.len(),
                w * h * 4
            ));
        }
        let mut src = ff::frame::Video::new(Pixel::RGBA, w as u32, h as u32);
        let stride = src.stride(0);
        for row in 0..h {
            src.data_mut(0)[row * stride..row * stride + w * 4]
                .copy_from_slice(&rgba[row * w * 4..(row + 1) * w * 4]);
        }
        let mut yuv = ff::frame::Video::empty();
        self.scaler.run(&src, &mut yuv).map_err(e)?;
        yuv.set_pts(Some(self.frames as i64));
        let key_every = ((self.cfg.keyframe_seconds * self.cfg.fps_num as f64
            / self.cfg.fps_den as f64)
            .round() as u64)
            .max(1);
        if self.frames % key_every == 0 {
            yuv.set_kind(ff::picture::Type::I);
        }
        self.video.send_frame(&yuv).map_err(e)?;
        self.frames += 1;
        self.drain_video()
    }

    fn drain_video(&mut self) -> Result<(), String> {
        let enc_tb = Rational::new(self.cfg.fps_den as i32, self.cfg.fps_num as i32);
        let mut pkt = ff::Packet::empty();
        while self.video.receive_packet(&mut pkt).is_ok() {
            pkt.set_stream(self.v_stream);
            pkt.rescale_ts(enc_tb, self.v_tb);
            pkt.write_interleaved(&mut self.out).map_err(e)?;
        }
        Ok(())
    }

    /// Interleaved f32 PCM at the configured rate and channel count, in order.
    pub fn push_audio(&mut self, pcm: &[f32]) -> Result<(), String> {
        let a = self
            .audio
            .as_mut()
            .ok_or("this export has no audio track")?;
        a.pending.extend_from_slice(pcm);
        let ch = a.cfg.channels as usize;
        while a.pending.len() >= a.frame_size * ch {
            let chunk: Vec<f32> = a.pending.drain(..a.frame_size * ch).collect();
            Self::encode_audio(&mut self.out, a, &chunk)?;
        }
        Ok(())
    }

    fn encode_audio(
        out: &mut format::context::Output,
        a: &mut AudioState,
        interleaved: &[f32],
    ) -> Result<(), String> {
        let ch = a.cfg.channels as usize;
        let n = interleaved.len() / ch;
        let mut f = ff::frame::Audio::new(
            Sample::F32(format::sample::Type::Planar),
            n,
            ff::ChannelLayout::default(ch as i32),
        );
        f.set_rate(a.cfg.sample_rate);
        for c in 0..ch {
            let plane = f.plane_mut::<f32>(c);
            for i in 0..n {
                plane[i] = interleaved[i * ch + c];
            }
        }
        f.set_pts(Some(a.next_pts));
        a.next_pts += n as i64;
        a.total += n as u64;
        a.enc.send_frame(&f).map_err(e)?;
        Self::drain_audio(out, a)
    }

    fn drain_audio(out: &mut format::context::Output, a: &mut AudioState) -> Result<(), String> {
        let mut pkt = ff::Packet::empty();
        while a.enc.receive_packet(&mut pkt).is_ok() {
            pkt.set_stream(a.stream);
            pkt.rescale_ts(Rational::new(1, a.cfg.sample_rate as i32), a.tb);
            pkt.write_interleaved(out).map_err(e)?;
        }
        Ok(())
    }

    /// Flushes both encoders, writes the index and returns what was produced.
    pub fn finish(mut self) -> Result<ExportStats, String> {
        self.video.send_eof().map_err(e)?;
        self.drain_video()?;
        if let Some(a) = self.audio.as_mut() {
            if !a.pending.is_empty() {
                let rest = std::mem::take(&mut a.pending);
                Self::encode_audio(&mut self.out, a, &rest)?;
            }
            a.enc.send_eof().map_err(e)?;
            Self::drain_audio(&mut self.out, a)?;
        }
        self.out.write_trailer().map_err(e)?;
        self.done = true;
        let file_bytes = std::fs::metadata(&self.cfg.path)
            .map(|m| m.len())
            .unwrap_or(0);
        Ok(ExportStats {
            frames: self.frames,
            video_encoder: self.video_name.clone(),
            audio_samples: self.audio.as_ref().map_or(0, |a| a.total),
            file_bytes,
            encode_ms: self.started.elapsed().as_millis() as u64,
        })
    }

    /// Drops the encoders and deletes the partial file.
    pub fn abort(self) {
        let path = self.cfg.path.clone();
        drop(self);
        let _ = std::fs::remove_file(path);
    }
}

fn format_iso(unix: i64) -> String {
    // Civil-from-days (Hinnant), UTC.
    let days = unix.div_euclid(86_400);
    let secs = unix.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        secs / 3600,
        secs % 3600 / 60,
        secs % 60
    )
}
