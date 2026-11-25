//! S7 property tests. Case count: `PROPTEST_CASES` (default 256 here; the S7 bar of 100k is
//! `PROPTEST_CASES=100000 cargo test -p app-timeline --release`).

use crate::apply::MAX_TRACKS;
use crate::*;
use app_model::{
    Clip, ClipId, IdSource, LinkId, MediaId, MediaKind, MediaRef, Project, Rational, Resolution,
    SeqIds, SequenceId, Time, Track, TrackId, TrackKind,
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
        tags: vec![],
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
            hidden: false,
            solo: false,
            height: None,
            colour: None,
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
        link: None,
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
    AddTrack {
        video: bool,
        index: usize,
        with_clip: bool,
    },
    RemoveTrack {
        track: usize,
    },
    MoveTrack {
        track: usize,
        index: usize,
    },
    TrackProps {
        track: usize,
        muted: Option<bool>,
        solo: Option<bool>,
        locked: Option<bool>,
        hidden: Option<bool>,
        height: Option<Option<u32>>,
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
        1 => (any::<bool>(), any::<usize>(), any::<bool>()).prop_map(|(video, index, with_clip)| Step::AddTrack { video, index, with_clip }),
        1 => any::<usize>().prop_map(|track| Step::RemoveTrack { track }),
        1 => (any::<usize>(), any::<usize>()).prop_map(|(track, index)| Step::MoveTrack { track, index }),
        2 => (any::<usize>(), any::<Option<bool>>(), any::<Option<bool>>(), any::<Option<bool>>(), any::<Option<bool>>(), prop::option::of(prop::option::of(0..450u32)))
            .prop_map(|(track, muted, solo, locked, hidden, height)| Step::TrackProps { track, muted, solo, locked, hidden, height }),
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
                new_link: None,
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
        Step::AddTrack {
            video,
            index,
            with_clip,
        } => {
            let kind = if video {
                TrackKind::Video
            } else {
                TrackKind::Audio
            };
            let m = p
                .media
                .iter()
                .find(|m| matches!(m.kind, MediaKind::Video))
                .unwrap();
            let clips = if with_clip {
                vec![clip(ids, m.id, 0, 0, 5)]
            } else {
                vec![]
            };
            Op::AddTrack {
                sequence: p.sequences[0].id,
                index: index % (tracks.len() + 2), // sometimes one past the top (invalid)
                track: Track {
                    id: TrackId::new(ids),
                    kind,
                    name: "New".into(),
                    muted: false,
                    locked: false,
                    hidden: false,
                    solo: false,
                    height: None,
                    colour: None,
                    clips,
                },
            }
        }
        // Never empty the sequence: the generator addresses tracks by index modulo their count.
        Step::RemoveTrack { track } if tracks.len() > 1 => Op::RemoveTrack {
            track: tracks[track % tracks.len()].id,
        },
        Step::RemoveTrack { .. } => return None,
        Step::MoveTrack { track, index } => Op::MoveTrack {
            track: tracks[track % tracks.len()].id,
            index: index % (tracks.len() + 1),
        },
        Step::TrackProps {
            track,
            muted,
            solo,
            locked,
            hidden,
            height,
        } => Op::SetTrackProps {
            track: tracks[track % tracks.len()].id,
            name: None,
            muted,
            solo,
            locked,
            hidden,
            height,
            colour: None,
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
                new_link: None,
            },
            |e| matches!(e, OpError::SplitOutside),
        ),
        (
            "split id in use",
            Op::Split {
                clip: a,
                at: t(5),
                new_id: b,
                new_link: None,
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
            new_link: None,
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
            new_link: None,
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

/// What the editor's duplicate / paste / cut send (TL-02): copies are plain `InsertClip`s with fresh ids, one batch = one undo step.
#[test]
fn duplicate_paste_and_cut_are_single_undo_steps_of_existing_ops() {
    let (mut p, mut ids) = base();
    let tr = p.sequences[0].tracks[0].id;
    let m = p.media[0].id;
    let (ca0, cb0) = (clip(&mut ids, m, 0, 0, 10), clip(&mut ids, m, 20, 10, 10));
    let (a, b) = (ca0.id, cb0.id);
    p.sequences[0].tracks[0].clips = vec![ca0, cb0];
    let start = p.clone();
    let (ca, cb) = (
        p.sequences[0].tracks[0].clips[0].clone(),
        p.sequences[0].tracks[0].clips[1].clone(),
    );
    let mut h = History::new();
    // paste both as a group at 40: offsets kept
    let (na, nb) = (ClipId::new(&mut ids), ClipId::new(&mut ids));
    let paste = vec![
        Op::InsertClip {
            track: tr,
            clip: Clip {
                id: na,
                start: t(40),
                ..ca.clone()
            },
        },
        Op::InsertClip {
            track: tr,
            clip: Clip {
                id: nb,
                start: t(60),
                ..cb.clone()
            },
        },
    ];
    h.apply_batch(&mut p, paste, None).unwrap();
    assert_eq!(p.sequences[0].tracks[0].clips.len(), 4);
    p.validate().unwrap();
    // an overlapping paste is refused whole and changes nothing
    let before = p.clone();
    let bad = vec![
        Op::InsertClip {
            track: tr,
            clip: Clip {
                id: ClipId::new(&mut ids),
                start: t(100),
                ..ca.clone()
            },
        },
        Op::InsertClip {
            track: tr,
            clip: Clip {
                id: ClipId::new(&mut ids),
                start: t(45),
                ..cb.clone()
            },
        },
    ];
    assert!(h.apply_batch(&mut p, bad, None).is_err());
    assert_eq!(p, before);
    // cut = delete the originals, one step
    h.apply_batch(
        &mut p,
        vec![Op::Delete { clip: a }, Op::Delete { clip: b }],
        None,
    )
    .unwrap();
    assert_eq!(p.sequences[0].tracks[0].clips.len(), 2);
    assert!(h.undo(&mut p).unwrap()); // the cut
    assert_eq!(p, before);
    assert!(h.undo(&mut p).unwrap()); // the whole paste at once
    assert_eq!(p, start);
    assert!(!h.undo(&mut p).unwrap());
    assert!(h.redo(&mut p).unwrap());
    assert_eq!(p.sequences[0].tracks[0].clips.len(), 4);
}

/// Numeric timing (TL-02) is `TrimIn` / `TrimOut` to the typed boundary; the edit is exact in ticks and undoes in one step.
#[test]
fn numeric_trim_sets_exact_boundaries_and_undoes() {
    let (mut p, _, _, b) = two_clips(); // b: start 20, source_in 10, dur 10
    let start = p.clone();
    let mut h = History::new();
    h.apply(
        &mut p,
        Op::TrimOut {
            clip: b,
            end: t(26),
        },
        None,
    )
    .unwrap();
    h.apply(
        &mut p,
        Op::TrimIn {
            clip: b,
            start: t(22),
        },
        None,
    )
    .unwrap();
    let c = &p.sequences[0].tracks[0].clips[1];
    assert_eq!((c.start, c.source_in, c.duration), (t(22), t(12), t(4)));
    // a boundary at or beyond the other edge is refused and leaves the project alone
    let before = p.clone();
    assert!(h
        .apply(
            &mut p,
            Op::TrimOut {
                clip: b,
                end: t(22)
            },
            None
        )
        .is_err());
    assert_eq!(p, before);
    assert!(h.undo(&mut p).unwrap());
    assert!(h.undo(&mut p).unwrap());
    assert_eq!(p, start);
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
                new_link: None,
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
        11,
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
    assert_eq!(ops.len(), 18, "one example per Op variant");
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

#[test]
fn editor_evaluate_json_reports_layers_and_rejects_bad_input() {
    let mut e = Editor::from_project(base().0);
    let seq = e.project().sequences[0].id.to_string();
    let v: serde_json::Value =
        serde_json::from_str(&e.evaluate_json(&seq, 0, 16).unwrap()).unwrap();
    assert_eq!(v["frame"], 0);
    assert!(v["layers"].is_array() && v["audio"].is_array());
    assert!(e.evaluate_json("nope", 0, 0).is_err());
    assert!(e.evaluate_json(&"0".repeat(32), 0, 0).is_err());
}

// ---- M1-040: commit log, recovery, torn writes ----

fn pj(p: &Project) -> String {
    serde_json::to_string(p).unwrap()
}

/// A scripted session with edits, a coalesced drag, undo and redo. Returns the base, the log, and the project JSON after each record.
fn session() -> (Project, String, Vec<String>, Editor) {
    let (p, tr, a, b) = two_clips();
    let mut e = Editor::open(&pj(&p)).unwrap();
    let mut states = vec![pj(e.project())];
    let mut log = String::new();
    let mut step = |e: &mut Editor, f: &dyn Fn(&mut Editor)| {
        f(e);
        let new = e.take_log();
        for _ in new.lines() {
            states.push(pj(e.project()));
        }
        log.push_str(&new);
    };
    let mv = |c: ClipId, s: i64| {
        serde_json::to_string(&Op::Move {
            clip: c,
            track: tr,
            start: t(s),
        })
        .unwrap()
    };
    for s in [3, 4, 5] {
        step(&mut e, &|e| drop(e.apply_json(&mv(a, s), Some(9)).unwrap()));
    }
    step(&mut e, &|e| drop(e.apply_json(&mv(b, 40), None).unwrap()));
    step(&mut e, &|e| drop(e.undo_json().unwrap()));
    step(&mut e, &|e| drop(e.redo_json().unwrap()));
    step(&mut e, &|e| drop(e.undo_json().unwrap()));
    step(&mut e, &|e| {
        drop(
            e.apply_json(&format!("[{},{}]", mv(a, 6), mv(b, 50)), None)
                .unwrap(),
        )
    });
    (p, log, states, e)
}

#[test]
fn recovery_restores_the_document_and_the_whole_undo_history() {
    let (p, log, states, mut live) = session();
    assert_eq!(states.len(), 9);
    assert_eq!(live.seq(), 8);
    let (mut rec, info) = Editor::recover(Some(&pj(&p)), None, &log).unwrap();
    assert_eq!(
        (info.replayed, info.dropped, info.full_history),
        (8, 0, true)
    );
    assert_eq!(pj(rec.project()), pj(live.project()));
    assert_eq!(info.valid_log, log);
    // the recovered editor keeps logging where the crashed one stopped
    assert_eq!(rec.seq(), 8);
    assert_eq!(rec.take_log(), "");
    // undo walks back through the same steps the live editor would: the batch, then the (undone) step is gone from redo, etc.
    for _ in 0..8 {
        let l = live.undo_json().unwrap();
        let r = rec.undo_json().unwrap();
        assert_eq!(l, r);
        assert_eq!(pj(rec.project()), pj(live.project()));
    }
    assert_eq!(
        *rec.project(),
        p,
        "undo reached the start of the crashed session"
    );
}

#[test]
fn a_log_cut_at_every_byte_recovers_a_prefix_state() {
    let (p, log, states, _) = session();
    let base = pj(&p);
    for cut in 0..=log.len() {
        if !log.is_char_boundary(cut) {
            continue;
        }
        let part = &log[..cut];
        let (e, info) = Editor::recover(Some(&base), None, part).unwrap();
        let whole = part.matches('\n').count() as u64;
        // a final line cut exactly before its newline is still complete JSON and counts
        assert!(
            info.replayed == whole || info.replayed == whole + 1,
            "cut {cut}"
        );
        assert_eq!(pj(e.project()), states[info.replayed as usize], "cut {cut}");
        assert_eq!(e.seq(), info.replayed);
        assert!(log.starts_with(&info.valid_log));
    }
}

#[test]
fn corruption_in_the_middle_keeps_the_valid_prefix_and_reports_the_rest() {
    let (p, log, states, _) = session();
    let mut lines: Vec<String> = log.lines().map(String::from).collect();
    lines[4] = "{\"n\":5,\"r\":\"app".into(); // garbage
    let bad = lines.join("\n") + "\n";
    let (e, info) = Editor::recover(Some(&pj(&p)), None, &bad).unwrap();
    assert_eq!((info.replayed, info.dropped), (4, 4));
    assert_eq!(pj(e.project()), states[4]);
    // an out-of-sequence record ends the replay too
    let skipped = format!("{}\n{}\n", lines[0], lines[2]);
    let (_, info) = Editor::recover(Some(&pj(&p)), None, &skipped).unwrap();
    assert_eq!((info.replayed, info.dropped), (1, 1));
}

#[test]
fn a_checkpoint_stands_in_when_the_log_cannot_be_replayed_from_the_base() {
    let (p, log, states, live) = session();
    // checkpoint after record 7, then the log is damaged at record 3
    let (rec6, _) = Editor::recover(
        Some(&pj(&p)),
        None,
        &log.lines()
            .take(7)
            .map(|l| format!("{l}\n"))
            .collect::<String>(),
    )
    .unwrap();
    let cp = rec6.checkpoint_json();
    let mut lines: Vec<String> = log.lines().map(String::from).collect();
    lines[2] = "junk".into();
    let damaged = lines.join("\n") + "\n";
    // damaged log: records 3.. are unreachable even with a checkpoint (the log is not trustworthy past the damage)
    let (_, info) = Editor::recover(Some(&pj(&p)), Some(&cp), &damaged).unwrap();
    assert_eq!(info.replayed, 2);
    // intact log but a base that is gone: checkpoint + tail, undo reaches the checkpoint only
    let (e, info) = Editor::recover(None, Some(&cp), &log).unwrap();
    assert_eq!(
        (info.replayed, info.dropped, info.full_history),
        (8, 0, false)
    );
    assert_eq!(pj(e.project()), pj(live.project()));
    assert_eq!(states.len(), 9);
    // neither base nor checkpoint: a clear error, not a panic
    assert!(Editor::recover(None, None, &log).is_err());
    assert!(Editor::recover(Some("{}"), Some("nope"), &log).is_err());
}

#[test]
fn set_media_records_a_fingerprint_and_relinks_and_undoes() {
    let (mut p, mut ids) = base();
    let m = p.media[0].id;
    let fp = format!("b3-64k:100:{}", "0".repeat(64));
    let mut h = History::new();
    let op = |uri: &str, hash: Option<&str>| Op::SetMedia {
        media: m,
        uri: uri.into(),
        hash: hash.map(String::from),
    };
    h.apply(&mut p, op("media/a.mp4", Some(&fp)), None).unwrap();
    h.apply(&mut p, op("elsewhere/a.mp4", Some(&fp)), None)
        .unwrap();
    assert_eq!(p.media[0].uri, "elsewhere/a.mp4");
    h.undo(&mut p).unwrap();
    assert_eq!(p.media[0].uri, "media/a.mp4");
    assert_eq!(p.media[0].hash.as_deref(), Some(fp.as_str()));
    for bad in [op("", None), op("x", Some("not-a-fingerprint"))] {
        assert!(
            matches!(h.apply(&mut p, bad, None), Err(OpError::Batch { cause, .. }) if *cause == OpError::BadMediaRef)
        );
    }
    let ghost = Op::SetMedia {
        media: MediaId::new(&mut ids),
        uri: "x".into(),
        hash: None,
    };
    assert!(
        matches!(h.apply(&mut p, ghost, None), Err(OpError::Batch { cause, .. }) if matches!(*cause, OpError::UnknownMediaId(_)))
    );
}

/// M1-040 recovery cost: replaying a long session. Numbers print with `--nocapture`; the bound is generous, the number is what matters.
#[test]
fn recovery_time_for_a_long_session() {
    let (p, tr, a, _) = two_clips();
    let mut e = Editor::open(&pj(&p)).unwrap();
    let mut log = String::new();
    for i in 0..20_000i64 {
        let op = serde_json::to_string(&Op::Move {
            clip: a,
            track: tr,
            start: t(i % 7 + 1),
        })
        .unwrap();
        e.apply_json(&op, Some(1 + (i / 50) as u32)).unwrap();
        log.push_str(&e.take_log());
    }
    let t0 = std::time::Instant::now();
    let (r, info) = Editor::recover(Some(&pj(&p)), None, &log).unwrap();
    let ms = t0.elapsed().as_secs_f64() * 1000.0;
    println!(
        "recovered {} records ({} KiB of log) in {ms:.0} ms",
        info.replayed,
        log.len() / 1024
    );
    assert_eq!(pj(r.project()), pj(e.project()));
    assert!(ms < 20_000.0);
}

#[test]
fn import_ops_add_media_and_set_the_sequence_format_and_undo() {
    let (mut p, mut ids) = base();
    let mut h = History::new();
    let before = p.clone();
    let new = MediaRef {
        id: MediaId::new(&mut ids),
        kind: MediaKind::Video,
        name: "a.mp4".into(),
        uri: "file:a.mp4:1".into(),
        hash: None,
        duration: Some(Time::from_ticks(1000)),
        tags: vec![],
    };
    let seq = p.sequences[0].id;
    let fmt = Op::SetSequenceFormat {
        sequence: seq,
        frame_rate: Rational::new(24000, 1001).unwrap(),
        resolution: Resolution {
            width: 1080,
            height: 1920,
        },
    };
    // one undo step for both, the way import applies them
    h.apply_batch(&mut p, vec![Op::AddMedia { media: new.clone() }, fmt], None)
        .unwrap();
    assert_eq!(p.media.last().unwrap(), &new);
    assert_eq!(p.sequences[0].resolution.width, 1080);
    h.undo(&mut p).unwrap();
    assert_eq!(p, before);
    h.redo(&mut p).unwrap();
    assert_eq!(p.media.len(), before.media.len() + 1);
    // duplicate id, empty uri, bad format, removing media a clip uses
    let dup = Op::AddMedia { media: new.clone() };
    assert!(h.apply(&mut p, dup, None).is_err());
    let mut empty = new.clone();
    empty.id = MediaId::new(&mut ids);
    empty.uri.clear();
    assert!(h
        .apply(&mut p, Op::AddMedia { media: empty }, None)
        .is_err());
    let (tr, clip) = {
        let t = &p.sequences[0].tracks[0];
        (t.id, t.clips.first().cloned())
    };
    if let Some(c) = clip {
        let used = c.media;
        assert!(h
            .apply(&mut p, Op::RemoveMedia { media: used }, None)
            .is_err());
    } else {
        // base() has no clips: put one on the new media, then removing that media must be refused
        let m = p.media.last().unwrap().id;
        let c = Clip {
            id: ClipId::new(&mut ids),
            media: m,
            start: Time::from_ticks(0),
            source_in: Time::from_ticks(0),
            duration: Time::from_ticks(500),
            speed: Rational::new(1, 1).unwrap(),
            link: None,
        };
        h.apply(&mut p, Op::InsertClip { track: tr, clip: c }, None)
            .unwrap();
        assert!(h.apply(&mut p, Op::RemoveMedia { media: m }, None).is_err());
    }
}

#[test]
fn set_media_tags_is_undoable_validated_and_survives_the_file_format() {
    let (mut p, _) = base();
    let m = p.media[0].id;
    let before = p.clone();
    let mut h = History::new();
    let tags = vec!["b-roll".to_string(), "Interview".to_string()];
    h.apply(
        &mut p,
        Op::SetMediaTags {
            media: m,
            tags: tags.clone(),
        },
        None,
    )
    .unwrap();
    assert_eq!(p.media[0].tags, tags);
    let json = serde_json::to_string(&p).unwrap();
    assert_eq!(serde_json::from_str::<Project>(&json).unwrap(), p);
    h.undo(&mut p).unwrap();
    assert_eq!(p, before);
    assert!(
        !serde_json::to_string(&p).unwrap().contains("tags"),
        "no tags = no key, old files stay identical"
    );
    h.redo(&mut p).unwrap();
    let after = p.clone();
    let long = "x".repeat(41);
    let many: Vec<String> = (0..17).map(|i| format!("t{i}")).collect();
    for bad in [
        vec![String::new()],
        vec![" pad".to_string()],
        vec!["a".to_string(), "A".to_string()],
        vec![long],
        many,
    ] {
        assert!(h
            .apply(
                &mut p,
                Op::SetMediaTags {
                    media: m,
                    tags: bad
                },
                None
            )
            .is_err());
    }
    assert_eq!(p, after, "a refused edit changes nothing");
    let unknown = MediaId::new(&mut SeqIds::default());
    assert!(h
        .apply(
            &mut p,
            Op::SetMediaTags {
                media: unknown,
                tags: vec![]
            },
            None
        )
        .is_err());
}

#[test]
fn set_canvas_is_one_undoable_step_and_validates() {
    let (mut p, mut ids) = base();
    let seq = p.sequences[0].id;
    let before = p.clone();
    let mut h = History::new();
    let op = Op::SetCanvas {
        sequence: seq,
        frame_rate: Rational::new(25, 1).unwrap(),
        resolution: Resolution {
            width: 1080,
            height: 1350,
        },
        size_fixed: true,
        rate_fixed: false,
    };
    h.apply(&mut p, op.clone(), None).unwrap();
    let s = &p.sequences[0];
    assert_eq!((s.resolution.width, s.resolution.height), (1080, 1350));
    assert_eq!(s.frame_rate, Rational::new(25, 1).unwrap());
    assert!(s.size_fixed && !s.rate_fixed);
    p.validate().unwrap();
    h.undo(&mut p).unwrap();
    assert_eq!(p, before, "undo restores size, rate and both flags");
    h.redo(&mut p).unwrap();
    assert!(p.sequences[0].size_fixed);
    // refused without touching anything
    let after = p.clone();
    for bad in [
        Op::SetCanvas {
            sequence: seq,
            frame_rate: Rational::new(25, 1).unwrap(),
            resolution: Resolution {
                width: 0,
                height: 1080,
            },
            size_fixed: true,
            rate_fixed: true,
        },
        Op::SetCanvas {
            sequence: seq,
            frame_rate: Rational::new(25, 1).unwrap(),
            resolution: Resolution {
                width: 100_000,
                height: 1080,
            },
            size_fixed: true,
            rate_fixed: true,
        },
    ] {
        assert!(h.apply(&mut p, bad, None).is_err());
    }
    let unknown = Op::SetCanvas {
        sequence: app_model::SequenceId::new(&mut ids),
        frame_rate: Rational::new(25, 1).unwrap(),
        resolution: Resolution {
            width: 1080,
            height: 1350,
        },
        size_fixed: true,
        rate_fixed: true,
    };
    assert!(h.apply(&mut p, unknown, None).is_err());
    assert_eq!(p, after);
}

// ---- Linked picture and sound (TL-05): one link id on the clips of one import ------------------------------------------------------

/// V1 clip `a` (0..10 of the 100-unit video) and the sound of the same stretch on A1, both with one link; plus an unlinked clip `c` after them.
fn linked_pair() -> (Project, SeqIds, [ClipId; 3], LinkId) {
    let (mut p, mut ids) = base();
    let m = p.media[0].id;
    let link = LinkId::new(&mut ids);
    let mut pic = clip(&mut ids, m, 0, 0, 10);
    let mut snd = clip(&mut ids, m, 0, 0, 10);
    let other = clip(&mut ids, m, 20, 10, 10);
    pic.link = Some(link);
    snd.link = Some(link);
    let (pi, si, oi) = (pic.id, snd.id, other.id);
    p.sequences[0].tracks[0].clips = vec![pic, other];
    p.sequences[0].tracks[2].clips = vec![snd];
    p.validate().unwrap();
    (p, ids, [pi, si, oi], link)
}

fn find(p: &Project, id: ClipId) -> Clip {
    p.sequences[0]
        .tracks
        .iter()
        .flat_map(|t| &t.clips)
        .find(|c| c.id == id)
        .cloned()
        .unwrap()
}

#[test]
fn splitting_both_halves_of_a_link_keeps_the_pieces_linked_pairwise_and_undoes_in_one_step() {
    let (mut p, mut ids, [pic, snd, _], link) = linked_pair();
    let before = p.clone();
    let (rp, rs, fresh) = (
        ClipId::new(&mut ids),
        ClipId::new(&mut ids),
        LinkId::new(&mut ids),
    );
    let mut h = History::new();
    h.apply_batch(
        &mut p,
        vec![
            Op::Split {
                clip: pic,
                at: t(4),
                new_id: rp,
                new_link: Some(fresh),
            },
            Op::Split {
                clip: snd,
                at: t(4),
                new_id: rs,
                new_link: Some(fresh),
            },
        ],
        None,
    )
    .unwrap();
    assert_eq!(
        (find(&p, pic).link, find(&p, snd).link),
        (Some(link), Some(link)),
        "the left pieces keep the old link"
    );
    assert_eq!(
        (find(&p, rp).link, find(&p, rs).link),
        (Some(fresh), Some(fresh)),
        "the right pieces share the new one"
    );
    assert_ne!(link, fresh);
    assert!(h.undo(&mut p).unwrap());
    assert_eq!(p, before, "one undo puts both halves back");
}

#[test]
fn a_split_gives_the_right_part_a_link_only_when_the_clip_was_linked() {
    let (mut p, mut ids, [pic, _, other], _) = linked_pair();
    let (r1, r2, fresh) = (
        ClipId::new(&mut ids),
        ClipId::new(&mut ids),
        LinkId::new(&mut ids),
    );
    // Linked clip, no new_link given (its partner is not split): the right part is alone.
    apply(
        &mut p,
        Op::Split {
            clip: pic,
            at: t(4),
            new_id: r1,
            new_link: None,
        },
    )
    .unwrap();
    assert_eq!(find(&p, r1).link, None);
    // Unlinked clip: a new_link is ignored.
    apply(
        &mut p,
        Op::Split {
            clip: other,
            at: t(24),
            new_id: r2,
            new_link: Some(fresh),
        },
    )
    .unwrap();
    assert_eq!((find(&p, other).link, find(&p, r2).link), (None, None));
}

#[test]
fn set_link_unlinks_and_relinks_and_undoes() {
    let (mut p, _, [pic, snd, _], link) = linked_pair();
    let mut h = History::new();
    h.apply(
        &mut p,
        Op::SetLink {
            clip: snd,
            link: None,
        },
        None,
    )
    .unwrap();
    assert_eq!((find(&p, pic).link, find(&p, snd).link), (Some(link), None));
    h.apply(
        &mut p,
        Op::SetLink {
            clip: snd,
            link: Some(link),
        },
        None,
    )
    .unwrap();
    assert_eq!(find(&p, snd).link, Some(link));
    h.undo(&mut p).unwrap();
    h.undo(&mut p).unwrap();
    assert_eq!(
        find(&p, snd).link,
        Some(link),
        "undoing both steps goes back to linked"
    );
    assert!(matches!(
        apply(
            &mut p,
            Op::SetLink {
                clip: ClipId(app_model::Id::from_u128(77)),
                link: None
            }
        ),
        Err(OpError::UnknownClip(_))
    ));
}

#[test]
fn trim_move_and_delete_of_both_halves_are_one_undo_step_and_undo_restores_the_link() {
    let (mut p, _, [pic, snd, _], link) = linked_pair();
    let before = p.clone();
    let (v1, a1) = (p.sequences[0].tracks[0].id, p.sequences[0].tracks[2].id);
    let mut h = History::new();
    // Cut the front of both (trim_in) in one step: picture and sound stay in sync.
    h.apply_batch(
        &mut p,
        vec![
            Op::TrimIn {
                clip: pic,
                start: t(3),
            },
            Op::TrimIn {
                clip: snd,
                start: t(3),
            },
        ],
        None,
    )
    .unwrap();
    let (a, b) = (find(&p, pic), find(&p, snd));
    assert_eq!(
        (a.start, a.source_in, a.duration),
        (b.start, b.source_in, b.duration)
    );
    // Move both.
    h.apply_batch(
        &mut p,
        vec![
            Op::Move {
                clip: pic,
                track: v1,
                start: t(5),
            },
            Op::Move {
                clip: snd,
                track: a1,
                start: t(5),
            },
        ],
        None,
    )
    .unwrap();
    assert_eq!((find(&p, pic).start, find(&p, snd).start), (t(5), t(5)));
    // Delete both.
    h.apply_batch(
        &mut p,
        vec![Op::Delete { clip: pic }, Op::Delete { clip: snd }],
        None,
    )
    .unwrap();
    assert!(p.sequences[0].tracks[2].clips.is_empty());
    h.undo(&mut p).unwrap();
    assert_eq!(
        (find(&p, pic).link, find(&p, snd).link),
        (Some(link), Some(link)),
        "undoing a delete brings the link back"
    );
    h.undo(&mut p).unwrap();
    h.undo(&mut p).unwrap();
    assert_eq!(p, before);
}

#[test]
fn a_batch_that_fails_on_one_half_leaves_both_untouched() {
    let (mut p, _, [pic, snd, _], _) = linked_pair();
    let before = p.clone();
    // The sound may be trimmed to t(3), the picture beyond its end may not: nothing changes.
    let r = History::new().apply_batch(
        &mut p,
        vec![
            Op::TrimIn {
                clip: snd,
                start: t(3),
            },
            Op::TrimIn {
                clip: pic,
                start: t(30),
            },
        ],
        None,
    );
    assert!(r.is_err());
    assert_eq!(p, before);
}

#[test]
fn a_link_whose_partner_is_gone_is_harmless() {
    let (mut p, _, [pic, snd, _], link) = linked_pair();
    apply(&mut p, Op::Delete { clip: snd }).unwrap();
    p.validate().unwrap();
    assert_eq!(
        find(&p, pic).link,
        Some(link),
        "the survivor keeps its (now single) link and edits alone"
    );
    apply(
        &mut p,
        Op::TrimOut {
            clip: pic,
            end: t(8),
        },
    )
    .unwrap();
}

// ---- Save then open: an edited project comes back identical (M1 round trip) ---------------------------------------------------------

fn sequence_end(p: &Project) -> i64 {
    p.sequences[0]
        .tracks
        .iter()
        .flat_map(|t| &t.clips)
        .map(|c| c.start.ticks() + c.duration.ticks())
        .max()
        .unwrap_or(0)
}

#[test]
fn a_saved_and_reopened_project_has_the_same_timeline_and_length() {
    let (mut p, mut ids) = base();
    let (video, still) = (p.media[0].id, p.media[2].id);
    let (v1, a1) = (p.sequences[0].tracks[0].id, p.sequences[0].tracks[2].id);
    let mut h = History::new();
    // A 30-unit clip, cut twice, its middle piece deleted (a gap), a still after it, and a linked picture + sound pair further on.
    let long = clip(&mut ids, video, 0, 0, 30);
    let long_id = long.id;
    h.apply(
        &mut p,
        Op::InsertClip {
            track: v1,
            clip: long,
        },
        None,
    )
    .unwrap();
    let (mid, last) = (ClipId::new(&mut ids), ClipId::new(&mut ids));
    h.apply(
        &mut p,
        Op::Split {
            clip: long_id,
            at: t(20),
            new_id: last,
            new_link: None,
        },
        None,
    )
    .unwrap();
    h.apply(
        &mut p,
        Op::Split {
            clip: long_id,
            at: t(10),
            new_id: mid,
            new_link: None,
        },
        None,
    )
    .unwrap();
    h.apply(&mut p, Op::Delete { clip: mid }, None).unwrap();
    let still_clip = clip(&mut ids, still, 40, 0, 5);
    h.apply(
        &mut p,
        Op::InsertClip {
            track: v1,
            clip: still_clip,
        },
        None,
    )
    .unwrap();
    let link = LinkId::new(&mut ids);
    for track in [v1, a1] {
        let mut c = clip(&mut ids, video, 50, 0, 8);
        c.link = Some(link);
        h.apply(&mut p, Op::InsertClip { track, clip: c }, None)
            .unwrap();
    }
    let json = serde_json::to_string(&p).unwrap();
    let bytes = app_model::file::save_bytes(&json, &[]).unwrap();
    let reopened = app_model::file::ProjectFile::read(&bytes).unwrap();
    let q = reopened.project();
    assert_eq!(*q, p, "every clip, link, gap and still comes back as saved");
    assert_eq!(sequence_end(q), sequence_end(&p));
    assert_eq!(
        sequence_end(q),
        t(58).ticks(),
        "the export length is the end of the last clip"
    );
    for at in [0, 5, 10, 15, 25, 42, 51, 57, 58] {
        assert_eq!(
            evaluate(&q.sequences[0], t(at), 0),
            evaluate(&p.sequences[0], t(at), 0),
            "frame description at {at} differs"
        );
    }
    // Saving the reopened file again is stable.
    let again = app_model::file::save_bytes(&serde_json::to_string(q).unwrap(), &bytes).unwrap();
    assert_eq!(
        app_model::file::ProjectFile::read(&again)
            .unwrap()
            .project(),
        &p
    );
}

// ---- M2-002: tracks ----

fn new_track(ids: &mut SeqIds, kind: TrackKind, name: &str) -> Track {
    Track {
        id: TrackId::new(ids),
        kind,
        name: name.into(),
        muted: false,
        locked: false,
        hidden: false,
        solo: false,
        height: None,
        colour: None,
        clips: vec![],
    }
}

/// A `SetTrackProps` patch under construction: name only what changes.
#[derive(Default)]
struct P {
    name: Option<String>,
    muted: Option<bool>,
    solo: Option<bool>,
    locked: Option<bool>,
    hidden: Option<bool>,
    height: Option<Option<u32>>,
    colour: Option<Option<String>>,
}

impl P {
    fn op(self, track: TrackId) -> Op {
        Op::SetTrackProps {
            track,
            name: self.name,
            muted: self.muted,
            solo: self.solo,
            locked: self.locked,
            hidden: self.hidden,
            height: self.height,
            colour: self.colour,
        }
    }
}

fn props(track: TrackId) -> Op {
    P::default().op(track)
}

#[test]
fn add_move_and_remove_a_track_and_each_undoes_exactly() {
    let (mut p, mut ids) = base(); // V1, V2, A1 (bottom to top)
    let before = p.clone();
    let seq = p.sequences[0].id;
    let v3 = new_track(&mut ids, TrackKind::Video, "V3");
    let id = v3.id;
    let inv = apply(
        &mut p,
        Op::AddTrack {
            sequence: seq,
            track: v3,
            index: 3,
        },
    )
    .unwrap();
    assert_eq!(p.sequences[0].tracks.len(), 4);
    assert_eq!(p.sequences[0].tracks[3].id, id);
    p.validate().unwrap();
    let after_add = p.clone();

    // Lift it to the bottom, then back.
    let inv_move = apply(
        &mut p,
        Op::MoveTrack {
            track: id,
            index: 0,
        },
    )
    .unwrap();
    assert_eq!(p.sequences[0].tracks[0].id, id);
    apply_all(&mut p, &inv_move.0).unwrap();
    assert_eq!(p, after_add);

    // Removing a track with clips takes them along and undo restores them, in place.
    let tr = p.sequences[0].tracks[0].id;
    let m = p.media[0].id;
    let c = clip(&mut ids, m, 0, 0, 10);
    apply(&mut p, Op::InsertClip { track: tr, clip: c }).unwrap();
    let with_clip = p.clone();
    let inv_rm = apply(&mut p, Op::RemoveTrack { track: tr }).unwrap();
    assert_eq!(p.sequences[0].tracks.len(), 3);
    assert!(p.sequences[0].tracks.iter().all(|t| t.clips.is_empty()));
    apply_all(&mut p, &inv_rm.0).unwrap();
    assert_eq!(p, with_clip);

    apply_all(&mut p, &[]).unwrap();
    let c_id = p.sequences[0].tracks[0].clips[0].id;
    apply(&mut p, Op::Delete { clip: c_id }).unwrap();
    apply_all(&mut p, &inv.0).unwrap();
    assert_eq!(p.sequences[0].tracks.len(), 3);
    assert_eq!(
        p.sequences[0].tracks[0].id,
        before.sequences[0].tracks[0].id
    );
}

#[test]
fn track_ops_reject_what_they_must_and_leave_the_project_alone() {
    let (p, mut ids) = base();
    let seq = p.sequences[0].id;
    let t0 = p.sequences[0].tracks[0].id;
    let cases: Vec<Case> = vec![
        (
            "unknown sequence",
            Op::AddTrack {
                sequence: SequenceId::new(&mut ids),
                track: new_track(&mut ids, TrackKind::Video, "X"),
                index: 0,
            },
            |e| matches!(e, OpError::UnknownSequence(_)),
        ),
        (
            "index past the top",
            Op::AddTrack {
                sequence: seq,
                track: new_track(&mut ids, TrackKind::Video, "X"),
                index: 4,
            },
            |e| matches!(e, OpError::BadTrackIndex),
        ),
        (
            "id already used",
            Op::AddTrack {
                sequence: seq,
                track: Track {
                    id: t0,
                    ..new_track(&mut ids, TrackKind::Video, "X")
                },
                index: 0,
            },
            |e| matches!(e, OpError::IdInUse(_)),
        ),
        (
            "empty name",
            Op::AddTrack {
                sequence: seq,
                track: new_track(&mut ids, TrackKind::Video, ""),
                index: 0,
            },
            |e| matches!(e, OpError::BadTrack),
        ),
        (
            "move past the top",
            Op::MoveTrack {
                track: t0,
                index: 3,
            },
            |e| matches!(e, OpError::BadTrackIndex),
        ),
        (
            "unknown track",
            Op::MoveTrack {
                track: TrackId::new(&mut ids),
                index: 0,
            },
            |e| matches!(e, OpError::UnknownTrack(_)),
        ),
        (
            "name with edge spaces",
            P {
                name: Some(" V1".into()),
                ..P::default()
            }
            .op(t0),
            |e| matches!(e, OpError::BadTrack),
        ),
        (
            "name too long",
            P {
                name: Some("x".repeat(65)),
                ..P::default()
            }
            .op(t0),
            |e| matches!(e, OpError::BadTrack),
        ),
        (
            "height too small",
            P {
                height: Some(Some(5)),
                ..P::default()
            }
            .op(t0),
            |e| matches!(e, OpError::BadTrack),
        ),
        (
            "height too big",
            P {
                height: Some(Some(401)),
                ..P::default()
            }
            .op(t0),
            |e| matches!(e, OpError::BadTrack),
        ),
        (
            "bad colour",
            P {
                colour: Some(Some("red".into())),
                ..P::default()
            }
            .op(t0),
            |e| matches!(e, OpError::BadTrack),
        ),
        (
            "bad prop does not half-apply a good one",
            P {
                muted: Some(true),
                colour: Some(Some("#12".into())),
                ..P::default()
            }
            .op(t0),
            |e| matches!(e, OpError::BadTrack),
        ),
    ];
    for (name, op, ok) in cases {
        let mut q = p.clone();
        let err = apply(&mut q, op).expect_err(name);
        assert!(ok(&err), "{name}: wrong error {err:?}");
        assert_eq!(q, p, "{name}: the project changed");
    }
}

#[test]
fn a_locked_track_cannot_be_removed_but_can_be_unlocked_and_the_stack_is_capped() {
    let (mut p, mut ids) = base();
    let t = p.sequences[0].tracks[0].id;
    apply(
        &mut p,
        P {
            locked: Some(true),
            ..P::default()
        }
        .op(t),
    )
    .unwrap();
    assert!(matches!(
        apply(&mut p, Op::RemoveTrack { track: t }),
        Err(OpError::TrackLocked(_))
    ));
    // Reordering and restyling a locked track is fine; it is the clips that are protected.
    apply(&mut p, Op::MoveTrack { track: t, index: 2 }).unwrap();
    apply(
        &mut p,
        P {
            locked: Some(false),
            ..P::default()
        }
        .op(t),
    )
    .unwrap();
    apply(&mut p, Op::RemoveTrack { track: t }).unwrap();

    let seq = p.sequences[0].id;
    while p.sequences[0].tracks.len() < MAX_TRACKS {
        let track = new_track(&mut ids, TrackKind::Audio, "A");
        apply(
            &mut p,
            Op::AddTrack {
                sequence: seq,
                track,
                index: 0,
            },
        )
        .unwrap();
    }
    let one_more = new_track(&mut ids, TrackKind::Audio, "A");
    assert!(matches!(
        apply(
            &mut p,
            Op::AddTrack {
                sequence: seq,
                track: one_more,
                index: 0
            }
        ),
        Err(OpError::TooManyTracks)
    ));
}

#[test]
fn add_track_with_clips_checks_them_like_insert_clip() {
    let (mut p, mut ids) = base();
    let seq = p.sequences[0].id;
    let m = p.media[0].id;
    let mut t = new_track(&mut ids, TrackKind::Video, "V3");
    t.clips = vec![clip(&mut ids, m, 0, 0, 10), clip(&mut ids, m, 5, 0, 10)];
    let before = p.clone();
    assert!(matches!(
        apply(
            &mut p,
            Op::AddTrack {
                sequence: seq,
                track: t.clone(),
                index: 0
            }
        ),
        Err(OpError::Overlap { .. })
    ));
    t.clips[1] = Clip {
        start: Time::from_ticks(10 * U),
        ..t.clips[1].clone()
    };
    let audio_only = p.media[1].id;
    let mut bad_kind = t.clone();
    bad_kind.clips[0].media = audio_only;
    assert!(matches!(
        apply(
            &mut p,
            Op::AddTrack {
                sequence: seq,
                track: bad_kind,
                index: 0
            }
        ),
        Err(OpError::KindMismatch)
    ));
    let mut dup = t.clone();
    dup.clips[1].id = dup.clips[0].id;
    assert!(matches!(
        apply(
            &mut p,
            Op::AddTrack {
                sequence: seq,
                track: dup,
                index: 0
            }
        ),
        Err(OpError::IdInUse(_))
    ));
    assert_eq!(p, before);
    apply(
        &mut p,
        Op::AddTrack {
            sequence: seq,
            track: t,
            index: 0,
        },
    )
    .unwrap();
    p.validate().unwrap();
}

#[test]
fn set_track_props_patches_only_what_it_names_resets_and_undoes_in_one_step() {
    let (mut p, _) = base();
    let t = p.sequences[0].tracks[1].id;
    let before = p.clone();
    let inv = apply(
        &mut p,
        P {
            name: Some("Titles".into()),
            muted: Some(true),
            solo: Some(true),
            hidden: Some(true),
            height: Some(Some(80)),
            colour: Some(Some("#FF8800".into())),
            ..P::default()
        }
        .op(t),
    )
    .unwrap();
    let tr = &p.sequences[0].tracks[1];
    assert_eq!(
        (
            tr.name.as_str(),
            tr.muted,
            tr.solo,
            tr.hidden,
            tr.locked,
            tr.height
        ),
        ("Titles", true, true, true, false, Some(80))
    );
    assert_eq!(tr.colour.as_deref(), Some("#FF8800"));
    let after = p.clone();
    apply_all(&mut p, &inv.0).unwrap();
    assert_eq!(p, before);
    apply(&mut p, after_ops(t)).unwrap();
    // `null` resets height and colour to the default.
    apply(
        &mut p,
        P {
            height: Some(None),
            colour: Some(None),
            ..P::default()
        }
        .op(t),
    )
    .unwrap();
    let tr = &p.sequences[0].tracks[1];
    assert!(tr.height.is_none() && tr.colour.is_none() && tr.hidden);
    // A no-op patch is valid and its inverse is a no-op.
    let snapshot = p.clone();
    let inv = apply(&mut p, props(t)).unwrap();
    apply_all(&mut p, &inv.0).unwrap();
    assert_eq!(p, snapshot);
    let _ = after;
}

fn after_ops(t: TrackId) -> Op {
    P {
        hidden: Some(true),
        height: Some(Some(80)),
        colour: Some(Some("#FF8800".into())),
        ..P::default()
    }
    .op(t)
}

#[test]
fn set_track_props_wire_format_distinguishes_absent_null_and_value() {
    let t = "00000000000000000000000000000003";
    let op: Op =
        serde_json::from_value(serde_json::json!({"op":"set_track_props","track":t,"muted":true}))
            .unwrap();
    let Op::SetTrackProps {
        muted,
        height,
        colour,
        name,
        ..
    } = &op
    else {
        panic!()
    };
    assert_eq!(
        (*muted, *height, colour.clone(), name.clone()),
        (Some(true), None, None, None)
    );
    let op: Op = serde_json::from_value(
        serde_json::json!({"op":"set_track_props","track":t,"height":null,"colour":"#112233"}),
    )
    .unwrap();
    let Op::SetTrackProps { height, colour, .. } = &op else {
        panic!()
    };
    assert_eq!(
        (*height, colour.clone()),
        (Some(None), Some(Some("#112233".to_string())))
    );
    // And it writes back the same way.
    assert_eq!(
        serde_json::to_value(&op).unwrap(),
        serde_json::json!({"op":"set_track_props","track":t,"height":null,"colour":"#112233"})
    );
}

#[test]
fn evaluate_honours_hide_mute_and_solo_per_kind() {
    use crate::evaluate::evaluate;
    let (mut p, mut ids) = base(); // V1, V2, A1
    let m = p.media[0].id; // video media with audio
    for ti in [0usize, 1] {
        let tid = p.sequences[0].tracks[ti].id;
        let c = clip(&mut ids, m, 0, 0, 10);
        apply(
            &mut p,
            Op::InsertClip {
                track: tid,
                clip: c,
            },
        )
        .unwrap();
    }
    let a_id = p.sequences[0].tracks[2].id;
    let ac = clip(&mut ids, m, 0, 0, 10);
    apply(
        &mut p,
        Op::InsertClip {
            track: a_id,
            clip: ac,
        },
    )
    .unwrap();
    let (v1, v2) = (p.sequences[0].tracks[0].id, p.sequences[0].tracks[1].id);
    let layers = |p: &Project| {
        evaluate(&p.sequences[0], Time::from_ticks(U), 480)
            .layers
            .iter()
            .map(|l| l.track)
            .collect::<Vec<_>>()
    };
    let audio = |p: &Project| {
        evaluate(&p.sequences[0], Time::from_ticks(U), 480)
            .audio
            .len()
    };
    assert_eq!(layers(&p), vec![v1, v2]);
    assert_eq!(audio(&p), 1);

    apply(
        &mut p,
        P {
            hidden: Some(true),
            ..P::default()
        }
        .op(v2),
    )
    .unwrap();
    assert_eq!(layers(&p), vec![v1], "a hidden track is not drawn");
    apply(
        &mut p,
        P {
            hidden: Some(false),
            muted: Some(true),
            ..P::default()
        }
        .op(v2),
    )
    .unwrap();
    assert_eq!(
        layers(&p),
        vec![v1],
        "a muted video track is not drawn either"
    );
    apply(
        &mut p,
        P {
            muted: Some(false),
            solo: Some(true),
            ..P::default()
        }
        .op(v2),
    )
    .unwrap();
    assert_eq!(
        layers(&p),
        vec![v2],
        "solo shows only the soloed track of its kind"
    );
    assert_eq!(audio(&p), 1, "a video solo does not silence audio tracks");
    apply(
        &mut p,
        P {
            solo: Some(true),
            ..P::default()
        }
        .op(v1),
    )
    .unwrap();
    assert_eq!(
        layers(&p),
        vec![v1, v2],
        "two solos both show, in stack order"
    );
    apply(
        &mut p,
        P {
            hidden: Some(true),
            ..P::default()
        }
        .op(v1),
    )
    .unwrap();
    assert_eq!(layers(&p), vec![v2], "hide wins over solo");
    apply(
        &mut p,
        P {
            solo: Some(true),
            ..P::default()
        }
        .op(a_id),
    )
    .unwrap();
    apply(
        &mut p,
        P {
            muted: Some(true),
            ..P::default()
        }
        .op(a_id),
    )
    .unwrap();
    assert_eq!(audio(&p), 0, "mute wins over solo");
    // Reordering the stack changes the draw order and nothing else.
    apply(
        &mut p,
        P {
            hidden: Some(false),
            ..P::default()
        }
        .op(v1),
    )
    .unwrap();
    apply(
        &mut p,
        Op::MoveTrack {
            track: v1,
            index: 1,
        },
    )
    .unwrap();
    assert_eq!(layers(&p), vec![v2, v1]);
}
