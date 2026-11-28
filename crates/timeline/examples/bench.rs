//! Micro-benchmarks for `apply` and `evaluate_into` on a 5000-clip project (docs/PERFORMANCE.md "Editing op").
//! Prints one JSON object (`ops_apply_ms`, `evaluate_ms`: mean milliseconds per call). Run: `cargo run --release -p app-timeline --example bench`.
//! No dependency: plain `Instant` loops, best of several rounds, so it runs anywhere `cargo` does.

use app_model::{
    Clip, ClipId, MediaId, MediaKind, MediaRef, Project, Rational, Resolution, SeqIds, Time, Track,
    TrackId, TrackKind,
};
use app_timeline::{apply, apply_patch, diff, evaluate_into, Edge, FrameDescription, Op};
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

/// A project of `tracks` video tracks with `per` clips each (29 frames long in 30-frame slots), plus the ids to address them.
fn build(tracks_n: usize, per: i64) -> (Project, SeqIds, Vec<(usize, ClipId, i64)>) {
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
    for i in 0..tracks_n {
        tracks.push(Track {
            id: TrackId::new(&mut ids),
            kind: TrackKind::Video,
            name: format!("V{i}"),
            muted: false,
            locked: false,
            hidden: false,
            solo: false,
            height: None,
            colour: None,
            clips: vec![],
        });
    }
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
                link: None,
                transform: Default::default(),
                audio: Default::default(),
            };
            clip_ids.push((ti, c.id, k));
            track.clips.push(c);
        }
    }
    p.sequences[0].tracks = tracks;
    (p, ids, clip_ids)
}

/// M2-011: a mix of the compound timeline edits on a 20-track project with `per` clips per track (250 = the 5k budget size, 1000 = stress), each op
/// applied then undone through its inverse (the real editing loop). Returns (mean ms, worst ms) per applied op.
fn mixed(per: i64) -> (f64, f64) {
    let mut kinds = [(0.0f64, 0.0f64, 0u32); 8];
    let (mut p, mut ids, clips) = build(20, per);
    let tracks: Vec<TrackId> = p.sequences[0].tracks.iter().map(|x| x.id).collect();
    let n = 4000usize;
    let (mut total, mut worst) = (0.0f64, 0.0f64);
    for i in 0..n {
        let (ti, c, k) = clips[(i * 7919) % clips.len()];
        let other = tracks[(ti + 1 + i % 18) % 20];
        let op = match i % 8 {
            0 => Op::Move {
                clip: c,
                track: other,
                start: t(k * 30 + 100_000),
            },
            1 => Op::TrimOut {
                clip: c,
                end: t(k * 30 + 20),
            },
            2 => Op::Split {
                clip: c,
                at: t(k * 30 + 10),
                new_id: ClipId::new(&mut ids),
                new_link: None,
            },
            3 => Op::RippleTrim {
                clip: c,
                edge: Edge::Out,
                delta: t(-2),
                all_tracks: i % 16 == 3,
            },
            4 => Op::Slip {
                clip: c,
                delta: t(1),
            },
            5 => Op::Slide {
                clip: c,
                delta: t(0),
            },
            6 => Op::SetClipTransform {
                clip: c,
                transform: Box::default(),
            },
            _ => Op::Delete { clip: c },
        };
        let s = Instant::now();
        let r = apply(&mut p, op);
        let ms = s.elapsed().as_secs_f64() * 1000.0;
        if let Ok(inv) = r {
            total += ms;
            worst = worst.max(ms);
            let k = &mut kinds[i % 8];
            *k = (k.0 + ms, k.1.max(ms), k.2 + 1);
            // undo it so the project keeps its size and every op sees the same 20k clips
            for o in inv.0 {
                let _ = apply(&mut p, o);
            }
        }
    }
    if std::env::var_os("BENCH_KINDS").is_some() {
        for (name, (sum, w, c)) in [
            "Move",
            "TrimOut",
            "Split",
            "RippleTrim",
            "Slip",
            "Slide",
            "SetClipTransform",
            "Delete",
        ]
        .iter()
        .zip(kinds)
        {
            eprintln!(
                "{name:>17}: n={c:>4} mean {:.4} ms worst {w:.4} ms",
                sum / f64::from(c.max(1))
            );
        }
    }
    (total / n as f64, worst)
}

fn main() {
    let per = CLIPS / TRACKS as i64;
    let (mut p, _ids, clip_ids) = build(TRACKS, per);
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
                    speed: None,
                },
            );
            assert!(r.is_ok());
        }
        n as usize
    });

    // ADR 0020: what the editor adds to every outcome: diff against the shadow copy and move the shadow forward (same nudge as above).
    let mut shadow = p.clone();
    let patch_ms = best_of(5, || {
        let n = 2000;
        for i in 0..n {
            let start = t(k * 30 + i64::from(i % 2 == 0));
            apply(
                &mut p,
                Op::SetClip {
                    clip: victim,
                    start,
                    source_in: t(0),
                    duration: t(29),
                    speed: None,
                },
            )
            .unwrap();
            let patch = diff(&shadow, &p).unwrap();
            apply_patch(&mut shadow, &patch).unwrap();
        }
        n as usize
    });
    assert_eq!(shadow, p);

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

    let (mix5_mean, mix5_worst) = mixed(250); // 20 tracks x 250 = 5k clips: the budget size
    let (mix20_mean, mix20_worst) = mixed(1000); // 20 tracks x 1000 = 20k clips: stress
    println!(
        "{{\"clips\":{CLIPS},\"tracks\":{TRACKS},\"ops_apply_ms\":{apply_ms:.5},\"ops_apply_patch_ms\":{patch_ms:.5},\"evaluate_ms\":{eval_ms:.5},\"mix_20x250_mean_ms\":{mix5_mean:.5},\"mix_20x250_worst_ms\":{mix5_worst:.5},\"mix_20x1000_mean_ms\":{mix20_mean:.5},\"mix_20x1000_worst_ms\":{mix20_worst:.5}}}"
    );
}
