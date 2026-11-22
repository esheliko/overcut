use app_media::*;
use app_model::Rational;
use std::future::Future;
use std::pin::pin;
use std::task::{Context, Poll, Waker};

fn block_on<F: Future>(f: F) -> F::Output {
    let mut f = pin!(f);
    let mut cx = Context::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(v) = f.as_mut().poll(&mut cx) {
            return v;
        }
    }
}

fn dec(frames: i64) -> FakeDecoder {
    FakeDecoder::new(16, 16, Rational::FPS_30, frames, 48_000)
}
const FRAME: usize = 16 * 16 * 4;

#[test]
fn fake_decoder_is_deterministic() {
    let mut a = dec(10);
    let mut b = dec(10);
    let fa = block_on(a.video_frame(7)).unwrap();
    assert_eq!(fa, block_on(b.video_frame(7)).unwrap());
    assert_eq!(FakeDecoder::frame_number(&fa), 7);
    assert_eq!(fa.pts.frame_index(Rational::FPS_30), Some(7));
    assert_eq!(block_on(a.video_frame(10)), Err(MediaError::OutOfRange));
    let x = block_on(a.audio(100, 8)).unwrap();
    assert_eq!(x, block_on(b.audio(100, 8)).unwrap());
    assert_eq!(x.samples[0], FakeDecoder::tone_sample(100));
    assert_eq!(x.samples.len(), 16);
}

#[test]
fn hit_does_not_decode_again() {
    let mut d = dec(100);
    let mut c = FrameCache::new(FRAME * 10);
    block_on(c.get_or_decode(&mut d, 5, 0)).unwrap();
    block_on(c.get_or_decode(&mut d, 5, 0)).unwrap();
    assert_eq!(d.decode_calls, 1);
    assert_eq!(c.stats().hits, 1);
    assert_eq!(c.stats().misses, 1);
}

#[test]
fn lookahead_prefetches_and_stops_at_end() {
    let mut d = dec(10);
    let mut c = FrameCache::new(FRAME * 50);
    block_on(c.get_or_decode(&mut d, 7, 5)).unwrap();
    assert!(c.contains(7) && c.contains(8) && c.contains(9));
    assert_eq!(c.len(), 3);
    assert_eq!(d.decode_calls, 3);
}

#[test]
fn lookahead_is_clamped_to_budget_and_keeps_requested_frame() {
    let mut d = dec(100);
    let mut c = FrameCache::new(FRAME * 3);
    let f = block_on(c.get_or_decode(&mut d, 10, 50)).unwrap();
    assert_eq!(f.index, 10);
    assert!(c.contains(10));
    assert!(c.bytes() <= c.budget());
}

#[test]
fn lru_evicts_oldest() {
    let mut d = dec(100);
    let mut c = FrameCache::new(FRAME * 2);
    for i in [1, 2] {
        block_on(c.get_or_decode(&mut d, i, 0)).unwrap();
    }
    c.get(1); // 2 is now least recently used
    block_on(c.get_or_decode(&mut d, 3, 0)).unwrap();
    assert!(c.contains(1) && c.contains(3) && !c.contains(2));
}

#[test]
fn oversized_frame_is_not_stored() {
    let mut d = dec(5);
    let mut c = FrameCache::new(FRAME - 1);
    let f = block_on(c.get_or_decode(&mut d, 1, 3)).unwrap();
    assert_eq!(f.index, 1);
    assert!(c.is_empty());
}

#[test]
fn budget_never_exceeded_under_random_access() {
    let mut d = dec(500);
    let budget = FRAME * 12 + 100;
    let mut c = FrameCache::new(budget);
    let mut s: u64 = 0x9E37_79B9_7F4A_7C15;
    for step in 0..5000 {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        let idx = (s % 500) as i64;
        let look = (s >> 40) as usize % 20;
        let f = block_on(c.get_or_decode(&mut d, idx, look)).unwrap();
        assert_eq!(FakeDecoder::frame_number(&f), idx);
        assert!(c.bytes() <= budget, "step {step}: {} > {budget}", c.bytes());
        if step == 2500 {
            c.set_budget(FRAME * 4);
            assert!(c.bytes() <= FRAME * 4);
        }
    }
    assert!(c.stats().evictions > 0);
}

#[test]
fn hit_path_is_fast() {
    let mut d = dec(100);
    let mut c = FrameCache::new(FRAME * 64);
    block_on(c.get_or_decode(&mut d, 0, 63)).unwrap();
    let n = 200_000u32;
    let t = std::time::Instant::now();
    for i in 0..n {
        assert!(c.get(i64::from(i % 64)).is_some());
    }
    let per = t.elapsed().as_nanos() / u128::from(n);
    println!("cache hit: {per} ns/op");
    assert!(per < 20_000, "hit path too slow: {per} ns");
}

#[test]
fn decoder_advertises_and_switches_frame_kinds() {
    let mut d = dec(4);
    assert_eq!(d.frame_kinds(), FrameKinds::BOTH);
    let cpu = block_on(d.video_frame(1)).unwrap();
    assert_eq!(cpu.kind(), FrameKind::Cpu);
    assert!(cpu.as_cpu().is_some() && cpu.as_gpu().is_none());
    d.set_frame_kind(FrameKind::Gpu).unwrap();
    let gpu = block_on(d.video_frame(1)).unwrap();
    assert_eq!(gpu.kind(), FrameKind::Gpu);
    assert_eq!(FakeDecoder::frame_number(&gpu), 1);
    assert_eq!(
        gpu.byte_size(),
        FRAME,
        "charged at the estimated GPU footprint"
    );
    assert_eq!(gpu, gpu.clone(), "clones share one resource");

    // A CPU-only decoder (the trait default) refuses GPU frames plainly.
    struct CpuOnly(FakeDecoder);
    impl Decoder for CpuOnly {
        fn info(&self) -> &MediaInfo {
            self.0.info()
        }
        async fn video_frame(&mut self, i: i64) -> Result<VideoFrame, MediaError> {
            self.0.video_frame(i).await
        }
        async fn audio(&mut self, s: i64, n: usize) -> Result<AudioChunk, MediaError> {
            self.0.audio(s, n).await
        }
    }
    let mut c = CpuOnly(dec(2));
    assert_eq!(c.frame_kinds(), FrameKinds::CPU);
    assert!(c.set_frame_kind(FrameKind::Cpu).is_ok());
    assert!(matches!(
        c.set_frame_kind(FrameKind::Gpu),
        Err(MediaError::Unsupported(_))
    ));
}

#[test]
fn gpu_frames_are_budgeted_and_closed_on_eviction() {
    let mut d = dec(100);
    d.set_frame_kind(FrameKind::Gpu).unwrap();
    let mut c = FrameCache::new(FRAME * 3);
    for i in 0..6 {
        block_on(c.get_or_decode(&mut d, i, 0)).unwrap();
        assert!(c.bytes() <= c.budget());
    }
    assert_eq!(c.len(), 3);
    assert_eq!(d.live_gpu_frames(), 3, "evicted GPU frames were released");
    c.set_budget(FRAME);
    assert_eq!(d.live_gpu_frames(), 1);
    c.clear();
    assert_eq!(d.live_gpu_frames(), 0, "clear releases everything");

    // Mixed variants share one byte budget.
    let mut d = dec(10);
    let mut c = FrameCache::new(FRAME * 2);
    block_on(c.get_or_decode(&mut d, 0, 0)).unwrap();
    d.set_frame_kind(FrameKind::Gpu).unwrap();
    block_on(c.get_or_decode(&mut d, 1, 0)).unwrap();
    block_on(c.get_or_decode(&mut d, 2, 0)).unwrap();
    assert_eq!((c.len(), c.bytes()), (2, FRAME * 2));
    assert!(!c.contains(0));
}
