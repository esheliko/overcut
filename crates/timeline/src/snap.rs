//! Snapping (TL-03, M2-009, `docs/features/snapping.md`): pull a time to the nearest target within a tolerance.
//! Pure and allocation-free over a slice of targets; one linear pass, so 20 tracks x 1000 clips costs microseconds.

use app_model::{ClipId, Sequence, Time};
use serde::{Deserialize, Serialize};

/// What a target is. When two targets are equally near the higher-priority kind wins: playhead, marker, clip edge.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetKind {
    Playhead,
    Marker,
    ClipEdge,
}

impl TargetKind {
    fn rank(self) -> u8 {
        match self {
            TargetKind::Playhead => 0,
            TargetKind::Marker => 1,
            TargetKind::ClipEdge => 2,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Target {
    pub time: Time,
    pub kind: TargetKind,
}

/// The result: where the time ends up and what it snapped to (`None` = nothing in range, `time` is the input).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snap {
    pub time: Time,
    pub hit: Option<Target>,
}

fn better(t: Time, a: Target, than: Target) -> bool {
    let (da, db) = (dist(t, a.time), dist(t, than.time));
    (da, a.kind.rank(), a.time) < (db, than.kind.rank(), than.time)
}

fn dist(a: Time, b: Time) -> i64 {
    a.ticks().saturating_sub(b.ticks()).saturating_abs()
}

/// The nearest target to `t` within `tolerance` ticks (inclusive). Ties: nearer, then playhead > marker > clip edge, then earlier.
/// `tolerance < 0` or no targets: no snap.
pub fn snap(t: Time, targets: &[Target], tolerance: Time) -> Snap {
    let tol = tolerance.ticks();
    let mut best: Option<Target> = None;
    for &c in targets {
        if tol >= 0 && dist(t, c.time) <= tol && best.is_none_or(|b| better(t, c, b)) {
            best = Some(c);
        }
    }
    Snap {
        time: best.map_or(t, |b| b.time),
        hit: best,
    }
}

/// Snap a span `[start, start + len]` (a clip being dragged): either edge may snap; the one that moves less wins (start edge on a tie).
/// `time` is the new START; the span keeps its length.
pub fn snap_span(start: Time, len: Time, targets: &[Target], tolerance: Time) -> Snap {
    let a = snap(start, targets, tolerance);
    let end = Time::from_ticks(start.ticks().saturating_add(len.ticks()));
    let b = snap(end, targets, tolerance);
    match (a.hit, b.hit) {
        (Some(_), Some(hb)) if dist(end, hb.time) < dist(start, a.time) => Snap {
            time: Time::from_ticks(hb.time.ticks().saturating_sub(len.ticks())),
            hit: b.hit,
        },
        (None, Some(hb)) => Snap {
            time: Time::from_ticks(hb.time.ticks().saturating_sub(len.ticks())),
            hit: b.hit,
        },
        _ => a,
    }
}

/// Targets of a sequence: both edges of every clip (except the ones in `exclude`, e.g. the clips being dragged), the playhead, the
/// sequence's own markers and chapters (M2-007) and any extra `markers` the caller passes (times only).
pub fn targets_of(
    seq: &Sequence,
    exclude: &[ClipId],
    playhead: Option<Time>,
    markers: &[Time],
) -> Vec<Target> {
    let mut out = Vec::new();
    if let Some(time) = playhead {
        out.push(Target {
            time,
            kind: TargetKind::Playhead,
        });
    }
    out.extend(
        markers
            .iter()
            .copied()
            .chain(seq.markers.iter().map(|m| m.time))
            .map(|time| Target {
                time,
                kind: TargetKind::Marker,
            }),
    );
    for c in seq
        .tracks
        .iter()
        .flat_map(|t| &t.clips)
        .filter(|c| !exclude.contains(&c.id))
    {
        out.push(Target {
            time: c.start,
            kind: TargetKind::ClipEdge,
        });
        if let Some(end) = c.end() {
            out.push(Target {
                time: end,
                kind: TargetKind::ClipEdge,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use app_model::{Clip, ClipId, MediaId, Rational, SeqIds, Track, TrackId, TrackKind};

    fn tg(t: i64, kind: TargetKind) -> Target {
        Target {
            time: Time::from_ticks(t),
            kind,
        }
    }
    fn tk(t: i64) -> Time {
        Time::from_ticks(t)
    }

    #[test]
    fn snaps_to_the_nearest_target_within_the_tolerance_inclusive() {
        let ts = [tg(100, TargetKind::ClipEdge), tg(130, TargetKind::ClipEdge)];
        assert_eq!(snap(tk(110), &ts, tk(10)).time, tk(100)); // exactly on the tolerance
        assert_eq!(snap(tk(111), &ts, tk(10)).time, tk(111)); // one tick outside: untouched
        assert_eq!(snap(tk(111), &ts, tk(10)).hit, None);
        assert_eq!(snap(tk(116), &ts, tk(20)).time, tk(130)); // nearer one wins
        assert_eq!(snap(tk(5), &[], tk(10)).hit, None);
        assert_eq!(snap(tk(5), &ts, tk(-1)).hit, None);
    }

    #[test]
    fn ties_prefer_playhead_then_marker_then_clip_edge_then_earlier() {
        let ts = [
            tg(90, TargetKind::ClipEdge),
            tg(110, TargetKind::Marker),
            tg(110, TargetKind::Playhead),
        ];
        assert_eq!(
            snap(tk(100), &ts, tk(10)).hit.unwrap().kind,
            TargetKind::Playhead
        );
        let ts = [tg(90, TargetKind::ClipEdge), tg(110, TargetKind::ClipEdge)];
        assert_eq!(snap(tk(100), &ts, tk(10)).time, tk(90));
        let ts = [tg(90, TargetKind::ClipEdge), tg(110, TargetKind::Playhead)];
        assert_eq!(
            snap(tk(100), &ts, tk(10)).hit.unwrap().kind,
            TargetKind::Playhead
        );
    }

    #[test]
    fn a_span_snaps_by_whichever_edge_moves_less_and_keeps_its_length() {
        let ts = [tg(100, TargetKind::ClipEdge), tg(205, TargetKind::ClipEdge)];
        // start 97 is 3 from 100; end 197 is 8 from 205: the start wins.
        assert_eq!(snap_span(tk(97), tk(100), &ts, tk(10)).time, tk(100));
        // start 90 is 10 from 100; end 200 is 5 from 205: the end wins, start = 205 - 100.
        let r = snap_span(tk(90), tk(110), &ts, tk(10));
        assert_eq!((r.time, r.hit.unwrap().time), (tk(95), tk(205)));
        assert_eq!(snap_span(tk(0), tk(10), &ts, tk(5)).hit, None);
        // Tick-sized extremes never panic.
        let _ = snap(
            Time::from_ticks(i64::MIN),
            &[tg(i64::MAX, TargetKind::Marker)],
            tk(5),
        );
        let _ = snap_span(
            Time::from_ticks(i64::MAX),
            Time::from_ticks(i64::MAX),
            &ts,
            tk(5),
        );
    }

    fn big(tracks: usize, per_track: usize) -> app_model::Sequence {
        let mut ids = SeqIds::default();
        let mut p = app_model::Project::new(
            &mut ids,
            "B",
            Rational::FPS_30,
            app_model::Resolution {
                width: 1920,
                height: 1080,
            },
        );
        let m = MediaId::new(&mut ids);
        let mut seq = p.sequences.remove(0);
        seq.tracks = (0..tracks)
            .map(|_| Track {
                id: TrackId::new(&mut ids),
                kind: TrackKind::Video,
                name: "T".into(),
                muted: false,
                locked: false,
                hidden: false,
                solo: false,
                height: None,
                colour: None,
                clips: (0..per_track as i64)
                    .map(|i| Clip {
                        id: ClipId::new(&mut ids),
                        media: m,
                        start: tk(i * 1000),
                        source_in: Time::ZERO,
                        duration: tk(900),
                        speed: Rational::new(1, 1).unwrap(),
                        link: None,
                        transform: Default::default(),
                    })
                    .collect(),
            })
            .collect();
        seq
    }

    #[test]
    fn targets_exclude_dragged_clips_and_add_playhead_and_markers() {
        let seq = big(2, 3);
        let dragged = seq.tracks[0].clips[1].id;
        let ts = targets_of(&seq, &[dragged], Some(tk(5)), &[tk(7)]);
        assert_eq!(ts.len(), 2 + 2 * 5);
        assert_eq!(ts[0].kind, TargetKind::Playhead);
        assert_eq!(ts[1].kind, TargetKind::Marker);
    }

    #[test]
    fn the_sequences_own_markers_are_targets() {
        let mut seq = big(1, 1);
        let mut ids = SeqIds::default();
        seq.markers.push(app_model::Marker {
            id: app_model::MarkerId::new(&mut ids),
            time: tk(40),
            kind: app_model::MarkerKind::Chapter,
            name: "c".into(),
            colour: None,
        });
        let ts = targets_of(&seq, &[], None, &[]);
        assert_eq!(ts.len(), 1 + 2);
        let s = snap(tk(41), &ts, tk(2));
        assert_eq!(
            s.hit.map(|h| (h.time, h.kind)),
            Some((tk(40), TargetKind::Marker))
        );
    }

    /// 20 tracks x 1000 clips (40k edges): building the targets and snapping must stay under 1 ms per snap (budget in `docs/PERFORMANCE.md`).
    /// Timed only in release builds; debug builds just run it for correctness.
    #[test]
    fn snap_over_20_tracks_of_1000_clips_is_under_a_millisecond() {
        let seq = big(20, 1000);
        let ts = targets_of(&seq, &[], Some(tk(123_456)), &[]);
        assert_eq!(ts.len(), 1 + 20 * 1000 * 2);
        let mut best = std::time::Duration::MAX;
        for round in 0..50 {
            let t0 = std::time::Instant::now();
            let r = snap(tk(500_000 + round % 20), &ts, tk(30));
            best = best.min(t0.elapsed());
            assert_eq!(r.time, tk(500_000));
        }
        eprintln!("snap over {} targets: best {best:?}", ts.len());
        if !cfg!(debug_assertions) {
            assert!(best < std::time::Duration::from_millis(1), "{best:?}");
        }
    }
}
