//! `HostDecoder` planning and plumbing against a mock host, on the demux fixtures (M1-016).
use app_media::*;
use app_model::Time;
use std::any::Any;
use std::cell::Cell;
use std::future::Future;
use std::rc::Rc;
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

fn probe_fixture(name: &str) -> Probe {
    let d = std::fs::read(format!(
        "{}/tests/fixtures/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    block_on(probe(&MemSource(&d))).unwrap()
}

struct Res(Rc<Cell<i64>>);
impl GpuResource for Res {
    fn as_any(&self) -> &dyn Any {
        self
    }
}
impl Drop for Res {
    fn drop(&mut self) {
        self.0.set(self.0.get() - 1);
    }
}

/// Records requests; answers video with a frame whose payload is the target timestamp, audio with a ramp.
struct Mock {
    live: Rc<Cell<i64>>,
    video_reqs: Vec<VideoRequest>,
    audio_reqs: Vec<AudioRequest>,
    fail: Option<MediaError>,
    channels: usize,
}
impl PacketDecoder for Mock {
    fn frame_kinds(&self) -> FrameKinds {
        FrameKinds::BOTH
    }
    async fn decode_video(
        &mut self,
        req: &VideoRequest,
        kind: FrameKind,
    ) -> Result<VideoOut, MediaError> {
        self.video_reqs.push(req.clone());
        if let Some(e) = self.fail.clone() {
            return Err(e);
        }
        if kind == FrameKind::Gpu {
            self.live.set(self.live.get() + 1);
            let h = GpuFrameHandle::new(Res(self.live.clone()), 16);
            return Ok(VideoOut {
                width: 2,
                height: 2,
                data: FrameData::Gpu(h),
            });
        }
        let mut px = vec![0u8; 16];
        px[..8].copy_from_slice(&req.target_ts_us.to_le_bytes());
        cpu_out(2, 2, px)
    }
    async fn decode_audio(&mut self, req: &AudioRequest) -> Result<Vec<f32>, MediaError> {
        self.audio_reqs.push(req.clone());
        Ok((0..req.count * self.channels)
            .map(|i| (i % 100) as f32 / 100.0)
            .collect())
    }
}

fn mock() -> Mock {
    Mock {
        live: Rc::new(Cell::new(0)),
        video_reqs: vec![],
        audio_reqs: vec![],
        fail: None,
        channels: 2,
    }
}

fn decoder(name: &str) -> (HostDecoder<Mock>, Probe) {
    let p = probe_fixture(name);
    let mut m = mock();
    m.channels = p.audio().map_or(2, |a| a.channels as usize);
    let d = HostDecoder::new(m, p.video().cloned(), p.audio().cloned(), 48_000).unwrap();
    (d, p)
}

#[test]
fn every_frame_plan_starts_at_a_keyframe_and_ends_at_the_target() {
    for name in ["h264_aac.mp4", "frag.mp4", "vfr.mp4", "vp9_opus.webm"] {
        let (d, p) = decoder(name);
        let v = p.video().unwrap();
        let n = d.info().video.as_ref().unwrap().frame_count;
        assert_eq!(n as usize, v.packets.len());
        let mut sorted: Vec<_> = v.packets.iter().collect();
        sorted.sort_by_key(|p| p.pts);
        for i in 0..n {
            let r = d.plan_video(i).unwrap();
            assert!(r.packets[0].keyframe, "{name} frame {i}: pre-roll keyframe");
            let last = r.packets.last().unwrap();
            assert_eq!(
                last.ts_us,
                ticks_to_us(sorted[i as usize].pts),
                "{name} {i}"
            );
            assert_eq!(r.target_ts_us, last.ts_us);
            // exactly one keyframe at the start, none that was skippable: the latest usable one
            let key_pos = r.packets.iter().rposition(|p| p.keyframe).unwrap();
            assert!(
                key_pos == 0 || r.packets[key_pos].ts_us > r.target_ts_us,
                "{name} {i}: a later keyframe was usable"
            );
        }
        assert_eq!(d.plan_video(n), Err(MediaError::OutOfRange));
        assert_eq!(d.plan_video(-1), Err(MediaError::OutOfRange));
    }
}

#[test]
fn timestamps_are_unique_so_the_host_can_match_the_target() {
    let (_d, p) = decoder("h264_aac.mp4");
    let mut ts: Vec<i64> = p
        .video()
        .unwrap()
        .packets
        .iter()
        .map(|k| ticks_to_us(k.pts))
        .collect();
    ts.sort_unstable();
    ts.dedup();
    assert_eq!(ts.len(), p.video().unwrap().packets.len());
}

#[test]
fn video_frame_goes_through_the_host_and_keeps_index_and_pts() {
    let (mut d, p) = decoder("h264_aac.mp4");
    let f = block_on(d.video_frame(3)).unwrap();
    assert_eq!(f.index, 3);
    let mut pts: Vec<Time> = p.video().unwrap().packets.iter().map(|k| k.pts).collect();
    pts.sort();
    assert_eq!(f.pts, pts[3]);
    let px = f.as_cpu().unwrap();
    assert_eq!(
        i64::from_le_bytes(px.data[..8].try_into().unwrap()),
        ticks_to_us(pts[3])
    );
}

#[test]
fn gpu_frames_close_when_dropped_and_the_kind_is_gated() {
    let (mut d, _) = decoder("h264_aac.mp4");
    d.set_frame_kind(FrameKind::Gpu).unwrap();
    let live = d.host().live.clone();
    let f = block_on(d.video_frame(1)).unwrap();
    assert_eq!(live.get(), 1);
    let g = f.clone();
    drop(f);
    assert_eq!(live.get(), 1, "a clone keeps it open");
    drop(g);
    assert_eq!(live.get(), 0, "last drop closes");
}

#[test]
fn host_errors_reach_the_caller_unchanged() {
    let (mut d, _) = decoder("h264_aac.mp4");
    for e in [
        MediaError::Unsupported("codec hvc1.1.6.L93.B0 (HEVC)".into()),
        MediaError::Cancelled,
        MediaError::Io("boom".into()),
    ] {
        d.host_mut().fail = Some(e.clone());
        assert_eq!(block_on(d.video_frame(0)).unwrap_err(), e);
    }
}

#[test]
fn audio_plan_covers_the_range_with_preroll_and_converts_to_i16() {
    let (mut d, p) = decoder("h264_aac.mp4");
    let total = d.info().audio.as_ref().unwrap().sample_count;
    assert!(total > 48_000 / 2);
    let r = d.plan_audio(24_000, 4_800).unwrap();
    let a = p.audio().unwrap();
    let from = Time::from_sample_index(24_000, 48_000).unwrap();
    let to = Time::from_sample_index(28_800, 48_000).unwrap();
    let covered_start = ticks_to_us(a.packets[0].pts); // sanity: first packet exists
    assert!(covered_start <= r.first_ts_us);
    assert!(r.first_ts_us <= ticks_to_us(from));
    let last = r.packets.last().unwrap();
    assert!(last.ts_us < ticks_to_us(to));
    assert!(last.ts_us + last.dur_us >= ticks_to_us(to) - 1);
    assert!(r.preroll_packets <= 4);
    let c = block_on(d.audio(24_000, 4_800)).unwrap();
    assert_eq!(c.start_sample, 24_000);
    assert_eq!(c.samples.len(), 4_800 * c.channels as usize);
    assert_eq!(c.samples[50], (0.5f32 * 32767.0).round() as i16);
    assert_eq!(d.plan_audio(total, 1), Err(MediaError::OutOfRange));
    assert_eq!(d.plan_audio(-1, 1), Err(MediaError::OutOfRange));
}

#[test]
fn audio_asked_past_the_end_of_the_track_is_silence_not_out_of_range() {
    // Regression: phone clips whose audio track is shorter than the video made the export fail with "out of range".
    struct Ones(usize);
    impl PacketDecoder for Ones {
        fn frame_kinds(&self) -> FrameKinds {
            FrameKinds::CPU
        }
        async fn decode_video(
            &mut self,
            _: &VideoRequest,
            _: FrameKind,
        ) -> Result<VideoOut, MediaError> {
            Err(MediaError::OutOfRange)
        }
        async fn decode_audio(&mut self, r: &AudioRequest) -> Result<Vec<f32>, MediaError> {
            Ok(vec![1.0; r.count * self.0])
        }
    }
    let p = probe_fixture("h264_aac.mp4");
    let ch = p.audio().unwrap().channels as usize;
    let mut d = HostDecoder::new(Ones(ch), None, p.audio().cloned(), 48_000).unwrap();
    let total = d.info().audio.as_ref().unwrap().sample_count;
    let pcm = block_on(d.audio_f32(total - 100, 300)).unwrap();
    assert_eq!(pcm.len(), 300 * ch);
    assert!(pcm[..100 * ch].iter().all(|&v| v == 1.0));
    assert!(pcm[100 * ch..].iter().all(|&v| v == 0.0));
    let pcm = block_on(d.audio_f32(total, 64)).unwrap();
    assert!(pcm.len() == 64 * ch && pcm.iter().all(|&v| v == 0.0));
    assert!(block_on(d.audio_f32(total + 10_000_000, 64)).is_ok());
    assert_eq!(block_on(d.audio_f32(-1, 1)), Err(MediaError::OutOfRange));
}

#[test]
fn a_host_returning_the_wrong_amount_of_audio_is_an_error() {
    struct Short;
    impl PacketDecoder for Short {
        fn frame_kinds(&self) -> FrameKinds {
            FrameKinds::CPU
        }
        async fn decode_video(
            &mut self,
            _: &VideoRequest,
            _: FrameKind,
        ) -> Result<VideoOut, MediaError> {
            Err(MediaError::OutOfRange)
        }
        async fn decode_audio(&mut self, _: &AudioRequest) -> Result<Vec<f32>, MediaError> {
            Ok(vec![0.0; 3])
        }
    }
    let p = probe_fixture("h264_aac.mp4");
    let mut d = HostDecoder::new(Short, None, p.audio().cloned(), 48_000).unwrap();
    assert!(matches!(block_on(d.audio(0, 100)), Err(MediaError::Io(_))));
    assert!(d.set_frame_kind(FrameKind::Gpu).is_err());
    assert_eq!(
        block_on(d.video_frame(0)).unwrap_err(),
        MediaError::OutOfRange
    );
}

#[test]
fn opus_audio_gets_at_least_600_ms_of_preroll_so_the_decoder_has_converged() {
    let (d, p) = decoder("vp9_opus.webm");
    let a = p.audio().unwrap();
    assert!(a.codec.starts_with("opus"));
    let total = d.info().audio.as_ref().unwrap().sample_count;
    // Ask for a block 0.8 s in (or as late as the file allows): the plan must start at least 0.6 s before it, S4 found 4 packets (80 ms) too few.
    let start = 38_400.min(total - 4_800);
    let r = d.plan_audio(start, 4_800).unwrap();
    let wanted_us = ticks_to_us(Time::from_sample_index(start, 48_000).unwrap());
    assert!(r.preroll_packets > 4, "preroll {}", r.preroll_packets);
    assert!(
        wanted_us - r.first_ts_us >= 600_000 || r.from_start,
        "pre-roll covers only {} us",
        wanted_us - r.first_ts_us
    );
    // Near the start there is simply less to prime with: the plan begins at the first packet.
    let r0 = d.plan_audio(0, 960).unwrap();
    assert!(r0.from_start);
}
