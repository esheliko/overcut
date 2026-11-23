//! Micro-benchmarks for `apply` and `evaluate_into` on a 5000-clip project (docs/PERFORMANCE.md "Editing op").
//! Prints one JSON object (`ops_apply_ms`, `evaluate_ms`: mean milliseconds per call). Run: `cargo run --release -p app-timeline --example bench`.
//! No dependency: plain `Instant` loops, best of several rounds, so it runs anywhere `cargo` does.

use app_model::{
    Clip, ClipId, MediaId, MediaKind, MediaRef, Project, Rational, Resolution, SeqIds, Time, Track,
    TrackId, TrackKind,
};
use app_timeline::{apply, evaluate_into, FrameDescription, Op};
use std::time::Instant;

const U: i64 = 705_600_000 / 30;
const CLIPS: i64 = 5000;
const TRACKS: usize = 5;

fn t(frames: i64) -> Time {
    Time::from_ticks(frames * U)
}

fn best_of<F: FnMut() -> usize>(rounds: u32, mut f: F) -> f64 {
    let mut best = f64::MAX;
    for _ in 0..rounds {
        let start = Instant::now();
        let n = f();
        best = best.min(start.elapsed().as_secs_f64() * 1000.0 / n as f64);
    }
    best
}

fn main() {
    let mut ids = SeqIds::default();
    let mut p = Project::new(
        &mut ids,
        "bench",
        Rational::FPS_30,
        Resolution {
            width: 1920,
            height: 1080,
        },
    );
    let m = MediaId::new(&mut ids);
    p.media = vec![MediaRef {
        id: m,
        kind: MediaKind::Video,
        name: "m".into(),
        uri: "m".into(),
        hash: None,
        duration: None,
        tags: vec![],
    }];
    let mut tracks = vec![];
    for i in 0..TRACKS {
        tracks.push(Track {
            id: TrackId::new(&mut ids),
            kind: TrackKind::Video,
            name: format!("V{i}"),
            muted: false,
            locked: false,
            clips: vec![],
        });
    }
    let per = CLIPS / TRACKS as i64;
    let mut clip_ids = vec![];
    for (ti, track) in tracks.iter_mut().enumerate() {
        for k in 0..per {
            let c = Clip {
                id: ClipId::new(&mut ids),
                media: m,
                start: t(k * 30),
                source_in: t(0),
                duration: t(29),
                speed: Rational::new(1, 1).unwrap(),
            };
            clip_ids.push((ti, c.id, k));
            track.clips.push(c);
        }
    }
    p.sequences[0].tracks = tracks;
    let seq_tracks: Vec<TrackId> = p.sequences[0].tracks.iter().map(|x| x.id).collect();

    // apply: nudge one clip in the middle of the project by one frame and back (SetClip is its own kind of inverse).
    let (ti, victim, k) = clip_ids[clip_ids.len() / 2];
    let _ = (ti, seq_tracks);
    let apply_ms = best_of(5, || {
        let n = 2000;
        for i in 0..n {
            let start = t(k * 30 + i64::from(i % 2 == 0)); // 0 or 1 frame; clips are 29 frames in 30-frame slots, so no overlap
            let r = apply(
                &mut p,
                Op::SetClip {
                    clip: victim,
                    start,
                    source_in: t(0),
                    duration: t(29),
                },
            );
            assert!(r.is_ok());
        }
        n as usize
    });

    // evaluate_into: reuse the output buffer, sweep the playhead across the project.
    let mut out = FrameDescription::default();
    let seq = &p.sequences[0];
    let eval_ms = best_of(5, || {
        let n = 5000;
        for i in 0..n {
            evaluate_into(seq, t(i64::from(i) * 7 % (per * 30)), 0, &mut out);
        }
        n as usize
    });

    println!(
        "{{\"clips\":{CLIPS},\"tracks\":{TRACKS},\"ops_apply_ms\":{apply_ms:.5},\"evaluate_ms\":{eval_ms:.5}}}"
    );
}
