# Media I/O: decoder traits and frame cache (M1-011)

Crate: `crates/media` (`app-media`). Policy per platform: ADR 0004.

## Behaviour
- `Source`: random-access bytes (`len`, `read_at`). `Decoder`: `info()`, `video_frame(index)`, `audio(start_sample, count)`.
  Methods are std `async fn`s (no runtime dependency, WASM-safe); futures are intentionally not `Send` because web hosts wrap JS promises.
- Frames and samples are addressed by integer index; convert from `Time` with `frame_index` / `sample_index` (ADR 0010). Frames are RGBA8 in a shared `Arc<[u8]>`; audio is interleaved i16.
- Hosts implement the traits: WebCodecs (web), libav/OS codecs (desktop), WebView or MediaCodec/VideoToolbox plugins (mobile). The engine tests with `FakeDecoder` (numbered frames, integer-only triangle tone, bit-identical on every platform).
- `FrameCache`: one per source, LRU, hard byte budget. `get_or_decode(decoder, index, lookahead)` returns a hit or decodes, then prefetches up to `lookahead` frames, clamped to what fits in the budget and to the end of the stream; the requested frame is never evicted by its own prefetch.

## Edge cases
- A frame larger than the whole budget is returned but not stored. `set_budget` evicts immediately (memory-pressure hook).
- Out-of-range index -> `MediaError::OutOfRange`; missing codec -> `Unsupported` (UI states it plainly).
- Budget choice (default per device class) is a host decision, not made here; proxies/thumbnails/demux are M1-012/013.

## Tests (`crates/media/tests/cache.rs`)
Determinism, hit skips decode, look-ahead and its clamps, LRU order, oversize frame, **budget never exceeded across 5000 random accesses (incl. shrinking the budget mid-run)**, hit-path timing.

## Results
Cache hit path (debug build, includes LRU touch): ~1.2 us/op; test asserts < 20 us to stay stable on slow CI. Release is far lower.
