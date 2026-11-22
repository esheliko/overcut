# Feature: timeline evaluation (`app-timeline::evaluate`, M1-004)

## Behaviour
`evaluate_into(&Sequence, t, audio_samples, &mut FrameDescription)` answers "what is visible and audible here" for the renderer and the audio mixer. Pure; never fails (odd input gives an empty description); `evaluate(...)` is the allocating convenience wrapper. Muted tracks are skipped.
- **Video**: one `VideoLayer` per video track that has a clip at the frame, **bottom to top** (track order). Fields: `track`, `clip`, `media`, `source_time` (ticks), `transform` (`center` = output centre, `scale` 1, `rotation` 0, ready for `app_render::Layer`) and `opacity` 1. Effects, transforms and opacity keyframes are not in the model yet (M2); the defaults are the contract until then. No layers = black.
- **Audio**: `AudioSegment`s for the window `[t, t + audio_samples)` at the sequence sample rate: `out_start` and `len` (samples, relative to the window), `source_start` (ticks of the first sample), `speed`, `gain` 1. Samples no segment covers are silence. `audio_samples = 0` skips audio (a paused frame).

## Rules (ADR 0010)
- **Frame quantisation**: video is sampled at the *start of the sequence frame containing `t`* (`frame = floor`, `video_time = from_frame_index(frame)`). Every `t` inside a frame gives the same layers, and scrubbing/playback/export agree.
- **Coverage**: a clip covers time `x` when `start <= x < start + duration` (**out point exclusive**); touching clips hand over on exactly the boundary tick, never overlap or gap. For audio, sample `j` sits at `from_sample_index(j)` and the same test applies, so a clip's first sample is `ceil(start)` and its end is `ceil(end)`; consecutive windows tile with no sample counted twice or lost.
- **Mid-frame start**: a clip starting inside a frame appears on the *next* frame (the frame's start is before the clip). A mid-sample start begins on the next sample.
- **Source time** = `source_in + floor((x - start) * speed)`, `i128` maths, floor (never float). The media's own frame is then `source_time.frame_index(media_fps)` (floor) and the decoder's job: 29.97 media in a 30 fps sequence repeats one media frame about every 1001 sequence frames; 24 in 60 repeats each frame 2 or 3 times (pattern 2,3,2,3...) and never skips; 60 media in a 24 fps sequence skips frames. Tests pin these.
- A window may start at any tick: the first sample is `floor(t)` (`FrameDescription::sample`).

## Cost
Binary search per track (clips are sorted and non-overlapping), no allocation once the reused `FrameDescription` has grown (test: pointer and capacity of its vectors stay put across 2000 calls; the workspace forbids `unsafe`, so no counting allocator). Release build, 1 video + 1 audio track of 5000 clips each, 1024-sample window: **~0.9 us per call**; 20 tracks x 250 clips: **~3.6 us** (debug build ~2.5 / ~8 us). Budget in the test: 100 / 200 us in debug. `cargo test -p app-timeline --release evaluate::tests::perf -- --nocapture`.

## Engine surface
`Editor::evaluate_json(sequence_id, ticks, audio_samples)` (reuses a scratch description, returns JSON) -> `crates/wasm` `Editor.evaluate` (ticks as i64 = BigInt), Tauri `editor_evaluate`, `Engine.editing.evaluate(sequenceId, ticks, audioSamples?)` returning `FrameDescription` (`packages/engine-client/src/types.ts`). Additive: `ABI_VERSION` unchanged. Tick counts must be safe integers on the TS side (~145 days).

## Edge cases and tests (`crates/timeline/src/evaluate.rs`)
Gaps, negative time, empty sequence, out-point exclusivity and exact handover (video and audio sample split), end of sequence, mid-frame and mid-sample starts, 29.97-in-30 and 24-in-60 mappings, speed scaling and flooring, muted tracks, window edges, window tiling over odd cut points, buffer reuse equals fresh result, perf at 5k clips. TS: `tests/unit/editing.test.ts` (bigint ticks, validation).

## Not here yet
Transitions (overlap blending), nested sequences, effect stacks and keyframe evaluation, per-clip gain/opacity (all M2+). The seams are `VideoLayer`/`AudioSegment` fields.
