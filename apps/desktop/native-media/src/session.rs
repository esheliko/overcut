//! Synchronous, command-shaped wrappers over the decoder and encoder: what the Tauri commands call, tested here without a webview.
use crate::decode::{block_on, open_probed, LibavHost};
use crate::encode::{AudioConfig, EncoderConfig, ExportStats, Mp4Encoder};
use app_media::{Decoder, FrameData, HostDecoder, MediaError, Probe, Track};
use serde_json::json;
use std::path::Path;

fn track_json(t: &Track) -> serde_json::Value {
    json!({"codec": t.codec, "width": t.width, "height": t.height, "rotation": t.rotation, "sampleRate": t.sample_rate,
        "channels": t.channels, "timescale": t.timescale, "durationTicks": t.duration.ticks(), "packets": t.packets.len(),
        "fps": t.nominal_fps.map(|f| json!([f.num, f.den])), "vfr": t.vfr})
}

/// An open file. Same JSON shape as the web `MediaFile.info()` so the UI's `MediaFileInfo` parser is shared.
pub struct NativeMedia {
    dec: HostDecoder<LibavHost>,
    info: String,
    pts: Vec<i64>,
}

impl NativeMedia {
    pub fn open(path: &Path, audio_rate: u32) -> Result<Self, MediaError> {
        let (dec, probe) = open_probed(path, audio_rate)?;
        let info = json!({"container": format!("{:?}", probe.format), "durationTicks": probe.duration.ticks(),
            "video": probe.video().map(track_json), "audio": probe.audio().map(track_json)})
        .to_string();
        let pts = presentation_ticks(&probe);
        Ok(NativeMedia { dec, info, pts })
    }
    pub fn info_json(&self) -> &str {
        &self.info
    }
    /// Timestamp (ticks) of each video frame in presentation order: `frameIndexAt` is a binary search over this.
    pub fn pts_ticks(&self) -> &[i64] {
        &self.pts
    }
    /// `(width, height, RGBA8 row-major)` of frame `index` in presentation order.
    pub fn video_frame(&mut self, index: i64) -> Result<(u32, u32, Vec<u8>), MediaError> {
        let f = block_on(self.dec.video_frame(index))?;
        match f.data {
            FrameData::Cpu(c) => Ok((c.width, c.height, c.data.to_vec())),
            _ => Err(MediaError::Unsupported(
                "native decoder returned a GPU frame".into(),
            )),
        }
    }
    /// Interleaved f32 PCM at the open rate (silence is not synthesised: out of range is an error, the caller clamps).
    pub fn audio(&mut self, start: i64, count: usize) -> Result<Vec<f32>, MediaError> {
        let total = self.dec.info().audio.as_ref().map_or(0, |a| a.sample_count);
        let channels = self.dec.info().audio.as_ref().map_or(2, |a| a.channels) as usize;
        let have = (total - start).clamp(0, count as i64) as usize;
        let mut out = if have > 0 {
            block_on(self.dec.audio_f32(start, have))?
        } else {
            Vec::new()
        };
        out.resize(count * channels, 0.0);
        Ok(out)
    }
}

fn presentation_ticks(p: &Probe) -> Vec<i64> {
    let Some(v) = p.video() else {
        return Vec::new();
    };
    let mut t: Vec<i64> = v.packets.iter().map(|k| k.pts.ticks()).collect();
    t.sort_unstable();
    t
}

/// Settings the UI sends to start a native export (`ExportSettings` after planning).
#[derive(Clone, Debug)]
pub struct ExportParams {
    pub path: std::path::PathBuf,
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub video_bitrate: u32,
    pub keyframe_seconds: f64,
    pub audio_rate: u32,
    pub audio_channels: u16,
    pub audio_bitrate: u32,
    pub has_audio: bool,
    pub prefer_software: bool,
    pub creation_time: Option<i64>,
}

pub struct NativeExport {
    enc: Mp4Encoder,
}

// SAFETY: libav contexts have no thread affinity (no thread-local state; the software paths used here touch only the context's own memory),
// so moving one to another thread is sound as long as it is used from one thread at a time. The Tauri commands guarantee that with a Mutex.
unsafe impl Send for NativeExport {}
unsafe impl Send for NativeMedia {}

impl NativeExport {
    pub fn begin(p: ExportParams) -> Result<Self, String> {
        let enc = Mp4Encoder::create(EncoderConfig {
            path: p.path,
            width: p.width,
            height: p.height,
            fps_num: p.fps_num,
            fps_den: p.fps_den,
            video_bitrate: p.video_bitrate,
            keyframe_seconds: p.keyframe_seconds,
            audio: p.has_audio.then_some(AudioConfig {
                sample_rate: p.audio_rate,
                channels: p.audio_channels,
                bitrate: p.audio_bitrate,
            }),
            video_encoders: p.prefer_software.then(|| vec!["libopenh264".to_string()]),
            creation_time: p.creation_time,
        })?;
        Ok(NativeExport { enc })
    }
    pub fn video_encoder(&self) -> &str {
        self.enc.video_encoder()
    }
    pub fn push_video(&mut self, rgba: &[u8]) -> Result<(), String> {
        self.enc.push_video(rgba)
    }
    pub fn push_audio(&mut self, pcm: &[f32]) -> Result<(), String> {
        self.enc.push_audio(pcm)
    }
    pub fn finish(self) -> Result<ExportStats, String> {
        self.enc.finish()
    }
    pub fn abort(self) {
        self.enc.abort()
    }
}
