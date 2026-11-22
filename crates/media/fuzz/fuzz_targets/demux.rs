#![no_main]
//! `cargo +nightly fuzz run demux` (from crates/media). Any input must return Ok or Err, never panic, hang or over-allocate.
//! Seed the corpus with the fixtures: `mkdir -p fuzz/corpus/demux && cp tests/fixtures/*.{mp4,mov,webm} fuzz/corpus/demux/`.
use app_media::{probe, MemSource};
use libfuzzer_sys::fuzz_target;
use std::future::Future;
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

fuzz_target!(|data: &[u8]| {
    let _ = block_on(probe(&MemSource(data)));
});
