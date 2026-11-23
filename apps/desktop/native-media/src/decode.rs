use app_media::{
    probe, AudioRequest, FrameKind, FrameKinds, HostDecoder, MediaError, PacketDecoder, Source,
    Track, VideoOut, VideoRequest,
};
use app_media::{FrameData, RgbaFrame};
use ffmpeg_next as ff;
use ff::codec::{self, Id};
use ff::format::Pixel;
use ff::software::{resampling, scaling};
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
        Ok(FileSource { file: std::sync::Mutex::new(file), len })
    }
}
impl Source for FileSource {
    fn len(&self) -> u64 {
        self.len
    }
    async fn read_at(&self, offset: u64, buf: &mut [u8]) -> Result<usize, MediaError> {
        let mut f = self.file.lock().map_err(|_| MediaError::Io("poisoned".into()))?;
        f.seek(SeekFrom::Start(offset)).map_err(io)?;
        f.read(buf).map_err(io)
    }
}

/// Native packet decoder: libav software codecs, plus hardware decoders where libav offers them (see `docs/adr/0004` S4 results).
pub struct LibavHost {
    file: File,
    video: Option<Track>,
    audio: Option<Track>,
    audio_rate: u32,
}

/// Opens `path`, probes it with the engine's own demuxer and returns the standard `HostDecoder` over a libav host.
pub fn open_file(path: &Path, audio_rate: u32) -> Result<HostDecoder<LibavHost>, MediaError> {
    crate::init().map_err(MediaError::Io)?;
    let src = FileSource::open(path)?;
    let p = block_on(probe(&src))?;
    let video = p.video().cloned();
    let audio = p.audio().cloned();
    for t in video.iter().chain(audio.iter()) {
        if codec_id(&t.codec).is_none() || ff::decoder::find(codec_id(&t.codec).unwrap()).is_none() {
            return Err(unsupported(t));
        }
    }
    let host = LibavHost { file: File::open(path).map_err(io)?, video: video.clone(), audio: audio.clone(), audio_rate };
    HostDecoder::new(host, video, audio, audio_rate)
}

fn block_on<F: std::future::Future>(f: F) -> F::Output {
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
fn read_packet(file: &mut File, offset: u64, size: u32, ts_us: i64, key: bool) -> Result<codec::packet::Packet, MediaError> {
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

    async fn decode_video(&mut self, req: &VideoRequest, kind: FrameKind) -> Result<VideoOut, MediaError> {
        if kind != FrameKind::Cpu {
            return Err(MediaError::Unsupported("native decoder returns CPU frames only".into()));
        }
        let track = self.video_track()?.clone();
        let mut dec = new_context(&track)?.decoder().video().map_err(io)?;
        let mut frame = ff::frame::Video::empty();
        let mut found: Option<RgbaFrame> = None;
        let mut scaler: Option<scaling::Context> = None;
        let mut take = |dec: &mut ff::decoder::Video, found: &mut Option<RgbaFrame>| -> Result<(), MediaError> {
            while dec.receive_frame(&mut frame).is_ok() {
                if found.is_none() && frame.pts() == Some(req.target_ts_us) {
                    let (w, h) = (frame.width(), frame.height());
                    if scaler.is_none() {
                        scaler = Some(scaling::Context::get(frame.format(), w, h, Pixel::RGBA, w, h, scaling::Flags::BICUBIC).map_err(io)?);
                    }
                    let mut out = ff::frame::Video::empty();
                    scaler.as_mut().unwrap().run(&frame, &mut out).map_err(io)?;
                    let stride = out.stride(0);
                    let src = out.data(0);
                    let mut data = Vec::with_capacity(w as usize * h as usize * 4);
                    for row in 0..h as usize {
                        data.extend_from_slice(&src[row * stride..row * stride + w as usize * 4]);
                    }
                    *found = Some(RgbaFrame { width: w, height: h, data: Arc::from(data) });
                }
            }
            Ok(())
        };
        for p in &req.packets {
            let pkt = read_packet(&mut self.file, p.offset, p.size, p.ts_us, p.keyframe)?;
            dec.send_packet(&pkt).map_err(io)?;
            take(&mut dec, &mut found)?;
        }
        dec.send_eof().map_err(io)?;
        take(&mut dec, &mut found)?;
        let f = found.ok_or_else(|| MediaError::Io(format!("frame {} not produced", req.frame_index)))?;
        Ok(VideoOut { width: f.width, height: f.height, data: FrameData::Cpu(f) })
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
        // Opus drops its pre-skip from the first output of every fresh decoder: the first frame starts that many samples after its packet's timestamp.
        let skipped_48k = if track.codec == "opus" && track.codec_description.len() >= 12 {
            i64::from(u16::from_le_bytes([track.codec_description[10], track.codec_description[11]]))
        } else {
            0
        };
        let mut swr: Option<resampling::Context> = None;
        let mut samples: Vec<f32> = Vec::new();
        let mut anchor: Option<i64> = None; // output-rate sample index of samples[0]
        let mut frame = ff::frame::Audio::empty();
        let mut drain = |dec: &mut ff::decoder::Audio, swr: &mut Option<resampling::Context>, samples: &mut Vec<f32>, anchor: &mut Option<i64>, eof: bool| -> Result<(), MediaError> {
            while dec.receive_frame(&mut frame).is_ok() {
                if anchor.is_none() {
                    let pts_us = frame.pts().unwrap_or(req.first_ts_us);
                    let shift = skipped_48k * rate / 48_000;
                    *anchor = Some((pts_us as i128 * rate as i128 / 1_000_000) as i64 + shift);
                }
                if swr.is_none() {
                    *swr = Some(
                        resampling::Context::get2(frame.format(), frame.ch_layout(), frame.rate(), ff::format::Sample::F32(ff::format::sample::Type::Packed), frame.ch_layout(), req.rate).map_err(io)?,
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
                out[i * ch..(i + 1) * ch].copy_from_slice(&samples[pos as usize * ch..(pos as usize + 1) * ch]);
            }
        }
        Ok(out)
    }
}

fn push_f32(frame: &ff::frame::Audio, ch: usize, into: &mut Vec<f32>) {
    let n = frame.samples() * ch;
    let bytes = &frame.data(0)[..n * 4];
    into.extend(bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])));
}
