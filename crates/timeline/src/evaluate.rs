//! `evaluate`: what is visible and audible at a time (M1-004, `docs/features/evaluate.md`). Pure; the only state is the caller's reusable output.
//!
//! Rules (ADR 0010): video is sampled at the *start of the sequence frame containing `t`*; a clip covers a time when
//! `start <= time < end` (out point exclusive); audio sample `j` is at `from_sample_index(j)` and a clip covers it by the same test.
//! Source time = `source_in + floor((time - start) * speed)`, exact integer maths in `i128`. Media frame/sample
//! selection from a source time is the decoder's (`Time::frame_index(media_fps)` = floor).

use app_model::{
    ClipId, MediaId, Rational, Sequence, Time, TrackId, TrackKind, TransformValues,
    TICKS_PER_SECOND,
};
use serde::Serialize;

/// 2D placement in output pixels, directly usable as `app_render::Layer`'s `center`/`scale`/`rotation`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Transform {
    pub center: [f32; 2],
    pub scale: [f32; 2],
    pub rotation: f32,
}

/// One video layer; `FrameDescription::layers` is bottom-to-top.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct VideoLayer {
    pub track: TrackId,
    pub clip: ClipId,
    pub media: MediaId,
    /// Where in the media to read, in ticks (floor to the media's own frame grid).
    pub source_time: Time,
    pub transform: Transform,
    /// The clip's own placement evaluated at this frame (M2-003): position, scale, rotation, anchor, crop, flip, fit. The compositor
    /// (M2-024) turns it into a matrix using the media's size; `transform` above is the unmodified canvas-centre placement.
    pub props: TransformValues,
    /// 0..=1 (the clip's opacity at this frame).
    pub opacity: f32,
}

/// A run of one clip inside the audio window.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct AudioSegment {
    pub track: TrackId,
    pub clip: ClipId,
    pub media: MediaId,
    /// First sample of the segment, relative to the window start.
    pub out_start: u32,
    /// Samples in the segment (at the sequence sample rate).
    pub len: u32,
    /// Source time of the segment's first sample, in ticks.
    pub source_start: Time,
    /// Source seconds per timeline second (the mixer resamples by this and the media rate).
    pub speed: Rational,
    pub gain: f32,
    /// The clip's first source tick and the source ticks it reads in all (`duration * speed`): what a pitch-keeping stretcher turns into
    /// the clip's whole timeline length (`docs/features/speed.md`).
    pub clip_source_in: Time,
    pub clip_source_len: Time,
    /// Samples from the clip's first sample to this segment's first sample (0 when the segment starts with the clip).
    pub clip_offset: u32,
}

/// Output of [`evaluate_into`]. Keep one and reuse it: the vectors are cleared, not reallocated.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct FrameDescription {
    /// The requested time.
    pub time: Time,
    /// Index of the sequence frame containing `time` (floor).
    pub frame: i64,
    /// Start of that frame: the time the video was sampled at.
    pub video_time: Time,
    /// First sample of the audio window (floor of `time`).
    pub sample: i64,
    /// Window length in samples.
    pub audio_samples: u32,
    /// Bottom to top. Empty = black.
    pub layers: Vec<VideoLayer>,
    /// Track order, then time. Samples not covered by any segment are silence.
    pub audio: Vec<AudioSegment>,
}

/// `source_in + floor(delta * speed)`; `None` on overflow.
fn source_at(source_in: Time, delta: i64, speed: Rational) -> Option<Time> {
    let n = i128::from(delta) * i128::from(speed.num);
    let d = i128::from(speed.den.max(1));
    let off = i64::try_from(n.div_euclid(d)).ok()?;
    source_in.checked_add(Time::from_ticks(off))
}

fn end_ticks(c: &app_model::Clip) -> i64 {
    c.start.ticks().saturating_add(c.duration.ticks())
}

/// First sample index whose time is `>= t` (ceil), for the exact coverage test.
fn ceil_sample(t: i64, rate: u32) -> i64 {
    let n = i128::from(t) * i128::from(rate);
    let d = i128::from(TICKS_PER_SECOND);
    i64::try_from(-((-n).div_euclid(d))).unwrap_or(i64::MAX)
}

/// Evaluates `seq` at `t` and, when `audio_samples > 0`, the audio window `[t, t + audio_samples)` (in sequence samples).
/// Clears and refills `out`; allocates only if `out` has to grow. Tracks that are muted, hidden, or silenced by another track's solo (same kind) are skipped. Never fails: odd input gives an empty description.
pub fn evaluate_into(seq: &Sequence, t: Time, audio_samples: u32, out: &mut FrameDescription) {
    out.layers.clear();
    out.audio.clear();
    out.time = t;
    out.audio_samples = audio_samples;
    let fps = seq.frame_rate;
    let Some(frame) = t.frame_index(fps) else {
        out.frame = 0;
        out.video_time = t;
        out.sample = 0;
        return;
    };
    let vt = Time::from_frame_index(frame, fps).unwrap_or(t);
    out.frame = frame;
    out.video_time = vt;
    out.sample = t.sample_index(seq.sample_rate).unwrap_or(0);

    let transform = Transform {
        center: [
            seq.resolution.width as f32 / 2.0,
            seq.resolution.height as f32 / 2.0,
        ],
        scale: [1.0, 1.0],
        rotation: 0.0,
    };
    let s0 = out.sample;
    let s1 = s0.saturating_add(i64::from(audio_samples));
    let solo = [
        seq.has_solo(TrackKind::Video),
        seq.has_solo(TrackKind::Audio),
    ];
    for track in seq.tracks.iter().filter(|tr| {
        tr.is_live(match tr.kind {
            TrackKind::Video => solo[0],
            TrackKind::Audio => solo[1],
        })
    }) {
        match track.kind {
            TrackKind::Video => {
                // Clips are sorted and non-overlapping: the only candidate is the last one starting at or before `vt`.
                let i = track.clips.partition_point(|c| c.start <= vt);
                let Some(c) = i.checked_sub(1).map(|i| &track.clips[i]) else {
                    continue;
                };
                if vt.ticks() >= end_ticks(c) {
                    continue;
                }
                if let Some(source_time) =
                    source_at(c.source_in, vt.ticks() - c.start.ticks(), c.speed)
                {
                    let props = c
                        .transform
                        .at(Time::from_ticks(vt.ticks() - c.start.ticks()));
                    out.layers.push(VideoLayer {
                        track: track.id,
                        clip: c.id,
                        media: c.media,
                        source_time,
                        transform,
                        props,
                        opacity: props.opacity,
                    });
                }
            }
            TrackKind::Audio if audio_samples > 0 => {
                let rate = seq.sample_rate;
                // First clip that can still cover sample `s0`: its end sample is beyond `s0`.
                let first = track
                    .clips
                    .partition_point(|c| ceil_sample(end_ticks(c), rate) <= s0);
                for c in &track.clips[first..] {
                    let a = ceil_sample(c.start.ticks(), rate).max(s0);
                    if a >= s1 {
                        break;
                    }
                    let b = ceil_sample(end_ticks(c), rate).min(s1);
                    if a >= b {
                        continue;
                    }
                    let at = Time::from_sample_index(a, rate).unwrap_or(c.start);
                    let delta = (at.ticks() - c.start.ticks()).max(0);
                    let Some(source_start) = source_at(c.source_in, delta, c.speed) else {
                        continue;
                    };
                    out.audio.push(AudioSegment {
                        track: track.id,
                        clip: c.id,
                        media: c.media,
                        out_start: (a - s0) as u32,
                        len: (b - a) as u32,
                        source_start,
                        speed: c.speed,
                        gain: 1.0,
                        clip_source_in: c.source_in,
                        clip_source_len: Time::from_ticks(
                            (i128::from(c.duration.ticks()) * i128::from(c.speed.num)
                                / i128::from(c.speed.den.max(1)))
                                as i64,
                        ),
                        clip_offset: (a - ceil_sample(c.start.ticks(), rate)).max(0) as u32,
                    });
                }
            }
            TrackKind::Audio => {}
        }
    }
}

/// Convenience wrapper that allocates a fresh description (tests, one-off calls). Hot paths use [`evaluate_into`].
pub fn evaluate(seq: &Sequence, t: Time, audio_samples: u32) -> FrameDescription {
    let mut out = FrameDescription::default();
    evaluate_into(seq, t, audio_samples, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use app_model::{Clip, Id, MediaKind, MediaRef, Project, Resolution, SeqIds};

    const SEC: i64 = TICKS_PER_SECOND;

    fn clip(n: u128, start: i64, source_in: i64, dur: i64, speed: Rational) -> Clip {
        Clip {
            id: ClipId(Id::from_u128(1000 + n)),
            media: MediaId(Id::from_u128(7)),
            start: Time::from_ticks(start),
            source_in: Time::from_ticks(source_in),
            duration: Time::from_ticks(dur),
            speed,
            link: None,
            transform: Default::default(),
        }
    }

    /// One video track and one audio track, each holding `clips`.
    fn seq(fps: Rational, clips: &[Clip]) -> Sequence {
        let mut p = Project::new(
            &mut SeqIds::default(),
            "t",
            fps,
            Resolution {
                width: 1920,
                height: 1080,
            },
        );
        p.media.push(MediaRef {
            id: MediaId(Id::from_u128(7)),
            kind: MediaKind::Video,
            name: "m".into(),
            uri: "m".into(),
            hash: None,
            duration: None,
            tags: vec![],
        });
        p.sequences[0].tracks[0].clips = clips.to_vec();
        // Ids are unique per document, so the audio track gets its own ids (video clip n pairs with audio clip n + 100000).
        p.sequences[0].tracks[1].clips = clips
            .iter()
            .map(|c| Clip {
                id: ClipId(Id::from_u128(c.id.0.as_u128() + 100_000)),
                ..c.clone()
            })
            .collect();
        p.validate().unwrap();
        p.sequences.remove(0)
    }

    /// The id the audio track's copy of a clip gets in `seq`.
    fn aid(c: &Clip) -> ClipId {
        ClipId(Id::from_u128(c.id.0.as_u128() + 100_000))
    }

    fn one() -> Rational {
        Rational { num: 1, den: 1 }
    }

    fn fd(fps: i64) -> i64 {
        SEC / fps
    }

    #[test]
    fn gaps_are_black_and_silent_and_defaults_fill_the_render_layer() {
        let s = seq(Rational::FPS_30, &[clip(1, SEC, 5 * SEC, SEC, one())]);
        let before = evaluate(&s, Time::from_ticks(SEC - 1), 1);
        assert!(before.layers.is_empty() && before.audio.is_empty());
        let inside = evaluate(&s, Time::from_ticks(SEC), 0);
        assert_eq!(inside.layers.len(), 1);
        let l = inside.layers[0];
        assert_eq!(l.source_time, Time::from_ticks(5 * SEC));
        assert_eq!(
            (
                l.transform.center,
                l.transform.scale,
                l.transform.rotation,
                l.opacity
            ),
            ([960.0, 540.0], [1.0, 1.0], 0.0, 1.0)
        );
        assert!(evaluate(&s, Time::from_ticks(-5), 10).layers.is_empty());
        assert!(evaluate(
            &Sequence {
                tracks: vec![],
                ..s
            },
            Time::ZERO,
            10
        )
        .layers
        .is_empty());
    }

    #[test]
    fn out_point_is_exclusive_and_touching_clips_hand_over_exactly() {
        let a = clip(1, 0, 0, SEC, one());
        let b = clip(2, SEC, 10 * SEC, SEC, one());
        let s = seq(Rational::FPS_30, &[a.clone(), b.clone()]);
        let last_of_a = evaluate(&s, Time::from_ticks(SEC - fd(30)), 0);
        assert_eq!(last_of_a.layers[0].clip, a.id);
        assert_eq!(
            last_of_a.layers[0].source_time,
            Time::from_ticks(SEC - fd(30))
        );
        let first_of_b = evaluate(&s, Time::from_ticks(SEC), 0);
        assert_eq!(
            (first_of_b.layers[0].clip, first_of_b.layers[0].source_time),
            (b.id, Time::from_ticks(10 * SEC))
        );
        // End of sequence: the end tick itself shows nothing.
        let end = evaluate(&s, Time::from_ticks(2 * SEC), 100);
        assert!(end.layers.is_empty() && end.audio.is_empty());
        let last = evaluate(&s, Time::from_ticks(2 * SEC - 1), 0);
        assert_eq!(last.layers[0].clip, b.id);
        // Audio: a 48000-sample window straddling the cut splits at exactly sample 48000.
        let w = evaluate(&s, Time::from_ticks(SEC - SEC / 100), 960);
        assert_eq!(w.sample, 47_520);
        assert_eq!(w.audio.len(), 2);
        assert_eq!(
            (
                w.audio[0].clip == aid(&a),
                w.audio[0].out_start,
                w.audio[0].len
            ),
            (true, 0, 480)
        );
        assert_eq!(
            (
                w.audio[1].clip == aid(&b),
                w.audio[1].out_start,
                w.audio[1].len
            ),
            (true, 480, 480)
        );
        assert_eq!(w.audio[0].source_start, Time::from_ticks(SEC - SEC / 100));
        assert_eq!(w.audio[1].source_start, Time::from_ticks(10 * SEC));
    }

    #[test]
    fn video_samples_the_frame_start_so_a_mid_frame_clip_appears_on_the_next_frame() {
        // Clip starts 1/3 into frame 3 of a 30 fps sequence.
        let start = 3 * fd(30) + fd(30) / 3;
        let s = seq(Rational::FPS_30, &[clip(1, start, 100, 2 * SEC, one())]);
        let f3 = evaluate(&s, Time::from_ticks(3 * fd(30) + fd(30) - 1), 0);
        assert_eq!((f3.frame, f3.video_time), (3, Time::from_ticks(3 * fd(30))));
        assert!(f3.layers.is_empty());
        let f4 = evaluate(&s, Time::from_ticks(4 * fd(30)), 0);
        assert_eq!(
            f4.layers[0].source_time,
            Time::from_ticks(100 + fd(30) - fd(30) / 3)
        );
        // Any t inside a frame yields the same description of video.
        let a = evaluate(&s, Time::from_ticks(10 * fd(30)), 0);
        let b = evaluate(&s, Time::from_ticks(11 * fd(30) - 1), 0);
        assert_eq!(a.layers, b.layers);
    }

    #[test]
    fn audio_clip_starting_mid_sample_begins_at_the_next_sample() {
        // 48 kHz: one sample = 14700 ticks. Start 1 tick after sample 10.
        let start = 10 * 14_700 + 1;
        let s = seq(Rational::FPS_30, &[clip(1, start, 0, SEC, one())]);
        let w = evaluate(&s, Time::ZERO, 20);
        assert_eq!(w.audio.len(), 1);
        assert_eq!((w.audio[0].out_start, w.audio[0].len), (11, 9));
        assert_eq!(
            w.audio[0].source_start,
            Time::from_ticks(11 * 14_700 - start)
        );
    }

    #[test]
    fn media_at_29_97_inside_a_30_fps_sequence_repeats_a_media_frame_about_every_33_seconds() {
        // Clip plays media 1:1 from source 0. The decoder maps source ticks to the media frame (floor at 29.97).
        let s = seq(Rational::FPS_30, &[clip(1, 0, 0, 60 * SEC, one())]);
        let (mut skipped, mut dup, mut prev) = (0, 0, -1i64);
        for f in 0..1800 {
            let r = evaluate(&s, Time::from_ticks(f * fd(30)), 0);
            let m = r.layers[0]
                .source_time
                .frame_index(Rational::FPS_29_97)
                .unwrap();
            match m - prev {
                0 => dup += 1,
                1 => {}
                2 => skipped += 1,
                d => panic!("jump {d} at {f}"),
            }
            prev = m;
        }
        // 30 vs 29.97: the sequence runs 0.1% faster than the media, so a media frame repeats about every 1001 sequence frames (two in 60 s).
        assert_eq!((dup, skipped), (2, 0)); // 1800 frames * (1 - 1001/1000.. ) = 1.8 repeats
        assert_eq!(prev, 1797); // 59.9667 s * 29.97
    }

    #[test]
    fn media_at_24_in_a_60_fps_sequence_repeats_each_frame_2_or_3_times_and_never_skips() {
        let s = seq(Rational::FPS_60, &[clip(1, 0, 0, 10 * SEC, one())]);
        let mut counts = [0usize; 24];
        let mut prev = -1;
        for f in 0..60 {
            let r = evaluate(&s, Time::from_ticks(f * fd(60)), 0);
            let m = r.layers[0]
                .source_time
                .frame_index(Rational::FPS_24)
                .unwrap();
            assert!(m == prev || m == prev + 1);
            prev = m;
            counts[m as usize] += 1;
        }
        assert!(counts.iter().all(|&c| c == 2 || c == 3), "{counts:?}");
        assert_eq!(counts.iter().sum::<usize>(), 60);
    }

    #[test]
    fn speed_scales_source_time_and_floors() {
        let half = Rational { num: 1, den: 2 };
        let s = seq(
            Rational::FPS_30,
            &[
                clip(1, SEC, 0, 2 * SEC, half),
                clip(2, 4 * SEC, 3, 10, Rational { num: 3, den: 2 }),
            ],
        );
        let r = evaluate(&s, Time::from_ticks(SEC + fd(30) * 6), 0);
        assert_eq!(r.layers[0].source_time, Time::from_ticks(fd(30) * 3));
        // Audio with speed: second sample of the window is 2 * speed ticks... source advance is delta * speed.
        let w = evaluate(&s, Time::from_ticks(SEC), 4);
        assert_eq!(w.audio[0].source_start, Time::ZERO);
        assert_eq!(w.audio[0].speed, half);
        // The stretcher's view of the clip: its whole source window (2 s of timeline at 1/2x reads 1 s of source).
        assert_eq!(w.audio[0].clip_source_in, Time::ZERO);
        assert_eq!(w.audio[0].clip_source_len, Time::from_ticks(SEC));
        assert_eq!(w.audio[0].clip_offset, 0);
        // Floor on a fractional result (3 + floor(7*3/2) = 13).
        let tiny = source_at(Time::from_ticks(3), 7, Rational { num: 3, den: 2 });
        assert_eq!(tiny, Some(Time::from_ticks(13)));
    }

    #[test]
    fn muted_tracks_and_window_edges() {
        let mut s = seq(Rational::FPS_30, &[clip(1, 0, 0, SEC, one())]);
        let w = evaluate(&s, Time::ZERO, 0);
        assert!(w.audio.is_empty(), "no window, no audio");
        assert_eq!(w.layers.len(), 1);
        s.tracks[0].muted = true;
        s.tracks[1].muted = true;
        let m = evaluate(&s, Time::ZERO, 100);
        assert!(m.layers.is_empty() && m.audio.is_empty());
        s.tracks[1].muted = false;
        // A window starting exactly at the clip's end is silent; one ending exactly at its start too.
        assert!(evaluate(&s, Time::from_ticks(SEC), 100).audio.is_empty());
        let s2 = seq(Rational::FPS_30, &[clip(1, SEC, 0, SEC, one())]);
        assert!(evaluate(&s2, Time::from_ticks(SEC - 100 * 14_700), 100)
            .audio
            .is_empty());
        let edge = evaluate(&s2, Time::from_ticks(SEC - 100 * 14_700), 101);
        assert_eq!((edge.audio[0].out_start, edge.audio[0].len), (100, 1));
    }

    #[test]
    fn windows_tile_without_gaps_or_overlaps() {
        // Cuts at odd ticks; walking the timeline in windows of 1024 must cover each sample of each clip exactly once.
        let (a, b) = (
            clip(1, 12_345, 0, 3 * SEC + 7, one()),
            clip(2, 3 * SEC + 12_352 + 99, 0, SEC, one()),
        );
        let s = seq(Rational::FPS_25, &[a, b]);
        let (mut covered, mut w) = (0i64, evaluate(&s, Time::ZERO, 0));
        for k in 0..(5 * 48_000 / 1024) {
            evaluate_into(
                &s,
                Time::from_sample_index(k * 1024, 48_000).unwrap(),
                1024,
                &mut w,
            );
            let mut last_end = 0;
            for seg in &w.audio {
                assert!(seg.out_start >= last_end && seg.out_start + seg.len <= 1024);
                last_end = seg.out_start + seg.len;
                covered += i64::from(seg.len);
            }
        }
        let expect =
            |start: i64, dur: i64| ceil_sample(start + dur, 48_000) - ceil_sample(start, 48_000);
        assert_eq!(
            covered,
            expect(12_345, 3 * SEC + 7) + expect(3 * SEC + 12_352 + 99, SEC)
        );
    }

    #[test]
    fn reusing_the_buffer_gives_the_same_answer_as_a_fresh_one() {
        let s = seq(
            Rational::FPS_30,
            &[clip(1, 0, 0, SEC, one()), clip(2, 2 * SEC, 0, SEC, one())],
        );
        let mut out = FrameDescription::default();
        for t in [0, SEC / 2, SEC + 5, 2 * SEC, 5 * SEC, SEC / 3] {
            evaluate_into(&s, Time::from_ticks(t), 700, &mut out);
            assert_eq!(out, evaluate(&s, Time::from_ticks(t), 700));
        }
    }

    /// M1-004 perf: per-call cost at 5k clips (1 video + 1 audio track of 5000 clips each, and 20 tracks x 250).
    /// Numbers print with `--nocapture`; the bound is loose enough for debug builds.
    #[test]
    fn perf_at_5k_clips() {
        use std::time::Instant;
        let clips: Vec<Clip> = (0..5000)
            .map(|i| clip(i, i as i64 * 2 * fd(30), 0, fd(30) + fd(60), one()))
            .collect();
        let mut s = seq(Rational::FPS_30, &clips);
        let mut out = FrameDescription::default();
        let n = 20_000;
        let t0 = Instant::now();
        for i in 0..n {
            let t = (i * 7919 % 10_000) as i64 * fd(30) + 3;
            evaluate_into(&s, Time::from_ticks(t), 1024, &mut out);
            std::hint::black_box(&out);
        }
        let single = t0.elapsed() / n as u32;
        // 20 tracks of 250 clips: 10 video + 10 audio.
        let proto = s.tracks[0].clone();
        s.tracks.clear();
        for k in 0..20u32 {
            let mut tr = proto.clone();
            tr.kind = if k % 2 == 0 {
                TrackKind::Video
            } else {
                TrackKind::Audio
            };
            tr.clips.truncate(250);
            s.tracks.push(tr);
        }
        let t0 = Instant::now();
        for i in 0..n {
            evaluate_into(
                &s,
                Time::from_ticks((i % 250) as i64 * 2 * fd(30)),
                1024,
                &mut out,
            );
            std::hint::black_box(&out);
        }
        let multi = t0.elapsed() / n as u32;
        eprintln!("M1-004 perf: 5000 clips/track mean {single:?}; 20 tracks x 250 clips mean {multi:?} (debug_assertions={})", cfg!(debug_assertions));
        assert!(single.as_micros() < 100 && multi.as_micros() < 200);
    }

    /// The workspace forbids `unsafe`, so no counting allocator: instead, after warm-up the output vectors keep their buffer
    /// (pointer and capacity) across thousands of calls, and the function itself builds nothing but pushes into them.
    #[test]
    fn output_buffers_are_reused_without_growing() {
        let clips: Vec<Clip> = (0..1000)
            .map(|i| clip(i, i as i64 * 20_000_000, 0, 15_000_000, one()))
            .collect();
        let s = seq(Rational::FPS_30, &clips);
        let mut out = FrameDescription::default();
        evaluate_into(&s, Time::from_ticks(40_000_000), 4096, &mut out);
        let marks = |o: &FrameDescription| {
            (
                o.layers.as_ptr(),
                o.layers.capacity(),
                o.audio.as_ptr(),
                o.audio.capacity(),
            )
        };
        let before = marks(&out);
        for i in 0..2000 {
            evaluate_into(&s, Time::from_ticks(i * 10_000_000 + 5), 4096, &mut out);
        }
        assert_eq!(marks(&out), before);
    }
}
