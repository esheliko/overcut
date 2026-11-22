# Media I/O: decoder traits, frame cache (M1-011), MP4/MOV + WebM demux (M1-012)

Crate: `crates/media` (`app-media`). Policy per platform: ADR 0004.

## Behaviour
- `Source`: random-access bytes (`len`, `read_at`). `Decoder`: `info()`, `video_frame(index)`, `audio(start_sample, count)`.
  Methods are std `async fn`s (no runtime dependency, WASM-safe); futures are intentionally not `Send` because web hosts wrap JS promises.
- Frames and samples are addressed by integer index; convert from `Time` with `frame_index` / `sample_index` (ADR 0010). A `VideoFrame` carries `data: FrameData::{Cpu(RgbaFrame), Gpu(GpuFrameHandle)}` (see Frame variants); audio is interleaved i16.
- Hosts implement the traits: WebCodecs (web), libav/OS codecs (desktop), WebView or MediaCodec/VideoToolbox plugins (mobile). The engine tests with `FakeDecoder` (numbered frames, integer-only triangle tone, bit-identical on every platform).
- `FrameCache`: one per source, LRU, hard byte budget. `get_or_decode(decoder, index, lookahead)` returns a hit or decodes, then prefetches up to `lookahead` frames, clamped to what fits in the budget and to the end of the stream; the requested frame is never evicted by its own prefetch.

## Frame variants (S1 recommendation, ADR 0004)
- `FrameData::Cpu(RgbaFrame)`: RGBA8 in a shared `Arc<[u8]>` (software decoders, tests, export readback).
  `FrameData::Gpu(GpuFrameHandle)`: opaque, shared, **close-on-drop** reference to a frame in GPU or decoder memory: a JS `VideoFrame` on the web, a platform texture / hardware buffer natively.
  The host implements `GpuResource` (a one-method `Any` trait) and releases the resource in its `Drop` (`VideoFrame.close()` on the web), so an evicted or dropped frame frees GPU memory at once. The renderer imports it by `downcast_ref::<HostType>()`; the engine never looks inside. Handles are `Rc`-based, deliberately not `Send`.
- A decoder advertises `frame_kinds()` (`FrameKinds::{CPU, GPU, BOTH}`; default CPU only) and the caller picks one with `set_frame_kind(kind)` (`Unsupported` if not offered). Hosts that cannot do GPU frames need change nothing.
- `FrameCache` charges `VideoFrame::byte_size()`: pixel bytes for CPU, the handle's `est_bytes` for GPU (`GpuFrameHandle::estimate_bytes(w, h)` = 4 B/pixel, conservative; a host that knows better passes its own). One budget covers both variants; eviction, `set_budget` and `clear` drop the frame, which closes the GPU resource.
- `FakeDecoder` offers both (`set_frame_kind`), and `live_gpu_frames()` counts fake GPU frames not yet closed so tests can assert release.

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
  means buffering whole files. A read-only parser for just the index is ~1600 lines with comments, adds no licence or wasm-size surface, and is simple to bound. Revisit if lacing turns out to matter.
- **Time (ADR 0010).** Every timestamp is `Time` ticks: `value * 705_600_000 / timescale` in 128-bit, rounded to nearest, computed from the *absolute* dts (no accumulated drift).
  30 fps in a 15360 timescale gives exactly `23_520_000` ticks per frame; WebM's millisecond timestamps stay whole milliseconds (33, 33, 34 ms) because that is what the file says.
  The first `elst` edit is applied (leading empty edit delays, first real `media_time` is subtracted), so B-frame files start at pts 0 with negative dts, like ffprobe.
- **VFR.** Video `vfr = true` when any frame step differs from the most common step by more than max(1 timescale unit, 1%) (final sample excluded; MP4 from `stts`, WebM from sorted pts).
  Then `nominal_fps` is `None`; otherwise it is the exact rational (MP4: timescale / step; WebM: `DefaultDuration`, else average), snapped to a standard rate within 0.1%.
- **Codec strings.** `avc1.PPCCLL`, `hvc1.<space><profile>.<compat>.<tier><level>.<constraints>`, `vp09.PP.LL.DD`, `av01.P.LLT.DD`, `vp8`, `mp4a.40.<aot>`, `mp3`, `opus`, `vorbis`, `flac`; unknown codecs
  return their lowercase fourcc / Matroska id and the host decides (`Unsupported`).
- **Fragmented MP4** (phones, screen recorders, browser `MediaRecorder`, `frag_keyframe+empty_moov`): when `moov` has `mvex`, or a `moof` appears, the probe walks the top-level boxes and reads each `moof` (header bytes only, never `mdat`, 256 MiB cap in total).
  Per `traf`: `tfhd` (base offset, default duration/size/flags), `tfdt` (base decode time; without it the previous fragment's end), `trun` (data offset, first-sample flags, per-sample duration/size/flags/composition offset v0 and v1); defaults fall back to `trex`.
  A sample is a keyframe unless its flags have the non-sync bit. Sample offsets are relative to the `tfhd` base-data-offset, else the start of the `moof` (every real muxer writes `default-base-is-moof`; the legacy "end of the previous traf" rule is not implemented).
  `sidx`/`mfra` are ignored (the probe reads every `moof` anyway). VFR, nominal fps and duration are computed from the fragment samples (a fragmented file has no `mvhd`/`mdhd` duration). A fragmented muxer writes no negative composition offsets, so a B-frame file starts at pts = the reorder delay, not 0.
  **Cut short:** unlike a plain MP4 (no `moov` = error), a fragmented file whose tail is missing keeps every complete fragment before the cut (a crashed recording is still importable); a `moof` or sample reaching past the end of the file ends the walk.
- **Matroska lacing (Xiph, EBML, fixed-size) is not supported** and stays a plain `Unsupported`: block timecodes are whole container units (ms), a laced block needs sub-unit timestamps from `DefaultDuration`, and it is
  essentially never used for video or for Opus/Vorbis in files from current muxers. Revisit if a real file needs it (follow-up issue).
- **Not supported (plain errors):** QuickTime sound entry v2, Matroska lacing, encrypted tracks, tracks other than video and audio (ignored). Matroska rotation (Projection) is not read: `rotation` is 0 for WebM.
- **Hostile input.** Never panics; returns `MediaError::Invalid` (malformed/truncated) or `Unsupported`. Counts are checked against bytes present, packets per track are capped (`MAX_PACKETS_PER_TRACK` = 2 M), `moov`
  at 256 MiB, tracks at 64, a sample outside the file is an error. A file cut anywhere before its index or inside its media data is an error, not a partial result.
- **WASM-safe.** `std` only, no threads/fs/time; `cargo build -p app-media --target wasm32-unknown-unknown` is clean. A host `Source` may return short reads.

### Tests (`crates/media/tests/demux.rs`)
Fixtures in `tests/fixtures/` (~70 KB total, regenerate with `make.sh`; needs ffmpeg with libx264, libvpx-vp9, libopus): H.264+AAC MP4 and MOV, display-rotated MP4, VFR MP4, VP9+Opus WebM.
Expected values were cross-checked against `ffprobe` (packet pts/dts, offsets, sizes, keyframes, rotation). Tests: exact tick timestamps, keyframes, codec strings and descriptions, MOV `wave/esds`, rotation, VFR positive and negative,
7-byte-at-a-time source, **every truncation of every fixture**, 7500 random byte corruptions (xorshift, deterministic), forged 4-billion-sample tables, unknown formats.
Fragmented MP4 (`frag.mp4`, `frag_legacy.mp4`, ffmpeg `frag_keyframe+empty_moov`, with and without `default_base_moof`): same sizes, keyframes, steady durations and sample bytes as the plain file, every truncation never panics and never loses frames as more data arrives, a 70% cut keeps the complete fragments, 3000 random corruptions, a forged 4-billion-sample `trun`.
### Fuzzing
`crates/media/fuzz` (cargo-fuzz layout, own workspace, not built or run in CI): `cd crates/media && cargo +nightly fuzz run demux` (seed the corpus with the fixtures, see the target's header).
