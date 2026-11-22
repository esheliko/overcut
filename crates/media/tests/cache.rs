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
