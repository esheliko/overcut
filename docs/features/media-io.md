# Media I/O: decoder traits, frame cache (M1-011), MP4/MOV + WebM demux (M1-012)

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
- Budget choice (default per device class) is a host decision, not made here; proxies/thumbnails are M1-013.

## Tests (`crates/media/tests/cache.rs`)
Determinism, hit skips decode, look-ahead and its clamps, LRU order, oversize frame, **budget never exceeded across 5000 random accesses (incl. shrinking the budget mid-run)**, hit-path timing.

## Results
Cache hit path (debug build, includes LRU touch): ~1.2 us/op; test asserts < 20 us to stay stable on slow CI. Release is far lower.

## Demux and probe (M1-012)
`app_media::probe(&impl Source) -> Probe` (`crates/media/src/demux/`). Detects the container by magic bytes, reads the index (MP4 `moov`) or walks cluster headers
(WebM; payloads are never read, only each block's 4-byte header) and returns, per track: WebCodecs codec string, `codec_description` bytes
(avcC / hvcC / AudioSpecificConfig / OpusHead), coded size, `rotation` (0/90/180/270 clockwise, from the `tkhd` matrix), sample rate / channels, container
timescale, duration, `nominal_fps`, `vfr`, and the **packet table** (`pts`, `dts`, `duration`, `offset`, `size`, `keyframe`) in decode order.
`Probe::media_info()` gives the `MediaInfo` summary the `Decoder` trait uses. `MemSource` wraps a byte slice (tests, fuzzing, small files).
- **Hand-rolled, no dependencies.** `mp4`/`re_mp4`/`matroska-demuxer` read through blocking `Read + Seek`; our `Source` is async (browser Blobs, network ranges), so adapting them
  means buffering whole files. A read-only parser for just the index is ~1600 lines with comments, adds no licence or wasm-size surface, and is simple to bound. Revisit if we need fragmented MP4 or lacing.
- **Time (ADR 0010).** Every timestamp is `Time` ticks: `value * 705_600_000 / timescale` in 128-bit, rounded to nearest, computed from the *absolute* dts (no accumulated drift).
  30 fps in a 15360 timescale gives exactly `23_520_000` ticks per frame; WebM's millisecond timestamps stay whole milliseconds (33, 33, 34 ms) because that is what the file says.
  The first `elst` edit is applied (leading empty edit delays, first real `media_time` is subtracted), so B-frame files start at pts 0 with negative dts, like ffprobe.
- **VFR.** Video `vfr = true` when any frame step differs from the most common step by more than max(1 timescale unit, 1%) (final sample excluded; MP4 from `stts`, WebM from sorted pts).
  Then `nominal_fps` is `None`; otherwise it is the exact rational (MP4: timescale / step; WebM: `DefaultDuration`, else average), snapped to a standard rate within 0.1%.
- **Codec strings.** `avc1.PPCCLL`, `hvc1.<space><profile>.<compat>.<tier><level>.<constraints>`, `vp09.PP.LL.DD`, `av01.P.LLT.DD`, `vp8`, `mp4a.40.<aot>`, `mp3`, `opus`, `vorbis`, `flac`; unknown codecs
  return their lowercase fourcc / Matroska id and the host decides (`Unsupported`).
- **Not supported (plain errors):** fragmented MP4 (`mvex`/`moof`), QuickTime sound entry v2, Matroska lacing, encrypted tracks, tracks other than video and audio (ignored). Matroska rotation (Projection) is not read: `rotation` is 0 for WebM.
- **Hostile input.** Never panics; returns `MediaError::Invalid` (malformed/truncated) or `Unsupported`. Counts are checked against bytes present, packets per track are capped (`MAX_PACKETS_PER_TRACK` = 2 M), `moov`
  at 256 MiB, tracks at 64, a sample outside the file is an error. A file cut anywhere before its index or inside its media data is an error, not a partial result.
- **WASM-safe.** `std` only, no threads/fs/time; `cargo build -p app-media --target wasm32-unknown-unknown` is clean. A host `Source` may return short reads.

### Tests (`crates/media/tests/demux.rs`)
Fixtures in `tests/fixtures/` (~70 KB total, regenerate with `make.sh`; needs ffmpeg with libx264, libvpx-vp9, libopus): H.264+AAC MP4 and MOV, display-rotated MP4, VFR MP4, VP9+Opus WebM.
Expected values were cross-checked against `ffprobe` (packet pts/dts, offsets, sizes, keyframes, rotation). Tests: exact tick timestamps, keyframes, codec strings and descriptions, MOV `wave/esds`, rotation, VFR positive and negative,
7-byte-at-a-time source, **every truncation of every fixture**, 7500 random byte corruptions (xorshift, deterministic), forged 4-billion-sample tables, `moof` and unknown formats.
### Fuzzing
`crates/media/fuzz` (cargo-fuzz layout, own workspace, not built or run in CI): `cd crates/media && cargo +nightly fuzz run demux` (seed the corpus with the fixtures, see the target's header).
