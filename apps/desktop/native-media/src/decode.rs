use app_media::{
    packet_ref, probe, ticks_to_us, AudioRequest, FrameKind, FrameKinds, HostDecoder, MediaError,
    PacketDecoder, PacketRef, Source, Track, VideoOut, VideoRequest,
};
use app_media::{FrameData, RgbaFrame};
use ff::codec::{self, Id};
use ff::format::Pixel;
use ff::software::{resampling, scaling};
use ffmpeg_next as ff;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::Arc;

fn io<E: std::fmt::Display>(e: E) -> MediaError {
    MediaError::Io(e.to_string())
}

/// Maps a WebCodecs codec string (what `probe` reports) to a libav codec id, `None` when libav needs more than we feed it.
fn codec_id(codec: &str) -> Option<Id> {
    let c = codec.to_ascii_lowercase();
    Some(if c.starts_with("avc1") || c.starts_with("avc3") {
        Id::H264
    } else if c.starts_with("hvc1") || c.starts_with("hev1") {
        Id::HEVC
    } else if c.starts_with("vp09") {
        Id::VP9
    } else if c == "vp8" {
        Id::VP8
    } else if c.starts_with("av01") {
        Id::AV1
    } else if c.starts_with("mp4a.40") {
        Id::AAC
    } else if c == "opus" {
        Id::OPUS
    } else if c == "mp3" || c == "mp4a.6b" {
        Id::MP3
    } else if c == "flac" {
        Id::FLAC
    } else if c == "pcm-u8" {
        Id::PCM_U8
    } else if c == "pcm-s16" {
        Id::PCM_S16LE
    } else if c == "pcm-s24" {
        Id::PCM_S24LE
    } else if c == "pcm-s32" {
        Id::PCM_S32LE
    } else if c == "pcm-f32" {
        Id::PCM_F32LE
    } else {
        return None;
    })
}

fn unsupported(track: &Track) -> MediaError {
    MediaError::Unsupported(format!("no native decoder for codec {}", track.codec))
}

/// A `Source` over a local file (blocking reads; the desktop host runs on its own thread).
pub struct FileSource {
    file: std::sync::Mutex<File>,
    len: u64,
}
impl FileSource {
    pub fn open(path: &Path) -> Result<Self, MediaError> {
        let file = File::open(path).map_err(io)?;
        let len = file.metadata().map_err(io)?.len();
        Ok(FileSource {
            file: std::sync::Mutex::new(file),
            len,
        })
    }
}
impl Source for FileSource {
    fn len(&self) -> u64 {
        self.len
    }
    async fn read_at(&self, offset: u64, buf: &mut [u8]) -> Result<usize, MediaError> {
        let mut f = self
            .file
            .lock()
            .map_err(|_| MediaError::Io("poisoned".into()))?;
        f.seek(SeekFrom::Start(offset)).map_err(io)?;
        f.read(buf).map_err(io)
    }
}

/// Native packet decoder: libav software codecs, plus hardware decoders where libav offers them (see `docs/adr/0004` S4 results).
pub struct LibavHost {
    file: File,
    gop: Gop,
    scaler: Option<scaling::Context>,
    video: Option<Track>,
    audio: Option<Track>,
}

/// Opens `path`, probes it with the engine's own demuxer and returns the standard `HostDecoder` over a libav host.
pub fn open_file(path: &Path, audio_rate: u32) -> Result<HostDecoder<LibavHost>, MediaError> {
    open_probed(path, audio_rate).map(|(d, _)| d)
}

/// Like [`open_file`] and also returns the probe (track tables), which `NativeMedia` reports to the UI.
pub fn open_probed(
    path: &Path,
    audio_rate: u32,
) -> Result<(HostDecoder<LibavHost>, app_media::Probe), MediaError> {
    crate::init().map_err(MediaError::Io)?;
    let src = FileSource::open(path)?;
    let p = block_on(probe(&src))?;
    let video = p.video().cloned();
    let audio = p.audio().cloned();
    for t in video.iter().chain(audio.iter()) {
        if codec_id(&t.codec).is_none() || ff::decoder::find(codec_id(&t.codec).unwrap()).is_none()
        {
            return Err(unsupported(t));
        }
    }
    let host = LibavHost {
        file: File::open(path).map_err(io)?,
        gop: Gop::default(),
        scaler: None,
        video: video.clone(),
        audio: audio.clone(),
    };
    Ok((HostDecoder::new(host, video, audio, audio_rate)?, p))
}

pub fn block_on<F: std::future::Future>(f: F) -> F::Output {
    use std::task::{Context, Poll, Waker};
    let mut f = std::pin::pin!(f);
    let mut cx = Context::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(v) = f.as_mut().poll(&mut cx) {
            return v;
        }
    }
}

/// Builds a decoder context with the container's `extradata` (avcC / hvcC / AudioSpecificConfig / OpusHead) and basic parameters.
fn new_context(track: &Track) -> Result<codec::Context, MediaError> {
    let id = codec_id(&track.codec).ok_or_else(|| unsupported(track))?;
    let codec = ff::decoder::find(id).ok_or_else(|| unsupported(track))?;
    let mut ctx = codec::Context::new_with_codec(codec);
    // SAFETY: `ctx` owns a freshly allocated AVCodecContext with no extradata yet; extradata is av_mallocz'd with the required zero padding
    // and ownership passes to the context, which frees it on drop.
    unsafe {
        let p = ctx.as_mut_ptr();
        let d = &track.codec_description;
        if !d.is_empty() {
            let pad = ff::ffi::AV_INPUT_BUFFER_PADDING_SIZE as usize;
            let buf = ff::ffi::av_mallocz(d.len() + pad) as *mut u8;
            if buf.is_null() {
                return Err(MediaError::Io("out of memory".into()));
            }
            std::ptr::copy_nonoverlapping(d.as_ptr(), buf, d.len());
            (*p).extradata = buf;
            (*p).extradata_size = d.len() as i32;
        }
        if track.width > 0 {
            (*p).width = track.width as i32;
            (*p).height = track.height as i32;
        }
        if track.sample_rate > 0 {
            (*p).sample_rate = track.sample_rate as i32;
            ff::ffi::av_channel_layout_default(&mut (*p).ch_layout, track.channels.max(1) as i32);
        }
        (*p).thread_count = 0; // let libav pick; frame threading adds latency but we flush per request
    }
    Ok(ctx)
}

/// Bytes `[offset, offset+size)` of the file as a libav packet carrying `pts` (microseconds).
fn read_packet(
    file: &mut File,
    offset: u64,
    size: u32,
    ts_us: i64,
    key: bool,
) -> Result<codec::packet::Packet, MediaError> {
    let mut buf = vec![0u8; size as usize];
    file.seek(SeekFrom::Start(offset)).map_err(io)?;
    file.read_exact(&mut buf).map_err(io)?;
    let mut p = codec::packet::Packet::copy(&buf);
    p.set_pts(Some(ts_us));
    p.set_dts(Some(ts_us));
    if key {
        p.set_flags(codec::packet::Flags::KEY);
    }
    Ok(p)
}

impl LibavHost {
    fn video_track(&self) -> Result<&Track, MediaError> {
        self.video.as_ref().ok_or(MediaError::OutOfRange)
    }
}

impl PacketDecoder for LibavHost {
    fn frame_kinds(&self) -> FrameKinds {
        // Hardware decoders (VideoToolbox, D3D11VA, VAAPI) would add GPU frames; that needs the renderer to import them (S1/S2) and is a follow-up.
        FrameKinds::CPU
    }

    async fn decode_video(
        &mut self,
        req: &VideoRequest,
        kind: FrameKind,
    ) -> Result<VideoOut, MediaError> {
        if kind != FrameKind::Cpu {
            return Err(MediaError::Unsupported(
                "native decoder returns CPU frames only".into(),
            ));
        }
        let track = self.video_track()?.clone();
        // Sequential access (export, playback) asks for frame i, then i + 1, ...: decoding each from its keyframe would cost O(GOP^2). So the
        // first request in a GOP decodes the WHOLE GOP once and keeps the raw (YUV) frames; the next requests in it are a lookup + a colour conversion.
        if !self.gop.frames.contains_key(&req.target_ts_us) {
            let first = req.packets.first().ok_or(MediaError::OutOfRange)?;
            let whole = gop_packets(&track, first.ts_us, self.gop_budget_frames(&track));
            let packets = whole.as_deref().unwrap_or(&req.packets);
            let mut frames = decode_packets(&track, &mut self.file, packets)?;
            if whole.is_none() {
                // Long GOP / big frames: keep only the target (the old, memory-flat path).
                frames.retain(|ts, _| *ts == req.target_ts_us);
            }
            self.gop = Gop { frames };
        }
        let frame = self
            .gop
            .frames
            .get(&req.target_ts_us)
            .ok_or_else(|| MediaError::Io(format!("frame {} not produced", req.frame_index)))?;
        let rgba = to_rgba(frame, &mut self.scaler)?;
        Ok(VideoOut {
            width: rgba.width,
            height: rgba.height,
            data: FrameData::Cpu(rgba),
        })
    }

    async fn decode_audio(&mut self, req: &AudioRequest) -> Result<Vec<f32>, MediaError> {
        let track = self.audio.clone().ok_or(MediaError::OutOfRange)?;
        let ch = track.channels.max(1) as usize;
        let rate = req.rate as i64;
        let mut out = vec![0f32; req.count * ch];
        if req.packets.is_empty() {
            return Ok(out);
        }
        let mut dec = new_context(&track)?.decoder().audio().map_err(io)?;
        let mut swr: Option<resampling::Context> = None;
        let mut samples: Vec<f32> = Vec::new();
        let mut anchor: Option<i64> = None; // output-rate sample index of samples[0]
        let mut frame = ff::frame::Audio::empty();
        let mut drain = |dec: &mut ff::decoder::Audio,
                         swr: &mut Option<resampling::Context>,
                         samples: &mut Vec<f32>,
                         anchor: &mut Option<i64>,
                         eof: bool|
         -> Result<(), MediaError> {
            while dec.receive_frame(&mut frame).is_ok() {
                if anchor.is_none() {
                    // libav drops Opus's pre-skip itself (measured: lag 0 at stream start), so the first output sample sits at the first packet's timestamp.
                    // Matroska timestamps are whole milliseconds, so mid-stream Opus can land up to 1 ms (48 samples) off: ADR 0004 S4 results.
                    *anchor = Some((req.first_ts_us as i128 * rate as i128 / 1_000_000) as i64);
                }
                if swr.is_none() {
                    *swr = Some(
                        resampling::Context::get(
                            frame.format(),
                            frame.channel_layout(),
                            frame.rate(),
                            ff::format::Sample::F32(ff::format::sample::Type::Packed),
                            frame.channel_layout(),
                            req.rate,
                        )
                        .map_err(io)?,
                    );
                }
                let mut conv = ff::frame::Audio::empty();
                swr.as_mut().unwrap().run(&frame, &mut conv).map_err(io)?;
                push_f32(&conv, ch, samples);
            }
            if eof {
                if let Some(s) = swr.as_mut() {
                    loop {
                        let mut conv = ff::frame::Audio::empty();
                        if s.flush(&mut conv).is_err() || conv.samples() == 0 {
                            break;
                        }
                        push_f32(&conv, ch, samples);
                    }
                }
            }
            Ok(())
        };
        for p in &req.packets {
            let pkt = read_packet(&mut self.file, p.offset, p.size, p.ts_us, true)?;
            dec.send_packet(&pkt).map_err(io)?;
            drain(&mut dec, &mut swr, &mut samples, &mut anchor, false)?;
        }
        dec.send_eof().map_err(io)?;
        drain(&mut dec, &mut swr, &mut samples, &mut anchor, true)?;
        let Some(a) = anchor else { return Ok(out) };
        for i in 0..req.count {
            let pos = req.start_sample + i as i64 - a;
            if pos >= 0 && (pos as usize + 1) * ch <= samples.len() {
                out[i * ch..(i + 1) * ch]
                    .copy_from_slice(&samples[pos as usize * ch..(pos as usize + 1) * ch]);
            }
        }
        Ok(out)
    }
}

/// The raw decoded frames of one GOP, by presentation timestamp (microseconds).
#[derive(Default)]
struct Gop {
    frames: HashMap<i64, ff::frame::Video>,
}

/// Raw-frame memory kept per GOP.
const GOP_BYTES: usize = 384 * 1024 * 1024;

impl LibavHost {
    /// How many frames of this track fit the GOP budget (4:2:0 = 1.5 bytes per pixel).
    fn gop_budget_frames(&self, t: &Track) -> usize {
        GOP_BYTES / ((t.width as usize * t.height as usize * 3 / 2).max(1))
    }
}

/// The packets of the GOP that starts at the keyframe with timestamp `key_ts_us`, in decode order, up to the next keyframe.
/// `None` when the GOP is longer than `max_frames` (then the caller decodes only up to its target).
fn gop_packets(track: &Track, key_ts_us: i64, max_frames: usize) -> Option<Vec<PacketRef>> {
    let start = track
        .packets
        .iter()
        .position(|p| p.keyframe && ticks_to_us(p.pts) == key_ts_us)?;
    let end = track.packets[start + 1..]
        .iter()
        .position(|p| p.keyframe)
        .map_or(track.packets.len(), |i| start + 1 + i);
    (end - start <= max_frames).then(|| track.packets[start..end].iter().map(packet_ref).collect())
}

/// Feeds `packets` (decode order) to a fresh decoder and returns every frame it outputs, by timestamp.
fn decode_packets(
    track: &Track,
    file: &mut File,
    packets: &[PacketRef],
) -> Result<HashMap<i64, ff::frame::Video>, MediaError> {
    let mut dec = new_context(track)?.decoder().video().map_err(io)?;
    let mut out = HashMap::new();
    let mut frame = ff::frame::Video::empty();
    let mut take = |dec: &mut ff::decoder::Video| {
        while dec.receive_frame(&mut frame).is_ok() {
            if let Some(ts) = frame.pts() {
                out.insert(ts, frame.clone());
            }
        }
    };
    for p in packets {
        let pkt = read_packet(file, p.offset, p.size, p.ts_us, p.keyframe)?;
        dec.send_packet(&pkt).map_err(io)?;
        take(&mut dec);
    }
    dec.send_eof().map_err(io)?;
    take(&mut dec);
    Ok(out)
}

fn to_rgba(
    frame: &ff::frame::Video,
    scaler: &mut Option<scaling::Context>,
) -> Result<RgbaFrame, MediaError> {
    let (w, h) = (frame.width(), frame.height());
    let needs_new = scaler.as_ref().is_none_or(|s| {
        s.input().format != frame.format() || s.input().width != w || s.input().height != h
    });
    if needs_new {
        *scaler = Some(
            scaling::Context::get(
                frame.format(),
                w,
                h,
                Pixel::RGBA,
                w,
                h,
                scaling::Flags::BICUBIC,
            )
            .map_err(io)?,
        );
    }
    let mut out = ff::frame::Video::empty();
    scaler
        .as_mut()
        .ok_or_else(|| MediaError::Io("no scaler".into()))?
        .run(frame, &mut out)
        .map_err(io)?;
    let stride = out.stride(0);
    let src = out.data(0);
    let mut data = Vec::with_capacity(w as usize * h as usize * 4);
    for row in 0..h as usize {
        data.extend_from_slice(&src[row * stride..row * stride + w as usize * 4]);
    }
    Ok(RgbaFrame {
        width: w,
        height: h,
        data: Arc::from(data),
    })
}

fn push_f32(frame: &ff::frame::Audio, ch: usize, into: &mut Vec<f32>) {
    let n = frame.samples() * ch;
    let bytes = &frame.data(0)[..n * 4];
    into.extend(
        bytes
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])),
    );
}
