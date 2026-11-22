//! S7 property tests. Case count: `PROPTEST_CASES` (default 256 here; the S7 bar of 100k is
//! `PROPTEST_CASES=100000 cargo test -p app-timeline --release`).

use crate::*;
use app_model::{
    Clip, ClipId, IdSource, MediaId, MediaKind, MediaRef, Project, Rational, Resolution, SeqIds,
    Time, Track, TrackId, TrackKind,
};
use proptest::prelude::*;

const U: i64 = 1000; // one grid unit in ticks: small so random ops often touch, overlap and hit media ends

fn t(units: i64) -> Time {
    Time::from_ticks(units * U)
}

fn media(ids: &mut SeqIds, kind: MediaKind, units: Option<i64>) -> MediaRef {
    MediaRef {
        id: MediaId::new(ids),
        kind,
        name: "m".into(),
        uri: "m".into(),
        hash: None,
        duration: units.map(t),
    }
}

fn base() -> (Project, SeqIds) {
    let mut ids = SeqIds::default();
    let mut p = Project::new(
        &mut ids,
        "T",
        Rational::FPS_30,
        Resolution {
            width: 1920,
            height: 1080,
        },
    );
    p.media = vec![
        media(&mut ids, MediaKind::Video, Some(100)),
        media(&mut ids, MediaKind::Audio, Some(50)),
        media(&mut ids, MediaKind::Image, None),
        media(&mut ids, MediaKind::Video, None),
    ];
    p.sequences[0].tracks.insert(
        1,
        Track {
            id: TrackId::new(&mut ids),
            kind: TrackKind::Video,
            name: "V2".into(),
            muted: false,
            locked: false,
            clips: vec![],
        },
    );
    p.validate().unwrap();
    (p, ids)
}

fn clip(ids: &mut SeqIds, media: MediaId, start: i64, source_in: i64, dur: i64) -> Clip {
    Clip {
        id: ClipId::new(ids),
        media,
        start: t(start),
        source_in: t(source_in),
        duration: t(dur),
        speed: Rational::new(1, 1).unwrap(),
    }
}

/// A random step, resolved against the live project so that most ops address something real.
#[derive(Clone, Debug)]
enum Step {
    Insert {
        track: usize,
        media: usize,
        start: u8,
        source_in: u8,
        dur: u8,
        append: bool,
    },
    Split {
        clip: usize,
        frac: u8,
    },
    TrimIn {
        clip: usize,
        delta: i8,
    },
    TrimOut {
        clip: usize,
        delta: i8,
    },
    Move {
        clip: usize,
        track: usize,
        start: u8,
    },
    Delete {
        clip: usize,
    },
    SetClip {
        clip: usize,
        start: u8,
        source_in: u8,
        dur: u8,
    },
    Undo,
    Redo,
}

fn step() -> impl Strategy<Value = Step> {
    prop_oneof![
        4 => (0..4usize, 0..4usize, 0..60u8, 0..30u8, 1..25u8, any::<bool>())
            .prop_map(|(track, media, start, source_in, dur, append)| Step::Insert { track, media, start, source_in, dur, append }),
        2 => (any::<usize>(), 1..100u8).prop_map(|(clip, frac)| Step::Split { clip, frac }),
        2 => (any::<usize>(), -8..8i8).prop_map(|(clip, delta)| Step::TrimIn { clip, delta }),
        2 => (any::<usize>(), -8..8i8).prop_map(|(clip, delta)| Step::TrimOut { clip, delta }),
        3 => (any::<usize>(), 0..4usize, 0..70u8).prop_map(|(clip, track, start)| Step::Move { clip, track, start }),
        2 => any::<usize>().prop_map(|clip| Step::Delete { clip }),
        1 => (any::<usize>(), 0..60u8, 0..30u8, 0..25u8).prop_map(|(clip, start, source_in, dur)| Step::SetClip { clip, start, source_in, dur }),
        2 => Just(Step::Undo),
        2 => Just(Step::Redo),
    ]
}

fn all_clips(p: &Project) -> Vec<&Clip> {
    p.sequences
        .iter()
        .flat_map(|s| &s.tracks)
        .flat_map(|t| &t.clips)
        .collect()
}

/// Turns a step into an op for the current state (`None` for undo/redo or when there is nothing to address).
fn resolve(s: &Step, p: &Project, ids: &mut SeqIds) -> Option<Op> {
    let tracks = &p.sequences[0].tracks;
    let pick = |i: usize| {
        let cs = all_clips(p);
        (!cs.is_empty()).then(|| cs[i % cs.len()].clone())
    };
    Some(match *s {
        Step::Insert {
            track,
            media,
            start,
            source_in,
            dur,
            append,
        } => {
            let tr = &tracks[track % tracks.len()];
            let start = if append {
                tr.clips
                    .last()
                    .map_or(0, |c| (c.end().unwrap().ticks() / U) + i64::from(start % 3))
            } else {
                i64::from(start)
            };
            let m = &p.media[media % p.media.len()];
            Op::InsertClip {
                track: tr.id,
                clip: clip(ids, m.id, start, i64::from(source_in), i64::from(dur)),
            }
        }
        Step::Split { clip, frac } => {
            let c = pick(clip)?;
            let at = c.start.ticks() + c.duration.ticks() * i64::from(frac) / 100;
            Op::Split {
                clip: c.id,
                at: Time::from_ticks(at),
                new_id: ClipId::new(ids),
            }
        }
        Step::TrimIn { clip, delta } => {
            let c = pick(clip)?;
            Op::TrimIn {
                clip: c.id,
                start: t(c.start.ticks() / U + i64::from(delta)),
            }
        }
        Step::TrimOut { clip, delta } => {
            let c = pick(clip)?;
            Op::TrimOut {
                clip: c.id,
                end: t(c.end().unwrap().ticks() / U + i64::from(delta)),
            }
        }
        Step::Move { clip, track, start } => {
            let c = pick(clip)?;
            Op::Move {
                clip: c.id,
                track: tracks[track % tracks.len()].id,
                start: t(i64::from(start)),
            }
        }
        Step::Delete { clip } => Op::Delete {
            clip: pick(clip)?.id,
        },
        Step::SetClip {
            clip,
            start,
            source_in,
            dur,
        } => Op::SetClip {
            clip: pick(clip)?.id,
            start: t(i64::from(start)),
            source_in: t(i64::from(source_in)),
            duration: t(i64::from(dur)),
        },
        Step::Undo | Step::Redo => return None,
    })
}

proptest! {
    #![proptest_config(ProptestConfig { max_shrink_iters: 2000, ..ProptestConfig::default() })]

    /// Every op: Ok keeps the project valid and `apply(inverse)` restores it exactly; Err leaves it untouched.
    #[test]
    fn undo_of_do_is_identity_and_errors_change_nothing(steps in prop::collection::vec(step(), 1..40)) {
        let (mut p, mut ids) = base();
        let mut applied = 0usize;
        for s in &steps {
            let Some(op) = resolve(s, &p, &mut ids) else { continue };
            let before = p.clone();
            match apply(&mut p, op.clone()) {
                Ok(inv) => {
                    applied += 1;
                    p.validate().map_err(|e| TestCaseError::fail(format!("{op:?} left an invalid project: {e}")))?;
                    let after = p.clone();
                    apply_all(&mut p, &inv.0).map_err(|e| TestCaseError::fail(format!("inverse of {op:?} failed: {e}")))?;
                    prop_assert_eq!(&p, &before, "undo(do({:?})) != x", op);
                    apply(&mut p, op.clone()).unwrap();
                    prop_assert_eq!(&p, &after, "redo differs for {:?}", op);
                }
                Err(_) => prop_assert_eq!(&p, &before, "failed {:?} changed the project", op),
            }
        }
        let _ = applied;
    }

    /// History with undo/redo steps: each undo returns to the state before that step, and
    /// replay(journal) == state at the end (journal includes the undo/redo traffic).
    #[test]
    fn history_undo_redo_and_journal_replay(steps in prop::collection::vec(step(), 1..60)) {
        let (start, mut ids) = base();
        let mut p = start.clone();
        let mut h = History::new();
        let mut states = vec![p.clone()]; // states[i] = project after i undo steps from the base
        let mut redo_states: Vec<Project> = vec![];
        for s in &steps {
            match s {
                Step::Undo => {
                    let did = h.undo(&mut p).unwrap();
                    prop_assert_eq!(did, states.len() > 1);
                    if did {
                        redo_states.push(states.pop().unwrap());
                        prop_assert_eq!(&p, states.last().unwrap());
                    }
                }
                Step::Redo => {
                    let did = h.redo(&mut p).unwrap();
                    prop_assert_eq!(did, !redo_states.is_empty());
                    if did {
                        states.push(redo_states.pop().unwrap());
                        prop_assert_eq!(&p, states.last().unwrap());
                    }
                }
                _ => {
                    let Some(op) = resolve(s, &p, &mut ids) else { continue };
                    if h.apply(&mut p, op, None).is_ok() {
                        redo_states.clear();
                        states.push(p.clone());
                    }
                }
            }
            p.validate().map_err(|e| TestCaseError::fail(e.to_string()))?;
        }
        let replayed = replay(&start, h.journal()).map_err(|(i, e)| TestCaseError::fail(format!("journal op {i}: {e}")))?;
        prop_assert_eq!(&replayed, &p, "replay(journal) != state");
        // The JSONL form round-trips to the same ops.
        prop_assert_eq!(journal_from_jsonl(&journal_to_jsonl(h.journal())).unwrap(), h.journal().to_vec());
        // Undo everything, then redo everything.
        while h.undo(&mut p).unwrap() {}
        prop_assert_eq!(&p, &start);
        while h.redo(&mut p).unwrap() {}
        let full = redo_states.first().or(states.last()).unwrap();
        prop_assert_eq!(&p, full);
    }
}

/// (name, op, predicate the error must satisfy)
type Case = (&'static str, Op, fn(&OpError) -> bool);

fn two_clips() -> (Project, TrackId, ClipId, ClipId) {
    let (mut p, mut ids) = base();
    let tr = p.sequences[0].tracks[0].id;
    let m = p.media[0].id;
    let (a, b) = (clip(&mut ids, m, 0, 0, 10), clip(&mut ids, m, 20, 10, 10));
    let (ai, bi) = (a.id, b.id);
    p.sequences[0].tracks[0].clips = vec![a, b];
    (p, tr, ai, bi)
}

#[test]
fn each_validation_rule_rejects_and_leaves_the_project_alone() {
    let (p0, tr, a, b) = two_clips();
    let audio_track = p0.sequences[0].tracks[2].id;
    let (m_video, m_audio, m_image) = (p0.media[0].id, p0.media[1].id, p0.media[2].id);
    let mut ids = SeqIds::default();
    for _ in 0..1000 {
        ids.next_id(); // fresh ids that cannot collide
    }
    let mut new_clip = |m, s, i, d| clip(&mut ids, m, s, i, d);

    let cases: Vec<Case> = vec![
        (
            "overlap on insert",
            Op::InsertClip {
                track: tr,
                clip: new_clip(m_video, 5, 0, 10),
            },
            |e| matches!(e, OpError::Overlap { .. }),
        ),
        (
            "zero length",
            Op::InsertClip {
                track: tr,
                clip: new_clip(m_video, 11, 0, 0),
            },
            |e| matches!(e, OpError::EmptyClip),
        ),
        (
            "negative start",
            Op::InsertClip {
                track: tr,
                clip: Clip {
                    start: Time::from_ticks(-1),
                    ..new_clip(m_video, 11, 0, 1)
                },
            },
            |e| matches!(e, OpError::OutOfRange),
        ),
        (
            "past the media end",
            Op::InsertClip {
                track: tr,
                clip: new_clip(m_video, 11, 95, 10),
            },
            |e| matches!(e, OpError::BeyondMedia),
        ),
        (
            "audio-only media on a video track",
            Op::InsertClip {
                track: tr,
                clip: new_clip(m_audio, 11, 0, 5),
            },
            |e| matches!(e, OpError::KindMismatch),
        ),
        (
            "unknown track",
            Op::InsertClip {
                track: TrackId(app_model::Id::from_u128(99_999)),
                clip: new_clip(m_video, 11, 0, 5),
            },
            |e| matches!(e, OpError::UnknownTrack(_)),
        ),
        (
            "duplicate id",
            Op::InsertClip {
                track: tr,
                clip: Clip {
                    id: a,
                    ..new_clip(m_video, 11, 0, 5)
                },
            },
            |e| matches!(e, OpError::IdInUse(_)),
        ),
        (
            "split at the edge",
            Op::Split {
                clip: a,
                at: t(0),
                new_id: ClipId(app_model::Id::from_u128(5000)),
            },
            |e| matches!(e, OpError::SplitOutside),
        ),
        (
            "split id in use",
            Op::Split {
                clip: a,
                at: t(5),
                new_id: b,
            },
            |e| matches!(e, OpError::IdInUse(_)),
        ),
        (
            "trim in past out (in >= out)",
            Op::TrimIn {
                clip: a,
                start: t(10),
            },
            |e| matches!(e, OpError::EmptyClip),
        ),
        (
            "trim in before source start",
            Op::TrimIn {
                clip: a,
                start: t(-1),
            },
            |e| matches!(e, OpError::OutOfRange),
        ),
        (
            "trim in past the start of the source",
            Op::TrimIn {
                clip: b,
                start: t(9),
            },
            |e| matches!(e, OpError::OutOfRange),
        ),
        (
            "trim out into the next clip",
            Op::TrimOut {
                clip: a,
                end: t(21),
            },
            |e| matches!(e, OpError::Overlap { .. }),
        ),
        (
            "trim out beyond media",
            Op::TrimOut {
                clip: b,
                end: t(115),
            },
            |e| matches!(e, OpError::BeyondMedia),
        ),
        (
            "move onto a neighbour",
            Op::Move {
                clip: a,
                track: tr,
                start: t(15),
            },
            |e| matches!(e, OpError::Overlap { .. }),
        ),
        (
            "still image on an audio track",
            Op::InsertClip {
                track: audio_track,
                clip: new_clip(m_image, 0, 0, 5),
            },
            |e| matches!(e, OpError::KindMismatch),
        ),
        (
            "delete unknown",
            Op::Delete {
                clip: ClipId(app_model::Id::from_u128(77)),
            },
            |e| matches!(e, OpError::UnknownClip(_)),
        ),
    ];
    for (name, op, expect) in cases {
        let mut p = p0.clone();
        let err = apply(&mut p, op).expect_err(name);
        assert!(expect(&err), "{name}: got {err:?}");
        assert_eq!(p, p0, "{name}: project changed on error");
    }
}

#[test]
fn locked_tracks_refuse_edits() {
    let (mut p, tr, a, _) = two_clips();
    p.sequences[0].tracks[0].locked = true;
    let before = p.clone();
    assert_eq!(
        apply(&mut p, Op::Delete { clip: a }),
        Err(OpError::TrackLocked(tr))
    );
    assert_eq!(p, before);
}

#[test]
fn split_keeps_the_picture_continuous() {
    let (mut p, _, a, _) = two_clips();
    let new_id = ClipId(app_model::Id::from_u128(9000));
    apply(
        &mut p,
        Op::Split {
            clip: a,
            at: t(4),
            new_id,
        },
    )
    .unwrap();
    let clips = &p.sequences[0].tracks[0].clips;
    assert_eq!((clips[0].start, clips[0].duration), (t(0), t(4)));
    assert_eq!(
        (
            clips[1].id,
            clips[1].start,
            clips[1].source_in,
            clips[1].duration
        ),
        (new_id, t(4), t(4), t(6))
    );
    p.validate().unwrap();
}

#[test]
fn trim_in_moves_the_source_point_with_the_edge() {
    let (mut p, _, _, b) = two_clips(); // b: start 20, source_in 10, dur 10
    apply(
        &mut p,
        Op::TrimIn {
            clip: b,
            start: t(23),
        },
    )
    .unwrap();
    let c = &p.sequences[0].tracks[0].clips[1];
    assert_eq!((c.start, c.source_in, c.duration), (t(23), t(13), t(7)));
}

#[test]
fn speed_that_needs_a_fraction_of_a_tick_is_refused_not_rounded() {
    let (mut p, _, a, _) = two_clips();
    p.sequences[0].tracks[0].clips[0].speed = Rational::new(1, 3).unwrap();
    // 1/3 of an odd tick count is not whole
    let r = apply(
        &mut p.clone(),
        Op::Split {
            clip: a,
            at: Time::from_ticks(1),
            new_id: ClipId(app_model::Id::from_u128(9999)),
        },
    );
    assert_eq!(r, Err(OpError::InexactSpeed));
}

#[test]
fn a_failing_batch_rolls_back_every_step() {
    let (mut p, tr, a, b) = two_clips();
    let before = p.clone();
    let ops = [
        Op::Move {
            clip: a,
            track: tr,
            start: t(40),
        },
        Op::Delete { clip: b },
        Op::Delete { clip: b }, // already gone
    ];
    let err = apply_all(&mut p, &ops).unwrap_err();
    assert!(matches!(err, OpError::Batch { index: 2, .. }));
    assert_eq!(p, before);
}

#[test]
fn a_drag_is_one_undo_step() {
    let (mut p, tr, a, _) = two_clips();
    let start = p.clone();
    let mut h = History::new();
    for x in 1..=9 {
        h.apply(
            &mut p,
            Op::Move {
                clip: a,
                track: tr,
                start: t(x),
            },
            Some(7),
        )
        .unwrap();
    }
    assert_eq!(
        h.journal().len(),
        9,
        "every op is journaled even when undo steps merge"
    );
    // a different key (or None) starts a new step
    h.apply(&mut p, Op::Delete { clip: a }, None).unwrap();
    assert!(h.undo(&mut p).unwrap()); // the delete
    assert!(h.undo(&mut p).unwrap()); // the whole drag
    assert_eq!(p, start);
    assert!(!h.undo(&mut p).unwrap());
    assert!(h.redo(&mut p).unwrap());
    assert_eq!(p.sequences[0].tracks[0].clips[0].start, t(9));
}

#[test]
fn a_new_edit_clears_redo_and_the_step_limit_drops_the_oldest() {
    let (mut p, tr, a, _) = two_clips();
    let mut h = History::with_limit(2);
    for x in 1..=3 {
        h.apply(
            &mut p,
            Op::Move {
                clip: a,
                track: tr,
                start: t(x),
            },
            None,
        )
        .unwrap();
    }
    assert!(h.undo(&mut p).unwrap() && h.undo(&mut p).unwrap());
    assert!(!h.undo(&mut p).unwrap(), "limit 2 keeps two steps");
    assert!(h.can_redo());
    h.apply(
        &mut p,
        Op::Move {
            clip: a,
            track: tr,
            start: t(9),
        },
        None,
    )
    .unwrap();
    assert!(!h.can_redo());
}

#[test]
fn torn_last_journal_line_is_dropped_but_earlier_corruption_is_an_error() {
    let ops = vec![
        Op::Delete {
            clip: ClipId(app_model::Id::from_u128(1)),
        },
        Op::Delete {
            clip: ClipId(app_model::Id::from_u128(2)),
        },
    ];
    let text = journal_to_jsonl(&ops);
    assert_eq!(journal_from_jsonl(&text).unwrap(), ops);
    let torn = &text[..text.len() - 8];
    assert_eq!(journal_from_jsonl(torn).unwrap(), ops[..1].to_vec());
    let bad = format!("{{nope\n{text}");
    assert!(journal_from_jsonl(&bad).is_err());
}

#[test]
fn editor_json_api_round_trips() {
    let (p, tr, a, _) = two_clips();
    let mut e = Editor::open(&serde_json::to_string(&p).unwrap()).unwrap();
    let op = serde_json::to_string(&Op::Move {
        clip: a,
        track: tr,
        start: t(5),
    })
    .unwrap();
    let out: EditOutcome = serde_json::from_str(&e.apply_json(&op, Some(1)).unwrap()).unwrap();
    assert_eq!(
        (out.revision, out.can_undo, out.can_redo, out.changed),
        (1, true, false, true)
    );
    // an array is one atomic step
    let batch = format!(
        "[{op},{}]",
        serde_json::to_string(&Op::Delete { clip: a }).unwrap()
    );
    assert!(e.apply_json(&batch, None).is_ok());
    assert!(e.apply_json("{\"op\":\"nope\"}", None).is_err());
    let out: EditOutcome = serde_json::from_str(&e.undo_json().unwrap()).unwrap();
    assert!(out.changed && out.can_redo);
    e.undo_json().unwrap();
    let none: EditOutcome = serde_json::from_str(&e.undo_json().unwrap()).unwrap();
    assert!(!none.changed);
    assert_eq!(*e.project(), p);
    assert!(Editor::open("{}").is_err());
}

/// S7 performance bar: < 1 ms per op at 5k clips. Numbers print with `--nocapture`.
#[test]
fn s7_per_op_cost_at_5k_clips() {
    let (mut p, mut ids) = base();
    p.media[0].duration = None;
    let m = p.media[0].id;
    let tr = p.sequences[0].tracks[0].id;
    let tr2 = p.sequences[0].tracks[1].id;
    // 5,000 clips on ONE track (worst case for the sorted-vec scan), 10 units long with 2-unit gaps
    p.sequences[0].tracks[0].clips = (0..5000)
        .map(|i| clip(&mut ids, m, i * 12, 0, 10))
        .collect();
    p.validate().unwrap();
    let mut h = History::new();
    let ids_of: Vec<ClipId> = p.sequences[0].tracks[0]
        .clips
        .iter()
        .map(|c| c.id)
        .collect();
    let n = 2000usize;
    let mut worst = std::time::Duration::ZERO;
    let started = std::time::Instant::now();
    for i in 0..n {
        // spread over the whole track so scans are not always short; a mix of every op kind
        let c = ids_of[(i * 7919) % ids_of.len()];
        let op = match i % 5 {
            0 => Op::Move {
                clip: c,
                track: tr2,
                start: t(((i * 13) % 5000) as i64 * 12),
            },
            1 => Op::TrimOut {
                clip: c,
                end: t(((i * 7919) % 5000) as i64 * 12 + 9),
            },
            2 => Op::Split {
                clip: c,
                at: t(((i * 7919) % 5000) as i64 * 12 + 5),
                new_id: ClipId::new(&mut ids),
            },
            3 => Op::Delete { clip: c },
            _ => Op::TrimIn {
                clip: c,
                start: t(((i * 7919) % 5000) as i64 * 12 + 1),
            },
        };
        let s = std::time::Instant::now();
        let _ = h.apply(&mut p, op, None); // some are refused by design; refusal costs the same lookups
        worst = worst.max(s.elapsed());
    }
    let total = started.elapsed();
    let mean = total / n as u32;
    eprintln!(
        "S7 perf: {n} ops at ~5k clips: mean {mean:?}, worst {worst:?} (debug_assertions={})",
        cfg!(debug_assertions)
    );
    p.validate().unwrap();
    let _ = tr;
    // 1 ms is the release bar; unoptimised test builds get 10x headroom so CI noise does not flake.
    let budget = if cfg!(debug_assertions) {
        std::time::Duration::from_millis(10)
    } else {
        std::time::Duration::from_millis(1)
    };
    assert!(mean < budget, "mean {mean:?} over budget {budget:?}");
}

/// Guards the property tests against a generator that mostly produces refused ops (which would test little).
#[test]
fn generator_applies_a_healthy_share_of_ops() {
    use proptest::strategy::ValueTree;
    use proptest::test_runner::TestRunner;
    let mut runner = TestRunner::deterministic();
    let strat = prop::collection::vec(step(), 40);
    let (mut ok, mut tried, mut kinds) = (0, 0, std::collections::HashSet::new());
    for _ in 0..200 {
        let steps = strat.new_tree(&mut runner).unwrap().current();
        let (mut p, mut ids) = base();
        for s in &steps {
            let Some(op) = resolve(s, &p, &mut ids) else {
                continue;
            };
            tried += 1;
            let name = format!("{op:?}").split(' ').next().unwrap().to_string();
            if apply(&mut p, op).is_ok() {
                ok += 1;
                kinds.insert(name);
            }
        }
    }
    eprintln!("generator: {ok}/{tried} ops applied, kinds {kinds:?}");
    assert!(ok * 4 >= tried, "only {ok}/{tried} ops applied");
    assert_eq!(
        kinds.len(),
        7,
        "every op kind must succeed sometimes: {kinds:?}"
    );
}

/// The JSON the TypeScript client sends and reads is pinned by `packages/engine-client/schema/edit-contract.json`
/// (the TS side tests the same file in `tests/unit/editing.test.ts`).
#[test]
fn wire_format_matches_the_checked_in_contract() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/engine-client/schema/edit-contract.json"
    );
    let fixture: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let ops = fixture["ops"].as_array().unwrap();
    assert_eq!(ops.len(), 7, "one example per Op variant");
    for raw in ops {
        let op: Op = serde_json::from_value(raw.clone()).unwrap_or_else(|e| panic!("{raw}: {e}"));
        assert_eq!(
            &serde_json::to_value(&op).unwrap(),
            raw,
            "Op does not serialize back to the contract"
        );
    }
    let out: EditOutcome = serde_json::from_value(fixture["outcome"].clone()).unwrap();
    assert_eq!(serde_json::to_value(out).unwrap(), fixture["outcome"]);
}
