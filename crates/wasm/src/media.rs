//! Web media bindings (M1-016): `app_media::HostDecoder` driven by a JS host (the WebCodecs backend in `engine-client`).
//! Thin: planning lives in `app-media`; the JS side reads bytes (`Blob.slice`), runs the codecs and owns the `VideoFrame`s.
//! Frames cross as small integer ids; `FrameRef` keeps the Rust frame alive, so dropping it releases (closes) the JS frame.

use app_media::{
    AudioRequest, Decoder, FrameData, FrameKind, FrameKinds, GpuFrameHandle, GpuResource,
    HostDecoder, MediaError, PacketDecoder, PacketRef, Probe, Source, Track, VideoFrame, VideoOut,
    VideoRequest,
};
use js_sys::{Float32Array, Promise, Reflect, Uint8Array};
use serde_json::json;
use std::any::Any;
use std::rc::Rc;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

#[wasm_bindgen]
extern "C" {
    /// `{ length: number, read(offset, len): Promise<Uint8Array> }` (a Blob/File wrapper).
    pub type JsSource;
    #[wasm_bindgen(method, getter)]
    fn length(this: &JsSource) -> f64;
    #[wasm_bindgen(method)]
    fn read(this: &JsSource, offset: f64, len: f64) -> Promise;

    /// The WebCodecs backend. `decodeVideo` resolves `{width, height, id}` (GPU frame kept in the host's table) or
    /// `{width, height, data: Uint8Array}` (RGBA); `decodeAudio` resolves a `Float32Array`; rejections are `{kind, message}`.
    pub type JsHost;
    #[wasm_bindgen(method, js_name = decodeVideo)]
    fn decode_video(this: &JsHost, request_json: &str, gpu: bool) -> Promise;
    #[wasm_bindgen(method, js_name = decodeAudio)]
    fn decode_audio(this: &JsHost, request_json: &str) -> Promise;
    #[wasm_bindgen(method)]
    fn release(this: &JsHost, id: u32);
    #[wasm_bindgen(method, js_name = hasGpu)]
    fn has_gpu(this: &JsHost) -> bool;
}

fn media_err(e: &MediaError) -> JsValue {
    let (kind, msg) = match e {
        MediaError::OutOfRange => ("out_of_range", "out of range".to_string()),
        MediaError::Unsupported(s) => ("unsupported", s.clone()),
        MediaError::Io(s) => ("io", s.clone()),
        MediaError::Invalid(s) => ("invalid", s.clone()),
        MediaError::Cancelled => ("cancelled", "cancelled".to_string()),
    };
    JsValue::from_str(&json!({"kind": kind, "message": msg}).to_string())
}

/// Turns what a JS promise rejected with (`{kind, message}`, an Error, anything) into a `MediaError`.
fn from_js(v: JsValue) -> MediaError {
    let get = |k: &str| {
        Reflect::get(&v, &JsValue::from_str(k))
            .ok()
            .and_then(|x| x.as_string())
    };
    let msg = get("message")
        .or_else(|| v.as_string())
        .unwrap_or_else(|| "decoder failed".into());
    match get("kind").as_deref() {
        Some("unsupported") => MediaError::Unsupported(msg),
        Some("cancelled") => MediaError::Cancelled,
        Some("invalid") => MediaError::Invalid(msg),
        Some("out_of_range") => MediaError::OutOfRange,
        _ => MediaError::Io(msg),
    }
}

struct WebSource(JsSource);

impl Source for WebSource {
    fn len(&self) -> u64 {
        self.0.length() as u64
    }
    async fn read_at(&self, offset: u64, buf: &mut [u8]) -> Result<usize, MediaError> {
        let want = (buf.len() as u64).min(self.len().saturating_sub(offset));
        if want == 0 {
            return Ok(0);
        }
        let v = JsFuture::from(self.0.read(offset as f64, want as f64))
            .await
            .map_err(from_js)?;
        let arr: Uint8Array = v
            .dyn_into()
            .map_err(|_| MediaError::Io("source read did not return a Uint8Array".into()))?;
        let n = (arr.length() as usize).min(buf.len());
        arr.subarray(0, n as u32).copy_to(&mut buf[..n]);
        Ok(n)
    }
}

/// The host-side frame behind a `GpuFrameHandle`: released (VideoFrame.close()) when the last Rust clone drops.
struct JsFrame {
    id: u32,
    host: Rc<JsHost>,
}
impl GpuResource for JsFrame {
    fn as_any(&self) -> &dyn Any {
        self
    }
}
impl Drop for JsFrame {
    fn drop(&mut self) {
        self.host.release(self.id);
    }
}

struct WebHost(Rc<JsHost>);

fn packets_json(p: &[PacketRef]) -> serde_json::Value {
    p.iter()
        .map(|p| json!({"offset": p.offset, "size": p.size, "key": p.keyframe, "ts": p.ts_us, "dur": p.dur_us}))
        .collect()
}

impl PacketDecoder for WebHost {
    fn frame_kinds(&self) -> FrameKinds {
        if self.0.has_gpu() {
            FrameKinds::BOTH
        } else {
            FrameKinds::CPU
        }
    }

    async fn decode_video(
        &mut self,
        req: &VideoRequest,
        kind: FrameKind,
    ) -> Result<VideoOut, MediaError> {
        let body = json!({"frame": req.frame_index, "target": req.target_ts_us, "packets": packets_json(&req.packets)});
        let v = JsFuture::from(
            self.0
                .decode_video(&body.to_string(), kind == FrameKind::Gpu),
        )
        .await
        .map_err(from_js)?;
        let num = |k: &str| {
            Reflect::get(&v, &JsValue::from_str(k))
                .ok()
                .and_then(|x| x.as_f64())
                .ok_or_else(|| MediaError::Io(format!("host result lacks `{k}`")))
        };
        let (width, height) = (num("width")? as u32, num("height")? as u32);
        if kind == FrameKind::Gpu {
            let id = num("id")? as u32;
            // From here the frame is owned by Rust: if anything below fails, the guard still releases it.
            let res = JsFrame {
                id,
                host: self.0.clone(),
            };
            let est = GpuFrameHandle::estimate_bytes(width, height);
            return Ok(VideoOut {
                width,
                height,
                data: FrameData::Gpu(GpuFrameHandle::new(res, est)),
            });
        }
        let data = Reflect::get(&v, &JsValue::from_str("data"))
            .map_err(|_| MediaError::Io("host result lacks pixels".into()))?;
        let arr: Uint8Array = data
            .dyn_into()
            .map_err(|_| MediaError::Io("pixels are not a Uint8Array".into()))?;
        app_media::cpu_out(width, height, arr.to_vec())
    }

    async fn decode_audio(&mut self, req: &AudioRequest) -> Result<Vec<f32>, MediaError> {
        let body = json!({"start": req.start_sample, "count": req.count, "rate": req.rate, "preroll": req.preroll_packets, "fromStart": req.from_start,
            "firstTs": req.first_ts_us, "packets": packets_json(&req.packets)});
        let v = JsFuture::from(self.0.decode_audio(&body.to_string()))
            .await
            .map_err(from_js)?;
        let arr: Float32Array = v
            .dyn_into()
            .map_err(|_| MediaError::Io("audio is not a Float32Array".into()))?;
        Ok(arr.to_vec())
    }
}

/// A decoded video frame held by the engine. Dropping it (`free()` from JS) releases the host frame.
#[wasm_bindgen]
pub struct FrameRef(VideoFrame);

#[wasm_bindgen]
impl FrameRef {
    pub fn index(&self) -> f64 {
        self.0.index as f64
    }
    /// Presentation time in ticks (ADR 0010); exact below 2^53 (about 100 days).
    #[wasm_bindgen(js_name = ptsTicks)]
    pub fn pts_ticks(&self) -> f64 {
        self.0.pts.ticks() as f64
    }
    pub fn width(&self) -> u32 {
        self.0.width
    }
    pub fn height(&self) -> u32 {
        self.0.height
    }
    /// Host id of the GPU frame (look it up in the host's table), or undefined for a CPU frame.
    #[wasm_bindgen(js_name = gpuId)]
    pub fn gpu_id(&self) -> Option<u32> {
        self.0
            .as_gpu()
            .and_then(|h| h.downcast_ref::<JsFrame>())
            .map(|f| f.id)
    }
    /// RGBA pixels of a CPU frame (a copy), or undefined for a GPU frame.
    pub fn pixels(&self) -> Option<Vec<u8>> {
        self.0.as_cpu().map(|f| f.data.to_vec())
    }
}

/// An opened media file: the probe (tracks, packet tables) and, once `attach`ed, a decoder.
#[wasm_bindgen]
pub struct MediaFile {
    probe: Probe,
    dec: Option<HostDecoder<WebHost>>,
}

fn json_track(t: &Track) -> serde_json::Value {
    json!({"codec": t.codec, "width": t.width, "height": t.height, "rotation": t.rotation, "sampleRate": t.sample_rate,
        "channels": t.channels, "timescale": t.timescale, "durationTicks": t.duration.ticks(), "packets": t.packets.len(),
        "fps": t.nominal_fps.map(|f| json!([f.num, f.den])), "vfr": t.vfr})
}

#[wasm_bindgen]
impl MediaFile {
    /// Probes the file through `source` (only headers and the index are read, never the media data).
    pub async fn open(source: JsSource) -> Result<MediaFile, JsValue> {
        let probe = app_media::probe(&WebSource(source))
            .await
            .map_err(|e| media_err(&e))?;
        Ok(MediaFile { probe, dec: None })
    }

    /// JSON summary: `{container, durationTicks, video?: {...}, audio?: {...}}` (no packet tables).
    pub fn info(&self) -> String {
        json!({"container": format!("{:?}", self.probe.format), "durationTicks": self.probe.duration.ticks(),
            "video": self.probe.video().map(json_track), "audio": self.probe.audio().map(json_track)})
        .to_string()
    }

    /// Diagnostics: the video packet table in decode order as JSON `[{offset,size,key,ts,dur}]` (tests build an independent linear
    /// decode from it; large for long files, so not for the hot path).
    #[wasm_bindgen(js_name = videoPacketsJson)]
    pub fn video_packets_json(&self) -> String {
        let refs: Vec<PacketRef> = self.probe.video().map_or_else(Vec::new, |t| {
            t.packets.iter().map(app_media::packet_ref).collect()
        });
        packets_json(&refs).to_string()
    }

    /// `description` bytes for `VideoDecoder.configure` (avcC / hvcC / ...), empty when the codec has none.
    #[wasm_bindgen(js_name = videoDescription)]
    pub fn video_description(&self) -> Vec<u8> {
        self.probe
            .video()
            .map_or_else(Vec::new, |t| t.codec_description.clone())
    }

    #[wasm_bindgen(js_name = audioDescription)]
    pub fn audio_description(&self) -> Vec<u8> {
        self.probe
            .audio()
            .map_or_else(Vec::new, |t| t.codec_description.clone())
    }

    /// Connects the JS host. `audio_rate` is the project sample rate `audio()` returns.
    pub fn attach(&mut self, host: JsHost, audio_rate: u32) -> Result<(), JsValue> {
        let dec = HostDecoder::new(
            WebHost(Rc::new(host)),
            self.probe.video().cloned(),
            self.probe.audio().cloned(),
            audio_rate,
        )
        .map_err(|e| media_err(&e))?;
        self.dec = Some(dec);
        Ok(())
    }

    /// Chooses GPU frames (`true`) or CPU RGBA (`false`); throws `unsupported` if the host cannot.
    #[wasm_bindgen(js_name = setGpu)]
    pub fn set_gpu(&mut self, gpu: bool) -> Result<(), JsValue> {
        let kind = if gpu { FrameKind::Gpu } else { FrameKind::Cpu };
        self.dec_mut()?
            .set_frame_kind(kind)
            .map_err(|e| media_err(&e))
    }

    #[wasm_bindgen(js_name = videoFrame)]
    pub async fn video_frame(&mut self, index: f64) -> Result<FrameRef, JsValue> {
        let d = self.dec_mut()?;
        d.video_frame(index as i64)
            .await
            .map(FrameRef)
            .map_err(|e| media_err(&e))
    }

    /// Interleaved f32 PCM at the project rate, `count` frames from `start_sample`.
    pub async fn audio(&mut self, start_sample: f64, count: u32) -> Result<Float32Array, JsValue> {
        let d = self.dec_mut()?;
        let pcm = d
            .audio_f32(start_sample as i64, count as usize)
            .await
            .map_err(|e| media_err(&e))?;
        Ok(Float32Array::from(pcm.as_slice()))
    }
}

impl MediaFile {
    fn dec_mut(&mut self) -> Result<&mut HostDecoder<WebHost>, JsValue> {
        self.dec
            .as_mut()
            .ok_or_else(|| media_err(&MediaError::Invalid("decoder not attached".into())))
    }
}
