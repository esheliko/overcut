//! S7 property tests. Case count: `PROPTEST_CASES` (default 256 here; the S7 bar of 100k is
//! `PROPTEST_CASES=100000 cargo test -p app-timeline --release`).
//! The E2 gate (M2-011) is the 10k run over every op: `npm run test:e2` (release mode).

#![allow(clippy::field_reassign_with_default)]
use crate::apply::MAX_TRACKS;
use crate::*;
use app_model::{
    Animated, Clip, ClipId, IdSource, LinkId, MediaId, MediaKind, MediaRef, Project, Rational,
    Resolution, SeqIds, SequenceId, Time, Track, TrackId, TrackKind,
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
        transform: Default::default(),
        audio: Default::default(),
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
    /// M2-008: speeds include out-of-range and awkward fractions on purpose.
    SetSpeed {
        clip: usize,
        num: u8,
        den: u8,
        ripple: bool,
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
    RippleTrim {
        clip: usize,
        out: bool,
        delta: i8,
        all: bool,
    },
    RippleDelete {
        clip: usize,
        all: bool,
    },
    CloseGap {
        track: usize,
        at: u8,
        all: bool,
    },
    Roll {
        clip: usize,
        delta: i8,
    },
    Slip {
        clip: usize,
        delta: i8,
    },
    Slide {
        clip: usize,
        delta: i8,
    },
    /// M2-003: values may be out of range on purpose (bad ones must error and change nothing).
    Transform {
        clip: usize,
        pos: i8,
        scale: i8,
        rot: i16,
        opacity: i8,
        crop: i8,
        flip: bool,
    },
    /// Round 16: volume and fades; out-of-range values (volume > 2, negative or too-long fades) must be refused and change nothing.
    Audio {
        clip: usize,
        volume: i8,
        fade_in: i8,
        fade_out: i8,
    },
    /// M2-004: keyframe ops on a small time grid so keys collide, moves find keys and bad values (opacity outside 0..1) are refused.
    SetKey {
        clip: usize,
        prop: usize,
        t: i8,
        v: i8,
        easing: u8,
    },
    MoveKey {
        clip: usize,
        prop: usize,
        from: i8,
        to: i8,
        v: Option<i8>,
    },
    DeleteKey {
        clip: usize,
        prop: usize,
        t: i8,
    },
    SetEase {
        clip: usize,
        prop: usize,
        t: i8,
        easing: u8,
    },
    /// Link or unlink a clip (a small set of link ids so links collide and survive splits).
    SetLink {
        clip: usize,
        link: Option<u8>,
    },
    /// Media-bin ops (import, relink, tags, remove). `n` picks the item; an item that clips use must refuse removal.
    AddMedia {
        video: bool,
    },
    RemoveMedia {
        n: usize,
    },
    SetMedia {
        n: usize,
        uri: u8,
        hash: Option<u8>,
    },
    SetMediaTags {
        n: usize,
        tags: Vec<u8>,
    },
    /// Sequence format and canvas: rates and sizes include bad ones (0) on purpose.
    SetFormat {
        fps: u8,
        w: u8,
    },
    SetCanvas {
        fps: u8,
        w: u8,
        size_fixed: bool,
        rate_fixed: bool,
    },
    /// M2-007: markers on a small time grid so several share a time (order by id) and bad names/colours/times are refused.
    AddMarker {
        time: i8,
        chapter: bool,
        name: u8,
        colour: Option<u8>,
    },
    MoveMarker {
        n: usize,
        time: i8,
    },
    MarkerProps {
        n: usize,
        name: Option<u8>,
        chapter: Option<bool>,
        colour: Option<Option<u8>>,
    },
    DeleteMarker {
        n: usize,
    },
    SetRange {
        start: i8,
        end: i8,
        none: bool,
        looping: bool,
    },
    SetBackground {
        mode: u8,
        colour: [u8; 3],
        blur: u8,
    },
    Undo,
    Redo,
}

const PROPS: [app_model::TransformProp; 12] = {
    use app_model::TransformProp::*;
    [
        PositionX, PositionY, ScaleX, ScaleY, Rotation, AnchorX, AnchorY, CropLeft, CropTop,
        CropRight, CropBottom, Opacity,
    ]
};

fn easing_of(n: u8) -> app_model::Easing {
    match n % 5 {
        0 => app_model::Easing::Hold,
        1 => app_model::Easing::Linear,
        2 => app_model::Easing::EASE_IN,
        3 => app_model::Easing::EASE_OUT,
        _ => app_model::Easing::EASE_IN_OUT,
    }
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
        3 => (any::<usize>(), 0..20u8, 1..9u8, any::<bool>()).prop_map(|(clip, num, den, ripple)| Step::SetSpeed { clip, num, den, ripple }),
        1 => (any::<bool>(), any::<usize>(), any::<bool>()).prop_map(|(video, index, with_clip)| Step::AddTrack { video, index, with_clip }),
        1 => any::<usize>().prop_map(|track| Step::RemoveTrack { track }),
        1 => (any::<usize>(), any::<usize>()).prop_map(|(track, index)| Step::MoveTrack { track, index }),
        2 => (any::<usize>(), any::<Option<bool>>(), any::<Option<bool>>(), any::<Option<bool>>(), any::<Option<bool>>(), prop::option::of(prop::option::of(0..450u32)))
            .prop_map(|(track, muted, solo, locked, hidden, height)| Step::TrackProps { track, muted, solo, locked, hidden, height }),
        2 => (any::<usize>(), any::<bool>(), -8..8i8, any::<bool>()).prop_map(|(clip, out, delta, all)| Step::RippleTrim { clip, out, delta, all }),
        1 => (any::<usize>(), any::<bool>()).prop_map(|(clip, all)| Step::RippleDelete { clip, all }),
        1 => (0..4usize, 0..70u8, any::<bool>()).prop_map(|(track, at, all)| Step::CloseGap { track, at, all }),
        2 => (any::<usize>(), -8..8i8).prop_map(|(clip, delta)| Step::Roll { clip, delta }),
        2 => (any::<usize>(), -8..8i8).prop_map(|(clip, delta)| Step::Slip { clip, delta }),
        2 => (any::<usize>(), -8..8i8).prop_map(|(clip, delta)| Step::Slide { clip, delta }),
        3 => (any::<usize>(), -8..8i8, -2..8i8, -400..400i16, -2..12i8, -2..12i8, any::<bool>())
            .prop_map(|(clip, pos, scale, rot, opacity, crop, flip)| Step::Transform { clip, pos, scale, rot, opacity, crop, flip }),
        2 => (any::<usize>(), -2..26i8, -1..14i8, -1..14i8)
            .prop_map(|(clip, volume, fade_in, fade_out)| Step::Audio { clip, volume, fade_in, fade_out }),
        4 => (0..2usize, 0..3usize, -1..4i8, -4..8i8, any::<u8>())
            .prop_map(|(clip, prop, t, v, easing)| Step::SetKey { clip, prop, t, v, easing }),
        2 => (0..2usize, 0..3usize, 0..4i8, 0..4i8, prop::option::of(-2..6i8))
            .prop_map(|(clip, prop, from, to, v)| Step::MoveKey { clip, prop, from, to, v }),
        2 => (0..2usize, 0..3usize, 0..4i8)
            .prop_map(|(clip, prop, t)| Step::DeleteKey { clip, prop, t }),
        2 => (0..2usize, 0..3usize, 0..4i8, any::<u8>())
            .prop_map(|(clip, prop, t, easing)| Step::SetEase { clip, prop, t, easing }),
        2 => (any::<usize>(), prop::option::of(0..3u8)).prop_map(|(clip, link)| Step::SetLink { clip, link }),
        1 => any::<bool>().prop_map(|video| Step::AddMedia { video }),
        1 => any::<usize>().prop_map(|n| Step::RemoveMedia { n }),
        1 => (any::<usize>(), 0..4u8, prop::option::of(0..4u8)).prop_map(|(n, uri, hash)| Step::SetMedia { n, uri, hash }),
        1 => (any::<usize>(), prop::collection::vec(0..5u8, 0..4)).prop_map(|(n, tags)| Step::SetMediaTags { n, tags }),
        1 => (0..4u8, 0..4u8).prop_map(|(fps, w)| Step::SetFormat { fps, w }),
        1 => (0..4u8, 0..4u8, any::<bool>(), any::<bool>()).prop_map(|(fps, w, size_fixed, rate_fixed)| Step::SetCanvas { fps, w, size_fixed, rate_fixed }),
        3 => (-1..40i8, any::<bool>(), 0..4u8, prop::option::of(0..4u8))
            .prop_map(|(time, chapter, name, colour)| Step::AddMarker { time, chapter, name, colour }),
        2 => (any::<usize>(), -1..40i8).prop_map(|(n, time)| Step::MoveMarker { n, time }),
        2 => (any::<usize>(), prop::option::of(0..4u8), prop::option::of(any::<bool>()), prop::option::of(prop::option::of(0..4u8)))
            .prop_map(|(n, name, chapter, colour)| Step::MarkerProps { n, name, chapter, colour }),
        1 => any::<usize>().prop_map(|n| Step::DeleteMarker { n }),
        2 => (-1..30i8, -1..30i8, any::<bool>(), any::<bool>())
            .prop_map(|(start, end, none, looping)| Step::SetRange { start, end, none, looping }),
        1 => (0..3u8, any::<[u8; 3]>(), 0..=120u8)
            .prop_map(|(mode, colour, blur)| Step::SetBackground { mode, colour, blur }),
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

fn marker_at(p: &Project, n: usize) -> Option<app_model::MarkerId> {
    let ms = &p.sequences[0].markers;
    (!ms.is_empty()).then(|| ms[n % ms.len()].id)
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
            let m = p.media.get(media % p.media.len().max(1))?;
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
            speed: None,
        },
        Step::SetSpeed {
            clip,
            num,
            den,
            ripple,
        } => Op::SetClipSpeed {
            clip: pick(clip)?.id,
            speed: Rational::new(i64::from(num), i64::from(den)).unwrap(), // reduced, as on the wire
            ripple,
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
                .find(|m| matches!(m.kind, MediaKind::Video))?;
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
        Step::RippleTrim {
            clip,
            out,
            delta,
            all,
        } => Op::RippleTrim {
            clip: pick(clip)?.id,
            edge: if out { Edge::Out } else { Edge::In },
            delta: t(i64::from(delta)),
            all_tracks: all,
        },
        Step::RippleDelete { clip, all } => Op::RippleDelete {
            clip: pick(clip)?.id,
            all_tracks: all,
        },
        Step::CloseGap { track, at, all } => Op::CloseGap {
            track: tracks[track % tracks.len()].id,
            at: t(i64::from(at)),
            all_tracks: all,
        },
        Step::Roll { clip, delta } => {
            let l = pick(clip)?;
            let end = l.end().unwrap();
            let r = tracks
                .iter()
                .flat_map(|tr| &tr.clips)
                .find(|c| c.start == end && c.id != l.id)?;
            Op::Roll {
                left: l.id,
                right: r.id,
                to: Time::from_ticks(end.ticks() + i64::from(delta) * U),
            }
        }
        Step::Slip { clip, delta } => Op::Slip {
            clip: pick(clip)?.id,
            delta: t(i64::from(delta)),
        },
        Step::Slide { clip, delta } => Op::Slide {
            clip: pick(clip)?.id,
            delta: t(i64::from(delta)),
        },
        Step::Transform {
            clip,
            pos,
            scale,
            rot,
            opacity,
            crop,
            flip,
        } => {
            let mut x = app_model::ClipTransform::default();
            x.position_x = Animated::constant(f64::from(pos) / 4.0);
            x.scale_x = Animated::constant(f64::from(scale) / 4.0);
            x.rotation = Animated::constant(f64::from(rot));
            x.opacity = Animated::constant(f64::from(opacity) / 10.0);
            x.crop_left = Animated::constant(f64::from(crop) / 10.0);
            x.flip_h = flip;
            Op::SetClipTransform {
                clip: pick(clip)?.id,
                transform: Box::new(x),
            }
        }
        Step::Audio {
            clip,
            volume,
            fade_in,
            fade_out,
        } => Op::SetClipAudio {
            clip: pick(clip)?.id,
            audio: app_model::ClipAudio {
                volume: f32::from(volume) / 10.0,
                fade_in: t(i64::from(fade_in)),
                fade_out: t(i64::from(fade_out)),
            },
        },
        Step::SetKey {
            clip,
            prop,
            t: kt,
            v,
            easing,
        } => Op::SetKeyframe {
            clip: pick(clip)?.id,
            prop: PROPS[prop],
            key: app_model::Keyframe {
                t: t(i64::from(kt)),
                // Opacity must stay in 0..=1, scale > 0: most values are fine, some are refused on purpose.
                v: f64::from(v) / 4.0,
                easing: easing_of(easing),
            },
        },
        Step::MoveKey {
            clip,
            prop,
            from,
            to,
            v,
        } => Op::MoveKeyframe {
            clip: pick(clip)?.id,
            prop: PROPS[prop],
            from: t(i64::from(from)),
            to: t(i64::from(to)),
            value: v.map(|v| f64::from(v) / 4.0),
        },
        Step::DeleteKey { clip, prop, t: kt } => Op::DeleteKeyframe {
            clip: pick(clip)?.id,
            prop: PROPS[prop],
            t: t(i64::from(kt)),
        },
        Step::SetEase {
            clip,
            prop,
            t: kt,
            easing,
        } => Op::SetEasing {
            clip: pick(clip)?.id,
            prop: PROPS[prop],
            t: t(i64::from(kt)),
            easing: easing_of(easing),
        },
        Step::SetLink { clip, link } => Op::SetLink {
            clip: pick(clip)?.id,
            link: link.map(|n| LinkId(app_model::Id::from_u128(u128::from(n) + 1_000_000))),
        },
        Step::AddMedia { video } => Op::AddMedia {
            index: (video && p.media.len() > 1).then_some(1),
            media: media(
                ids,
                if video {
                    MediaKind::Video
                } else {
                    MediaKind::Audio
                },
                Some(40),
            ),
        },
        Step::RemoveMedia { n } => Op::RemoveMedia {
            media: p.media.get(n % p.media.len().max(1))?.id,
        },
        Step::SetMedia { n, uri, hash } => Op::SetMedia {
            media: p.media.get(n % p.media.len().max(1))?.id,
            uri: format!("file-{uri}"),
            hash: hash.map(|h| format!("b3-64k:{h:016x}")),
        },
        Step::SetMediaTags { n, ref tags } => Op::SetMediaTags {
            media: p.media.get(n % p.media.len().max(1))?.id,
            tags: tags.iter().map(|t| format!("tag{t}")).collect(),
        },
        Step::SetFormat { fps, w } => Op::SetSequenceFormat {
            sequence: p.sequences[0].id,
            frame_rate: Rational::new(i64::from(fps) * 12, 1).unwrap_or(Rational::FPS_30),
            resolution: Resolution {
                width: u32::from(w) * 640,
                height: u32::from(w) * 360,
            },
        },
        Step::SetCanvas {
            fps,
            w,
            size_fixed,
            rate_fixed,
        } => Op::SetCanvas {
            sequence: p.sequences[0].id,
            frame_rate: Rational::new(i64::from(fps) * 12, 1).unwrap_or(Rational::FPS_30),
            resolution: Resolution {
                width: u32::from(w) * 640,
                height: u32::from(w) * 360,
            },
            size_fixed,
            rate_fixed,
        },
        Step::AddMarker {
            time,
            chapter,
            name,
            colour,
        } => Op::AddMarker {
            sequence: p.sequences[0].id,
            marker: app_model::Marker {
                id: app_model::MarkerId::new(ids),
                time: t(i64::from(time)),
                kind: if chapter {
                    app_model::MarkerKind::Chapter
                } else {
                    app_model::MarkerKind::Marker
                },
                // 0 = an unnamed marker; 3 = a name with surrounding space, which must be refused
                name: match name {
                    0 => String::new(),
                    3 => " bad ".into(),
                    n => format!("m{n}"),
                },
                colour: colour.map(|c| {
                    if c == 3 {
                        "red".to_string()
                    } else {
                        format!("#00000{c}")
                    }
                }),
            },
        },
        Step::MoveMarker { n, time } => Op::MoveMarker {
            marker: marker_at(p, n)?,
            time: t(i64::from(time)),
        },
        Step::MarkerProps {
            n,
            name,
            chapter,
            colour,
        } => Op::SetMarkerProps {
            marker: marker_at(p, n)?,
            name: name.map(|n| {
                if n == 3 {
                    " bad ".into()
                } else {
                    format!("n{n}")
                }
            }),
            kind: chapter.map(|c| {
                if c {
                    app_model::MarkerKind::Chapter
                } else {
                    app_model::MarkerKind::Marker
                }
            }),
            colour: colour.map(|c| c.map(|c| format!("#00000{c}"))),
        },
        Step::DeleteMarker { n } => Op::DeleteMarker {
            marker: marker_at(p, n)?,
        },
        Step::SetRange {
            start,
            end,
            none,
            looping,
        } => Op::SetRange {
            sequence: p.sequences[0].id,
            range: (!none).then(|| app_model::TimeRange {
                start: t(i64::from(start)),
                end: t(i64::from(end)),
            }),
            looping,
        },
        Step::SetBackground { mode, colour, blur } => Op::SetBackground {
            sequence: p.sequences[0].id,
            background: app_model::Background {
                mode: match mode {
                    0 => app_model::BackgroundMode::Black,
                    1 => app_model::BackgroundMode::Colour,
                    _ => app_model::BackgroundMode::Blur,
                },
                colour,
                blur,
            },
        },
        Step::Undo | Step::Redo => return None,
    })
}

/// The E2 invariants, checked independently of `Project::validate`: on every track the clips are in order and never overlap, every
/// clip points at a media entry that exists, and a save/reopen round trip gives the same project (links included).
fn check_invariants(p: &Project) -> Result<(), TestCaseError> {
    for s in &p.sequences {
        for tr in &s.tracks {
            for w in tr.clips.windows(2) {
                let end = w[0].end().unwrap().ticks();
                prop_assert!(
                    end <= w[1].start.ticks(),
                    "clips overlap or are out of order on {}",
                    tr.name
                );
            }
            for c in &tr.clips {
                prop_assert!(
                    p.media.iter().any(|m| m.id == c.media),
                    "clip points at a missing media entry"
                );
            }
        }
    }
    p.validate()
        .map_err(|e| TestCaseError::fail(e.to_string()))?;
    let json = serde_json::to_string(p).unwrap();
    let back: Project = serde_json::from_str(&json).unwrap();
    prop_assert_eq!(&back, p, "save/reopen changed the project (links?)");
    Ok(())
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
                    check_invariants(&p).map_err(|e| TestCaseError::fail(format!("{op:?}: {e}")))?;
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
            check_invariants(&p)?;
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

proptest! {
    /// The patch an edit reports reproduces the project: after every apply, undo and redo, applying `diff(shadow, now)` to the
    /// previous shadow gives the project (ADR 0020), and the patch survives its JSON form.
    #[test]
    fn patches_reproduce_the_project_after_random_ops_undo_and_redo(steps in prop::collection::vec(step(), 1..60)) {
        let (start, mut ids) = base();
        let mut p = start.clone();
        let mut shadow = start;
        let mut h = History::new();
        for s in &steps {
            match s {
                Step::Undo => { h.undo(&mut p).unwrap(); }
                Step::Redo => { h.redo(&mut p).unwrap(); }
                _ => {
                    let Some(op) = resolve(s, &p, &mut ids) else { continue };
                    let _ = h.apply(&mut p, op, None);
                }
            }
            let patch = diff(&shadow, &p).expect("same project and sequences: always a patch");
            let wire: EditPatch = serde_json::from_str(&serde_json::to_string(&patch).unwrap()).unwrap();
            prop_assert_eq!(&wire, &patch);
            apply_patch(&mut shadow, &wire).map_err(TestCaseError::fail)?;
            prop_assert_eq!(&shadow, &p, "patched copy != project");
        }
    }
}

#[test]
fn editor_outcomes_carry_a_patch_that_keeps_a_ui_copy_equal_to_the_project() {
    let (p, mut ids) = base();
    let tr = p.sequences[0].tracks[0].id;
    let m = p.media[0].id;
    let c = clip(&mut ids, m, 0, 0, 10);
    let cid = c.id;
    let new_id = ClipId::new(&mut ids);
    let mut e = Editor::from_project(p);
    let mut ui: Project = serde_json::from_str(&e.project_json()).unwrap();
    let ops = [
        serde_json::to_string(&Op::InsertClip { track: tr, clip: c }).unwrap(),
        serde_json::to_string(&Op::Split {
            clip: cid,
            at: t(4),
            new_id,
            new_link: None,
        })
        .unwrap(),
    ];
    let mut check = |e: &Editor, json: String| -> EditOutcome {
        let out: EditOutcome = serde_json::from_str(&json).unwrap();
        assert!(out.changed);
        apply_patch(&mut ui, out.patch.as_ref().expect("a patch")).unwrap();
        assert_eq!(serde_json::to_string(&ui).unwrap(), e.project_json());
        out
    };
    let j = e.apply_json(&ops[0], None).unwrap();
    check(&e, j);
    let j = e.apply_json(&ops[1], None).unwrap();
    let out = check(&e, j);
    let sp = out.patch.unwrap().sequences[0].tracks[0]
        .splice
        .clone()
        .unwrap();
    assert_eq!(
        (sp.start, sp.remove, sp.insert.len()),
        (0, 1, 2),
        "a split is one splice, not the whole track"
    );
    let j = e.undo_json().unwrap();
    check(&e, j);
    let j = e.redo_json().unwrap();
    check(&e, j);
    // A no-op undo reports no change and no patch.
    let mut fresh = Editor::from_project(base().0);
    let out: EditOutcome = serde_json::from_str(&fresh.undo_json().unwrap()).unwrap();
    assert!(!out.changed && out.patch.is_none());
}

/// `packages/engine-client/schema/patch-contract.json`: real edits with the project before, the patch the engine reports and the project after.
/// The TypeScript `applyEditPatch` is tested against the same file (`tests/unit/edit-patch.test.ts`). Regenerate with `UPDATE_PATCH_CONTRACT=1 cargo test -p app-timeline patch_contract`.
#[test]
fn patch_contract_matches_the_checked_in_file() {
    let (p, mut ids) = base();
    let tracks: Vec<TrackId> = p.sequences[0].tracks.iter().map(|t| t.id).collect();
    let m = p.media[0].id;
    let (a, b) = (clip(&mut ids, m, 0, 0, 10), clip(&mut ids, m, 20, 10, 10));
    let (aid, bid) = (a.id, b.id);
    let (split_id, new_track) = (ClipId::new(&mut ids), TrackId::new(&mut ids));
    let new_marker = app_model::MarkerId::new(&mut ids);
    let mut e = Editor::from_project(p);
    let to = |o: &Op| serde_json::to_string(o).unwrap();
    let ops: Vec<(&str, String)> = vec![
        (
            "insert two clips",
            format!(
                "[{},{}]",
                to(&Op::InsertClip {
                    track: tracks[0],
                    clip: a
                }),
                to(&Op::InsertClip {
                    track: tracks[0],
                    clip: b
                })
            ),
        ),
        (
            "split the first clip",
            to(&Op::Split {
                clip: aid,
                at: t(4),
                new_id: split_id,
                new_link: None,
            }),
        ),
        (
            "move the second clip to another track",
            to(&Op::Move {
                clip: bid,
                track: tracks[1],
                start: t(30),
            }),
        ),
        (
            "mute a track",
            to(&Op::SetTrackProps {
                track: tracks[2],
                muted: Some(true),
                solo: None,
                locked: None,
                hidden: None,
                height: None,
                name: None,
                colour: None,
            }),
        ),
        (
            "add a track at the bottom",
            to(&Op::AddTrack {
                sequence: e.project().sequences[0].id,
                track: Track {
                    id: new_track,
                    kind: TrackKind::Video,
                    name: "V3".into(),
                    muted: false,
                    locked: false,
                    hidden: false,
                    solo: false,
                    height: None,
                    colour: None,
                    clips: vec![],
                },
                index: 0,
            }),
        ),
        (
            "move that track to the top",
            to(&Op::MoveTrack {
                track: new_track,
                index: 3,
            }),
        ),
        (
            "add a marker",
            to(&Op::AddMarker {
                sequence: e.project().sequences[0].id,
                marker: app_model::Marker {
                    id: new_marker,
                    time: t(5),
                    kind: app_model::MarkerKind::Marker,
                    name: "m".into(),
                    colour: None,
                },
            }),
        ),
        (
            "remove the new track",
            to(&Op::RemoveTrack { track: new_track }),
        ),
    ];
    let mut cases = Vec::new();
    for (name, op) in &ops {
        let before: serde_json::Value = serde_json::from_str(&e.project_json()).unwrap();
        let out: serde_json::Value =
            serde_json::from_str(&e.apply_json(op, None).unwrap()).unwrap();
        let after: serde_json::Value = serde_json::from_str(&e.project_json()).unwrap();
        cases.push(serde_json::json!({ "name": name, "before": before, "patch": out["patch"], "after": after }));
    }
    for _ in 0..4 {
        let before: serde_json::Value = serde_json::from_str(&e.project_json()).unwrap();
        let out: serde_json::Value = serde_json::from_str(&e.undo_json().unwrap()).unwrap();
        let after: serde_json::Value = serde_json::from_str(&e.project_json()).unwrap();
        cases.push(serde_json::json!({ "name": "undo", "before": before, "patch": out["patch"], "after": after }));
    }
    let fresh =
        serde_json::to_string_pretty(&serde_json::json!({ "cases": cases })).unwrap() + "\n";
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/engine-client/schema/patch-contract.json"
    );
    if std::env::var("UPDATE_PATCH_CONTRACT").is_ok() {
        std::fs::write(path, &fresh).unwrap();
    }
    assert_eq!(std::fs::read_to_string(path).unwrap(), fresh, "patch contract is stale: UPDATE_PATCH_CONTRACT=1 cargo test -p app-timeline patch_contract");
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

/// Issue #106: an imported video clip and its linked sound clip both start at 0; a left-edge drag sends `trim_in` for each.
/// Both must keep the new start (the engine side of that gesture is exact).
#[test]
fn trim_in_on_an_imported_linked_pair_keeps_the_new_start() {
    let (mut p, mut ids) = base();
    let (mv, ma) = (p.media[0].id, p.media[1].id);
    let (v, a) = (clip(&mut ids, mv, 0, 0, 30), clip(&mut ids, ma, 0, 0, 30));
    let (vi, ai) = (v.id, a.id);
    p.sequences[0].tracks[0].clips = vec![v];
    p.sequences[0].tracks[2].clips = vec![a];
    for clip in [vi, ai] {
        apply(&mut p, Op::TrimIn { clip, start: t(1) }).unwrap();
    }
    for track in [0, 2] {
        let c = &p.sequences[0].tracks[track].clips[0];
        assert_eq!(
            (c.start, c.source_in, c.duration),
            (t(1), t(1), t(29)),
            "track {track}"
        );
        assert_eq!(c.end(), Some(t(30)), "the end stays where it was");
    }
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
        37,
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
    assert_eq!(ops.len(), 36, "one example per Op variant");
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
    h.apply_batch(
        &mut p,
        vec![
            Op::AddMedia {
                media: new.clone(),
                index: None,
            },
            fmt,
        ],
        None,
    )
    .unwrap();
    assert_eq!(p.media.last().unwrap(), &new);
    assert_eq!(p.sequences[0].resolution.width, 1080);
    h.undo(&mut p).unwrap();
    assert_eq!(p, before);
    h.redo(&mut p).unwrap();
    assert_eq!(p.media.len(), before.media.len() + 1);
    // duplicate id, empty uri, bad format, removing media a clip uses
    let dup = Op::AddMedia {
        media: new.clone(),
        index: None,
    };
    assert!(h.apply(&mut p, dup, None).is_err());
    let mut empty = new.clone();
    empty.id = MediaId::new(&mut ids);
    empty.uri.clear();
    assert!(h
        .apply(
            &mut p,
            Op::AddMedia {
                media: empty,
                index: None
            },
            None
        )
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
            transform: Default::default(),
            audio: Default::default(),
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

#[test]
fn set_background_is_one_undoable_step_carried_by_evaluate_and_validates() {
    use app_model::{Background, BackgroundMode};
    let (mut p, mut ids) = base();
    let seq = p.sequences[0].id;
    let before = p.clone();
    let blur = Background {
        mode: BackgroundMode::Blur,
        colour: [1, 2, 3],
        blur: 80,
    };
    let mut h = History::new();
    h.apply(
        &mut p,
        Op::SetBackground {
            sequence: seq,
            background: blur,
        },
        None,
    )
    .unwrap();
    assert_eq!(p.sequences[0].background, blur);
    p.validate().unwrap();
    // evaluate carries it (a frame in a gap too: the background is the sequence's, not a clip's)
    assert_eq!(evaluate(&p.sequences[0], Time::ZERO, 0).background, blur);
    h.undo(&mut p).unwrap();
    assert_eq!(p, before, "undo restores the black default");
    assert!(evaluate(&p.sequences[0], Time::ZERO, 0)
        .background
        .is_default());
    h.redo(&mut p).unwrap();
    assert_eq!(p.sequences[0].background, blur);
    // refused without touching anything
    let after = p.clone();
    let too_blurry = Background { blur: 101, ..blur };
    assert!(matches!(
        h.apply(
            &mut p,
            Op::SetBackground {
                sequence: seq,
                background: too_blurry
            },
            None
        )
        .unwrap_err(),
        OpError::Batch {
            cause,
            ..
        } if *cause == OpError::BadBackground
    ));
    assert!(h
        .apply(
            &mut p,
            Op::SetBackground {
                sequence: app_model::SequenceId::new(&mut ids),
                background: blur
            },
            None
        )
        .is_err());
    assert_eq!(p, after);
    // the default is not written to the file and the frame JSON omits it
    let json = serde_json::to_string(&before).unwrap();
    assert!(!json.contains("background"));
    let mut e = Editor::from_project(before);
    let fj: serde_json::Value =
        serde_json::from_str(&e.evaluate_json(&seq.to_string(), 0, 0).unwrap()).unwrap();
    assert!(fj.get("background").is_none());
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

// ---- M2-005: ripple, gap close, roll, slip, slide ----

/// Three touching 10-unit clips on V1 at 0, 10, 20 (media 0, 100 units long), plus one clip on V2 at 15..25.
fn row() -> (Project, TrackId, TrackId, [ClipId; 3], ClipId) {
    let (mut p, mut ids) = base();
    let (v1, v2) = (p.sequences[0].tracks[0].id, p.sequences[0].tracks[1].id);
    let m = p.media[0].id;
    let cs = [
        clip(&mut ids, m, 0, 10, 10),
        clip(&mut ids, m, 10, 30, 10),
        clip(&mut ids, m, 20, 50, 10),
    ];
    let other = clip(&mut ids, m, 15, 0, 10);
    let ids3 = [cs[0].id, cs[1].id, cs[2].id];
    let oid = other.id;
    p.sequences[0].tracks[0].clips = cs.to_vec();
    p.sequences[0].tracks[1].clips = vec![other];
    p.validate().unwrap();
    (p, v1, v2, ids3, oid)
}

fn geom(p: &Project, id: ClipId) -> (i64, i64, i64) {
    let c = all_clips(p).into_iter().find(|c| c.id == id).unwrap();
    (
        c.start.ticks() / U,
        c.source_in.ticks() / U,
        c.duration.ticks() / U,
    )
}

/// Applies, checks the project is valid and that the inverse restores it exactly.
fn do_undo(p: &mut Project, op: Op) -> Project {
    let before = p.clone();
    let inv = apply(p, op).unwrap();
    p.validate().unwrap();
    let after = p.clone();
    apply_all(p, &inv.0).unwrap();
    assert_eq!(*p, before);
    after
}

#[test]
fn ripple_trim_out_shifts_what_follows_on_its_own_track_only() {
    let (mut p, _, _, [a, b, c], o) = row();
    let after = do_undo(
        &mut p,
        Op::RippleTrim {
            clip: a,
            edge: Edge::Out,
            delta: t(-4),
            all_tracks: false,
        },
    );
    assert_eq!(geom(&after, a), (0, 10, 6));
    assert_eq!(geom(&after, b), (6, 30, 10));
    assert_eq!(geom(&after, c), (16, 50, 10));
    assert_eq!(geom(&after, o), (15, 0, 10), "other track untouched");
    // Lengthen: make room first.
    let after = do_undo(
        &mut p,
        Op::RippleTrim {
            clip: a,
            edge: Edge::Out,
            delta: t(5),
            all_tracks: false,
        },
    );
    assert_eq!(geom(&after, a), (0, 10, 15));
    assert_eq!(geom(&after, c), (25, 50, 10));
}

#[test]
fn ripple_trim_in_keeps_the_start_and_moves_the_source() {
    let (mut p, _, _, [a, b, c], _) = row();
    let after = do_undo(
        &mut p,
        Op::RippleTrim {
            clip: b,
            edge: Edge::In,
            delta: t(3),
            all_tracks: false,
        },
    );
    assert_eq!(geom(&after, b), (10, 33, 7));
    assert_eq!(geom(&after, c), (17, 50, 10));
    assert_eq!(geom(&after, a), (0, 10, 10));
    // Opening the head reveals earlier source and pushes the rest later.
    let after = do_undo(
        &mut p,
        Op::RippleTrim {
            clip: b,
            edge: Edge::In,
            delta: t(-2),
            all_tracks: false,
        },
    );
    assert_eq!(geom(&after, b), (10, 28, 12));
    assert_eq!(geom(&after, c), (22, 50, 10));
}

#[test]
fn ripple_all_tracks_shifts_other_unlocked_tracks_and_skips_locked_ones() {
    let (mut p, _, v2, [a, _, _], o) = row();
    let after = do_undo(
        &mut p,
        Op::RippleDelete {
            clip: a,
            all_tracks: true,
        },
    );
    assert_eq!(
        geom(&after, o),
        (5, 0, 10),
        "start 15 >= end of a: moved by 10"
    );
    // Lock V2: it stays put.
    apply(
        &mut p,
        Op::SetTrackProps {
            track: v2,
            name: None,
            muted: None,
            solo: None,
            locked: Some(true),
            hidden: None,
            height: None,
            colour: None,
        },
    )
    .unwrap();
    let after = do_undo(
        &mut p,
        Op::RippleDelete {
            clip: a,
            all_tracks: true,
        },
    );
    assert_eq!(geom(&after, o), (15, 0, 10));
}

#[test]
fn ripple_that_would_overlap_is_refused_whole() {
    // V2 has a clip straddling the ripple point (5..25) and one after it; closing up would run the later one into it.
    let (mut p, _, v2, [a, _, _], _) = row();
    let m = p.media[0].id;
    let mut ids = SeqIds::default();
    for _ in 0..5000 {
        ids.next_id();
    }
    p.sequences[0].tracks[1].clips = vec![clip(&mut ids, m, 5, 0, 20), clip(&mut ids, m, 26, 0, 3)];
    let _ = v2;
    let before = p.clone();
    let r = apply(
        &mut p,
        Op::RippleDelete {
            clip: a,
            all_tracks: true,
        },
    );
    assert!(matches!(r, Err(OpError::Overlap { .. })), "{r:?}");
    assert_eq!(p, before);
}

#[test]
fn ripple_edges_at_zero_and_at_the_source_limits() {
    let (mut p, _, _, [a, b, _], _) = row();
    // a's source starts at 10: opening its head by 10 reaches source 0, 11 is before the file.
    let r = apply(
        &mut p,
        Op::RippleTrim {
            clip: a,
            edge: Edge::In,
            delta: t(-11),
            all_tracks: false,
        },
    );
    assert_eq!(r, Err(OpError::OutOfRange));
    do_undo(
        &mut p,
        Op::RippleTrim {
            clip: a,
            edge: Edge::In,
            delta: t(-10),
            all_tracks: false,
        },
    );
    // Trimming away the whole clip is refused; the media is 100 long so b can open its tail to 100 - 30 = 70... b ends at source 40.
    assert_eq!(
        apply(
            &mut p,
            Op::RippleTrim {
                clip: b,
                edge: Edge::Out,
                delta: t(-10),
                all_tracks: false,
            }
        ),
        Err(OpError::EmptyClip)
    );
    assert_eq!(
        apply(
            &mut p,
            Op::RippleTrim {
                clip: b,
                edge: Edge::Out,
                delta: t(61),
                all_tracks: false,
            }
        ),
        Err(OpError::BeyondMedia)
    );
}

#[test]
fn ripple_delete_and_close_gap_pull_everything_left() {
    let (mut p, v1, _, [a, b, c], _) = row();
    let after = do_undo(
        &mut p,
        Op::RippleDelete {
            clip: b,
            all_tracks: false,
        },
    );
    assert_eq!(geom(&after, a), (0, 10, 10));
    assert_eq!(geom(&after, c), (10, 50, 10));
    apply(
        &mut p,
        Op::RippleDelete {
            clip: b,
            all_tracks: false,
        },
    )
    .unwrap();
    // Leave a gap 10..14 by moving c, then close it from a point inside it.
    apply(
        &mut p,
        Op::Move {
            clip: c,
            track: v1,
            start: t(24),
        },
    )
    .unwrap();
    for at in [10, 12, 23] {
        let after = do_undo(
            &mut p,
            Op::CloseGap {
                track: v1,
                at: t(at),
                all_tracks: false,
            },
        );
        assert_eq!(geom(&after, c), (10, 50, 10), "gap 10..24 closes");
    }
    // The gap between a and b is 0 long (touching): `at` on a clip is not a gap.
    for at in [5, 25] {
        assert_eq!(
            apply(
                &mut p,
                Op::CloseGap {
                    track: v1,
                    at: t(at),
                    all_tracks: false
                }
            ),
            Err(OpError::NotInGap)
        );
    }
}

#[test]
fn close_gap_before_the_first_clip_and_after_the_last_is_nothing() {
    let (mut p, v1, _, [a, b, c], _) = row();
    apply(&mut p, Op::Delete { clip: a }).unwrap();
    apply(&mut p, Op::Delete { clip: c }).unwrap();
    let after = do_undo(
        &mut p,
        Op::CloseGap {
            track: v1,
            at: t(2),
            all_tracks: false,
        },
    );
    assert_eq!(geom(&after, b), (0, 30, 10));
    assert_eq!(
        apply(
            &mut p,
            Op::CloseGap {
                track: v1,
                at: t(25),
                all_tracks: false
            }
        ),
        Err(OpError::NotInGap)
    );
}

#[test]
fn roll_moves_the_cut_and_keeps_total_length() {
    let (mut p, _, _, [a, b, c], _) = row();
    for to in [7, 14, 19] {
        let after = do_undo(
            &mut p,
            Op::Roll {
                left: a,
                right: b,
                to: t(to),
            },
        );
        assert_eq!(geom(&after, a), (0, 10, to));
        assert_eq!(geom(&after, b), (to, 30 + (to - 10), 20 - to));
        assert_eq!(geom(&after, c), (20, 50, 10));
    }
    // To the far ends: an empty side is refused; a non-touching or reversed pair is not adjacent.
    for to in [0, 20, -1, 25] {
        assert!(apply(
            &mut p,
            Op::Roll {
                left: a,
                right: b,
                to: t(to)
            }
        )
        .is_err());
    }
    assert_eq!(
        apply(
            &mut p,
            Op::Roll {
                left: a,
                right: c,
                to: t(5)
            }
        ),
        Err(OpError::NotAdjacent)
    );
    assert_eq!(
        apply(
            &mut p,
            Op::Roll {
                left: b,
                right: a,
                to: t(5)
            }
        ),
        Err(OpError::NotAdjacent)
    );
}

#[test]
fn slip_changes_the_source_window_only_and_respects_the_file() {
    let (mut p, _, _, [a, b, _], _) = row();
    let after = do_undo(
        &mut p,
        Op::Slip {
            clip: b,
            delta: t(5),
        },
    );
    assert_eq!(geom(&after, b), (10, 35, 10));
    let after = do_undo(
        &mut p,
        Op::Slip {
            clip: a,
            delta: t(-10),
        },
    );
    assert_eq!(geom(&after, a), (0, 0, 10));
    assert_eq!(
        apply(
            &mut p,
            Op::Slip {
                clip: a,
                delta: t(-11)
            }
        ),
        Err(OpError::OutOfRange)
    );
    // c reads source 50..60 of 100: slip to the very end is fine, one more is not (b: 30..40).
    assert_eq!(
        apply(
            &mut p,
            Op::Slip {
                clip: b,
                delta: t(61)
            }
        ),
        Err(OpError::BeyondMedia)
    );
    do_undo(
        &mut p,
        Op::Slip {
            clip: b,
            delta: t(60),
        },
    );
}

#[test]
fn slide_moves_the_clip_and_its_touching_neighbours_give_and_take() {
    let (mut p, _, _, [a, b, c], _) = row();
    let after = do_undo(
        &mut p,
        Op::Slide {
            clip: b,
            delta: t(4),
        },
    );
    assert_eq!(geom(&after, a), (0, 10, 14));
    assert_eq!(geom(&after, b), (14, 30, 10));
    assert_eq!(geom(&after, c), (24, 54, 6));
    let after = do_undo(
        &mut p,
        Op::Slide {
            clip: b,
            delta: t(-3),
        },
    );
    assert_eq!(geom(&after, a), (0, 10, 7));
    assert_eq!(geom(&after, b), (7, 30, 10));
    assert_eq!(geom(&after, c), (17, 47, 13));
    // Sliding past a neighbour's whole length, or the first clip into 0, is refused.
    assert_eq!(
        apply(
            &mut p,
            Op::Slide {
                clip: b,
                delta: t(10)
            }
        ),
        Err(OpError::EmptyClip)
    );
    assert!(apply(
        &mut p,
        Op::Slide {
            clip: a,
            delta: t(-1)
        }
    )
    .is_err());
}

#[test]
fn slide_leaves_a_non_touching_neighbour_alone_and_never_overruns_it() {
    let (mut p, _, _, [a, b, c], _) = row();
    // Open a 2-unit gap before c by trimming b's tail.
    apply(
        &mut p,
        Op::TrimOut {
            clip: b,
            end: t(18),
        },
    )
    .unwrap();
    let after = do_undo(
        &mut p,
        Op::Slide {
            clip: b,
            delta: t(2),
        },
    );
    assert_eq!(geom(&after, b), (12, 30, 8));
    assert_eq!(geom(&after, a), (0, 10, 12));
    assert_eq!(
        geom(&after, c),
        (20, 50, 10),
        "gap absorbed it, c untouched"
    );
    assert!(matches!(
        apply(
            &mut p,
            Op::Slide {
                clip: b,
                delta: t(3)
            }
        ),
        Err(OpError::Overlap { .. })
    ));
}

#[test]
fn compound_ops_refuse_a_locked_track_and_unknown_ids() {
    let (mut p, v1, _, [a, b, _], _) = row();
    apply(
        &mut p,
        Op::SetTrackProps {
            track: v1,
            name: None,
            muted: None,
            solo: None,
            locked: Some(true),
            hidden: None,
            height: None,
            colour: None,
        },
    )
    .unwrap();
    let before = p.clone();
    for op in [
        Op::RippleDelete {
            clip: a,
            all_tracks: true,
        },
        Op::RippleTrim {
            clip: a,
            edge: Edge::Out,
            delta: t(-1),
            all_tracks: false,
        },
        Op::CloseGap {
            track: v1,
            at: t(0),
            all_tracks: false,
        },
        Op::Roll {
            left: a,
            right: b,
            to: t(5),
        },
        Op::Slip {
            clip: a,
            delta: t(1),
        },
        Op::Slide {
            clip: b,
            delta: t(1),
        },
    ] {
        assert!(
            matches!(
                apply(&mut p, op.clone()),
                Err(OpError::TrackLocked(_)) | Err(OpError::NotInGap)
            ),
            "{op:?}"
        );
        assert_eq!(p, before);
    }
    let ghost = ClipId::new(&mut SeqIds::default());
    assert!(matches!(
        apply(
            &mut p,
            Op::RippleDelete {
                clip: ghost,
                all_tracks: false
            }
        ),
        Err(OpError::UnknownClip(_))
    ));
}

#[test]
fn editor_snap_json_snaps_excluding_dragged_clips_and_rejects_bad_input() {
    let (p, _, _, [a, b, _], _) = row();
    let e = Editor::from_project(p);
    let seq = e.project().sequences[0].id.to_string();
    let q = |v: serde_json::Value| {
        e.snap_json(&seq, &v.to_string())
            .map(|s| serde_json::from_str::<serde_json::Value>(&s).unwrap())
    };
    // 10_100 ticks: the cut between a and b is at 10 * U = 10_000; tolerance 200 reaches it.
    let r = q(serde_json::json!({"t": 10_100, "tolerance": 200})).unwrap();
    assert_eq!(
        (r["time"].as_i64(), r["delta"].as_i64()),
        (Some(10_000), Some(-100))
    );
    assert_eq!(r["hit"]["kind"], "clip_edge");
    // Excluding both clips that own that edge leaves only the other tracks' edges (15 * U): nothing near.
    let r = q(serde_json::json!({"t": 10_100, "tolerance": 200, "exclude": [a, b]})).unwrap();
    assert!(r["hit"].is_null() && r["delta"] == 0);
    // The playhead and markers are targets; a span snaps by its end.
    let r = q(serde_json::json!({"t": 3_000, "tolerance": 100, "playhead": 3_050})).unwrap();
    assert_eq!(r["hit"]["kind"], "playhead");
    let r = q(serde_json::json!({"t": 7_900, "tolerance": 200, "span": 2_000, "markers": [9_950]}))
        .unwrap();
    assert_eq!(
        (r["time"].as_i64(), r["hit"]["kind"].as_str()),
        (Some(7_950), Some("marker"))
    );
    assert!(q(serde_json::json!({"tolerance": 1})).is_err());
    assert!(e.snap_json("nope", "{}").is_err());
    assert!(e
        .snap_json(&"0".repeat(32), r#"{"t":0,"tolerance":0}"#)
        .is_err());
}

// ---- M2-003: clip transform ----

#[test]
fn set_clip_transform_applies_undoes_and_rejects_bad_values() {
    let (mut p, _tr, a, _b) = two_clips();
    let before = p.clone();
    let mut x = app_model::ClipTransform::default();
    x.scale_x = Animated::constant(0.5);
    x.rotation = Animated::constant(90.0);
    x.crop_left = Animated::constant(0.25);
    x.flip_v = true;
    let inv = apply(
        &mut p,
        Op::SetClipTransform {
            clip: a,
            transform: Box::new(x.clone()),
        },
    )
    .unwrap();
    let c = p.sequences[0]
        .tracks
        .iter()
        .flat_map(|t| &t.clips)
        .find(|c| c.id == a)
        .unwrap();
    assert_eq!(*c.transform, x);
    apply_all(&mut p, &inv.0).unwrap();
    assert_eq!(p, before, "undo restores the identity");

    for bad in [
        |t: &mut app_model::ClipTransform| t.scale_x = Animated::constant(0.0),
        |t: &mut app_model::ClipTransform| t.opacity = Animated::constant(1.5),
        |t: &mut app_model::ClipTransform| t.position_x = Animated::constant(f64::NAN),
        |t: &mut app_model::ClipTransform| t.crop_top = Animated::constant(1.0),
    ] {
        let mut t = app_model::ClipTransform::default();
        bad(&mut t);
        assert!(matches!(
            apply(
                &mut p,
                Op::SetClipTransform {
                    clip: a,
                    transform: Box::new(t)
                }
            ),
            Err(OpError::BadTransform)
        ));
        assert_eq!(p, before, "an error changes nothing");
    }
}

#[test]
fn split_keeps_the_transform_on_both_halves_and_evaluate_reports_it() {
    let (mut p, _tr, a, _b) = two_clips();
    let mut x = app_model::ClipTransform::default();
    x.opacity = Animated::constant(0.5);
    x.position_x = Animated::constant(0.25);
    apply(
        &mut p,
        Op::SetClipTransform {
            clip: a,
            transform: Box::new(x),
        },
    )
    .unwrap();
    let start = p.sequences[0]
        .tracks
        .iter()
        .flat_map(|t| &t.clips)
        .find(|c| c.id == a)
        .unwrap()
        .start;
    let new_id: ClipId =
        serde_json::from_value(serde_json::json!("00000000000000000000000000000999")).unwrap();
    apply(
        &mut p,
        Op::Split {
            clip: a,
            at: Time::from_ticks(start.ticks() + 2 * U),
            new_id,
            new_link: None,
        },
    )
    .unwrap();
    let seq = &p.sequences[0];
    let mut out = FrameDescription::default();
    for at in [start.ticks(), start.ticks() + 3 * U] {
        evaluate_into(seq, Time::from_ticks(at), 0, &mut out);
        let l = out
            .layers
            .iter()
            .find(|l| l.clip == a || l.clip == new_id)
            .unwrap();
        assert_eq!(l.opacity, 0.5);
        assert_eq!(l.props.position, [0.25, 0.0]);
    }
}

// ---- M2-004 keyframe ops (docs/features/keyframes.md) ----

fn key(t: i64, v: f64, easing: app_model::Easing) -> app_model::Keyframe {
    app_model::Keyframe {
        t: Time::from_ticks(t),
        v,
        easing,
    }
}

fn clip_transform(p: &Project, id: ClipId) -> app_model::ClipTransform {
    all_clips(p)
        .into_iter()
        .find(|c| c.id == id)
        .map(|c| (*c.transform).clone())
        .unwrap()
}

#[test]
fn keyframe_ops_set_move_delete_ease_and_undo() {
    use app_model::{Easing, TransformProp::Rotation};
    let (mut p, _tr, a, _b) = two_clips();
    let before = p.clone();
    let mut undo = Vec::new();
    for key in [key(0, 0.0, Easing::Linear), key(2000, 90.0, Easing::Linear)] {
        let inv = apply(
            &mut p,
            Op::SetKeyframe {
                clip: a,
                prop: Rotation,
                key,
            },
        )
        .unwrap();
        undo.push(inv);
    }
    assert_eq!(
        clip_transform(&p, a).rotation.eval(Time::from_ticks(1000)),
        45.0
    );
    // Replacing a key returns the old one as the inverse.
    let inv = apply(
        &mut p,
        Op::SetKeyframe {
            clip: a,
            prop: Rotation,
            key: key(2000, 180.0, Easing::Hold),
        },
    )
    .unwrap();
    assert_eq!(
        inv.0,
        vec![Op::SetKeyframe {
            clip: a,
            prop: Rotation,
            key: key(2000, 90.0, Easing::Linear)
        }]
    );
    apply_all(&mut p, &inv.0).unwrap();
    // Ease and move.
    undo.push(
        apply(
            &mut p,
            Op::SetEasing {
                clip: a,
                prop: Rotation,
                t: Time::from_ticks(0),
                easing: Easing::EASE_IN,
            },
        )
        .unwrap(),
    );
    undo.push(
        apply(
            &mut p,
            Op::MoveKeyframe {
                clip: a,
                prop: Rotation,
                from: Time::from_ticks(2000),
                to: Time::from_ticks(3000),
                value: Some(30.0),
            },
        )
        .unwrap(),
    );
    let x = clip_transform(&p, a);
    assert_eq!(x.rotation.keys[1].t, Time::from_ticks(3000));
    assert_eq!(x.rotation.keys[1].v, 30.0);
    assert_eq!(x.rotation.keys[0].easing, Easing::EASE_IN);
    // Moving onto another key, deleting or easing a missing key: refused, nothing changes.
    let snap = p.clone();
    for bad in [
        Op::MoveKeyframe {
            clip: a,
            prop: Rotation,
            from: Time::from_ticks(3000),
            to: Time::from_ticks(0),
            value: None,
        },
        Op::DeleteKeyframe {
            clip: a,
            prop: Rotation,
            t: Time::from_ticks(7),
        },
        Op::SetEasing {
            clip: a,
            prop: Rotation,
            t: Time::from_ticks(7),
            easing: Easing::Linear,
        },
        Op::SetKeyframe {
            clip: a,
            prop: Rotation,
            key: key(-1, 0.0, Easing::Linear),
        },
        Op::SetKeyframe {
            clip: a,
            prop: Rotation,
            key: key(5, f64::NAN, Easing::Linear),
        },
        Op::SetKeyframe {
            clip: a,
            prop: app_model::TransformProp::Opacity,
            key: key(5, 2.0, Easing::Linear),
        },
    ] {
        assert!(apply(&mut p, bad).is_err());
        assert_eq!(p, snap);
    }
    undo.push(
        apply(
            &mut p,
            Op::DeleteKeyframe {
                clip: a,
                prop: Rotation,
                t: Time::from_ticks(3000),
            },
        )
        .unwrap(),
    );
    assert_eq!(clip_transform(&p, a).rotation.keys.len(), 1);
    for inv in undo.iter().rev() {
        apply_all(&mut p, &inv.0).unwrap();
    }
    assert_eq!(
        p, before,
        "undoing every step restores the identity transform"
    );
}

#[test]
fn a_keyframe_drag_is_one_undo_step_and_replays_the_same() {
    use app_model::{Easing, TransformProp::PositionX};
    let (mut p, _tr, a, _b) = two_clips();
    let mut h = History::new();
    h.apply(
        &mut p,
        Op::SetKeyframe {
            clip: a,
            prop: PositionX,
            key: key(1000, 0.0, Easing::Linear),
        },
        None,
    )
    .unwrap();
    let before_drag = p.clone();
    // 200 moves of one key (time and value) under one gesture key.
    let mut at = 1000;
    for i in 1..=200 {
        let to = 1000 + i * 3;
        h.apply(
            &mut p,
            Op::MoveKeyframe {
                clip: a,
                prop: PositionX,
                from: Time::from_ticks(at),
                to: Time::from_ticks(to),
                value: Some(i as f64 / 100.0),
            },
            Some(77),
        )
        .unwrap();
        at = to;
    }
    assert_eq!(
        clip_transform(&p, a).position_x.keys[0].t,
        Time::from_ticks(1600)
    );
    // The journal replays to the same project on a fresh copy.
    let (mut fresh, _tr2, _a2, _b2) = two_clips();
    apply_all(&mut fresh, h.journal()).unwrap();
    assert_eq!(fresh, p, "replaying the journal gives the same document");
    assert!(h.undo(&mut p).unwrap());
    assert_eq!(p, before_drag, "one undo reverts the whole drag");
    assert!(h.redo(&mut p).unwrap());
    assert_eq!(
        clip_transform(&p, a).position_x.keys[0].t,
        Time::from_ticks(1600)
    );
}

#[test]
fn evaluate_reports_the_animated_values_at_the_frame() {
    use app_model::{Easing, TransformProp::Opacity};
    let (mut p, mut ids) = base();
    let m = p.media[2].id; // an image: no length limit, so the clip can be seconds long
    let c = Clip {
        duration: Time::from_seconds(4).unwrap(),
        ..clip(&mut ids, m, 0, 0, 1)
    };
    let a = c.id;
    p.sequences[0].tracks[0].clips = vec![c];
    for key in [
        key(0, 0.0, Easing::Linear),
        key(4 * app_model::TICKS_PER_SECOND, 1.0, Easing::Linear),
    ] {
        apply(
            &mut p,
            Op::SetKeyframe {
                clip: a,
                prop: Opacity,
                key,
            },
        )
        .unwrap();
    }
    let mut out = FrameDescription::default();
    for (frame, want) in [(0, 0.0f32), (30, 0.25), (60, 0.5), (90, 0.75)] {
        let at = Time::from_frame_index(frame, Rational::FPS_30).unwrap();
        evaluate_into(&p.sequences[0], at, 0, &mut out);
        let l = out.layers.iter().find(|l| l.clip == a).unwrap();
        assert!(
            (l.opacity - want).abs() < 1e-6,
            "frame {frame}: {}",
            l.opacity
        );
    }
}

/// < 1 us per parameter (ADR 0015, M2-004): all 12 properties with 8 keys each, evaluated at a moving time, in release builds.
#[test]
fn evaluating_a_fully_animated_transform_is_under_a_microsecond_per_parameter() {
    use app_model::{Animated, Easing};
    let mut x = app_model::ClipTransform::default();
    let keys = |amp: f64| {
        let mut a = Animated::constant(0.5);
        for i in 0..8 {
            a.set_key(key(
                i * 1000,
                0.1 + amp * (i % 3) as f64 * 0.1,
                Easing::EASE_IN_OUT,
            ))
            .unwrap();
        }
        a
    };
    for (i, prop) in PROPS.iter().enumerate() {
        *x.prop_mut(*prop) = keys(0.05 * (i % 4) as f64 + 0.05);
    }
    x.validate().unwrap();
    let n = 20_000u64;
    let started = std::time::Instant::now();
    let mut sink = 0.0f32;
    for i in 0..n {
        let v = x.at(Time::from_ticks((i * 37 % 7000) as i64));
        sink += v.opacity + v.position[0] + v.rotation;
    }
    let per_param = started.elapsed().as_nanos() as f64 / (n as f64 * 12.0);
    eprintln!("keyframe eval: {per_param:.0} ns per parameter (sink {sink})");
    let budget = if cfg!(debug_assertions) {
        20_000.0
    } else {
        1_000.0
    };
    assert!(
        per_param < budget,
        "{per_param} ns per parameter over {budget}"
    );
}

// ---- M2-007: markers, chapters, range ----

fn marker(
    ids: &mut SeqIds,
    time: i64,
    kind: app_model::MarkerKind,
    name: &str,
) -> app_model::Marker {
    app_model::Marker {
        id: app_model::MarkerId::new(ids),
        time: t(time),
        kind,
        name: name.into(),
        colour: None,
    }
}

#[test]
fn marker_ops_keep_order_refuse_bad_input_and_undo_exactly() {
    use app_model::MarkerKind::{Chapter, Marker as Plain};
    let (mut p, mut ids) = base();
    let seq = p.sequences[0].id;
    let (a, b, c) = (
        marker(&mut ids, 20, Plain, "b"),
        marker(&mut ids, 10, Chapter, "intro"),
        marker(&mut ids, 10, Plain, ""),
    );
    let mut h = History::new();
    for m in [&a, &b, &c] {
        h.apply(
            &mut p,
            Op::AddMarker {
                sequence: seq,
                marker: m.clone(),
            },
            None,
        )
        .unwrap();
    }
    let order = |p: &Project| {
        p.sequences[0]
            .markers
            .iter()
            .map(|m| m.id)
            .collect::<Vec<_>>()
    };
    // by time, then by id (b was created before c)
    assert_eq!(order(&p), vec![b.id, c.id, a.id]);
    p.validate().unwrap();

    // refusals change nothing
    let before = p.clone();
    let bad = |op: Op| {
        let mut q = before.clone();
        let e = apply(&mut q, op).unwrap_err();
        assert_eq!(q, before);
        e
    };
    let dup = Op::AddMarker {
        sequence: seq,
        marker: a.clone(),
    };
    assert!(matches!(bad(dup), OpError::IdInUse(_)));
    let neg = marker(&mut ids, -1, Plain, "");
    assert_eq!(
        bad(Op::AddMarker {
            sequence: seq,
            marker: neg
        }),
        OpError::BadMarker
    );
    let spaced = marker(&mut ids, 3, Plain, " x");
    assert_eq!(
        bad(Op::AddMarker {
            sequence: seq,
            marker: spaced
        }),
        OpError::BadMarker
    );
    let mut coloured = marker(&mut ids, 3, Plain, "");
    coloured.colour = Some("red".into());
    assert_eq!(
        bad(Op::AddMarker {
            sequence: seq,
            marker: coloured
        }),
        OpError::BadMarker
    );
    let unknown = app_model::MarkerId::new(&mut ids);
    assert_eq!(
        bad(Op::MoveMarker {
            marker: unknown,
            time: t(1)
        }),
        OpError::UnknownMarker(unknown)
    );
    assert_eq!(
        bad(Op::MoveMarker {
            marker: a.id,
            time: t(-5)
        }),
        OpError::BadMarker
    );
    assert_eq!(
        bad(Op::DeleteMarker { marker: unknown }),
        OpError::UnknownMarker(unknown)
    );
    let nowhere = SequenceId::new(&mut ids);
    let m = marker(&mut ids, 1, Plain, "");
    assert_eq!(
        bad(Op::AddMarker {
            sequence: nowhere,
            marker: m
        }),
        OpError::UnknownSequence(nowhere)
    );

    // move re-sorts; props patch and reset; delete; each undoes to the exact earlier state
    let s1 = p.clone();
    h.apply(
        &mut p,
        Op::MoveMarker {
            marker: a.id,
            time: t(5),
        },
        None,
    )
    .unwrap();
    assert_eq!(order(&p), vec![a.id, b.id, c.id]);
    let s2 = p.clone();
    h.apply(
        &mut p,
        Op::SetMarkerProps {
            marker: c.id,
            name: Some("beat".into()),
            kind: Some(Chapter),
            colour: Some(Some("#ff0000".into())),
        },
        None,
    )
    .unwrap();
    let m = &p.sequences[0].markers[2];
    assert_eq!(
        (m.name.as_str(), m.kind, m.colour.as_deref()),
        ("beat", Chapter, Some("#ff0000"))
    );
    let s3 = p.clone();
    h.apply(
        &mut p,
        Op::SetMarkerProps {
            marker: c.id,
            name: None,
            kind: None,
            colour: Some(None),
        },
        None,
    )
    .unwrap();
    assert_eq!(p.sequences[0].markers[2].colour, None);
    let s4 = p.clone();
    h.apply(&mut p, Op::DeleteMarker { marker: b.id }, None)
        .unwrap();
    assert_eq!(p.sequences[0].markers.len(), 2);
    for want in [&s4, &s3, &s2, &s1] {
        assert!(h.undo(&mut p).unwrap());
        assert_eq!(&p, want);
    }
}

#[test]
fn a_marker_drag_is_one_undo_step_and_range_ops_validate_and_undo() {
    use app_model::{MarkerKind::Marker as Plain, TimeRange};
    let (mut p, mut ids) = base();
    let seq = p.sequences[0].id;
    let m = marker(&mut ids, 4, Plain, "");
    let mut h = History::new();
    h.apply(
        &mut p,
        Op::AddMarker {
            sequence: seq,
            marker: m.clone(),
        },
        None,
    )
    .unwrap();
    let dragged = p.clone();
    for i in 0..50 {
        h.apply(
            &mut p,
            Op::MoveMarker {
                marker: m.id,
                time: t(5 + i),
            },
            Some(7),
        )
        .unwrap();
    }
    assert_eq!(p.sequences[0].markers[0].time, t(54));
    assert!(h.undo(&mut p).unwrap()); // the whole drag
    assert_eq!(p, dragged);
    assert!(h.redo(&mut p).unwrap());
    assert_eq!(p.sequences[0].markers[0].time, t(54));

    // range: set, loop, clear; bad ranges and looping without a range are refused
    let r = TimeRange {
        start: t(2),
        end: t(9),
    };
    let set = |range, looping| Op::SetRange {
        sequence: seq,
        range,
        looping,
    };
    let before = p.clone();
    h.apply(&mut p, set(Some(r), true), None).unwrap();
    assert_eq!(
        (p.sequences[0].range, p.sequences[0].loop_range),
        (Some(r), true)
    );
    p.validate().unwrap();
    for bad in [
        set(
            Some(TimeRange {
                start: t(3),
                end: t(3),
            }),
            false,
        ),
        set(
            Some(TimeRange {
                start: t(-1),
                end: t(3),
            }),
            false,
        ),
        set(None, true),
    ] {
        let mut q = p.clone();
        assert_eq!(apply(&mut q, bad).unwrap_err(), OpError::BadRange);
        assert_eq!(q, p);
    }
    h.apply(&mut p, set(None, false), None).unwrap();
    assert_eq!(p.sequences[0].range, None);
    assert!(h.undo(&mut p).unwrap());
    assert_eq!(p.sequences[0].range, Some(r));
    assert!(h.undo(&mut p).unwrap());
    assert_eq!(p, before);
}

#[test]
fn markers_are_snap_targets_without_the_caller_passing_them() {
    use app_model::MarkerKind::Chapter;
    let (mut p, mut ids) = base();
    let seq = p.sequences[0].id;
    apply(
        &mut p,
        Op::AddMarker {
            sequence: seq,
            marker: marker(&mut ids, 30, Chapter, "c"),
        },
    )
    .unwrap();
    let e = Editor::from_project(p);
    let s = e.project().sequences[0].id.to_string();
    let r: serde_json::Value = serde_json::from_str(
        &e.snap_json(
            &s,
            &serde_json::json!({"t": 30_400, "tolerance": 500}).to_string(),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        (r["time"].as_i64(), r["hit"]["kind"].as_str()),
        (Some(30_000), Some("marker"))
    );
}

// ---- M2-008: clip speed ----

fn rat(num: i64, den: i64) -> Rational {
    Rational { num, den }
}

fn speed_of(p: &Project, id: ClipId) -> Rational {
    all_clips(p).into_iter().find(|c| c.id == id).unwrap().speed
}

#[test]
fn set_speed_keeps_the_source_window_and_changes_the_length() {
    let (mut p, _, _, [a, b, c], o) = row();
    // 10 units of source at 2x last 5 units; at 1/2x, 20. Without ripple the gap stays open / the clip must fit.
    let after = do_undo(
        &mut p,
        Op::SetClipSpeed {
            clip: a,
            speed: rat(2, 1),
            ripple: false,
        },
    );
    assert_eq!(geom(&after, a), (0, 10, 5));
    assert_eq!(speed_of(&after, a), rat(2, 1));
    assert_eq!(geom(&after, b), (10, 30, 10), "no ripple: neighbours stay");
    // Slowing a clip that has a neighbour right behind it is refused whole.
    let before = p.clone();
    let e = apply(
        &mut p,
        Op::SetClipSpeed {
            clip: a,
            speed: rat(1, 2),
            ripple: false,
        },
    );
    assert!(
        matches!(e, Err(OpError::Batch { .. }) | Err(OpError::Overlap { .. })),
        "{e:?}"
    );
    assert_eq!(p, before);
    // With ripple the later clips of the track move by the change; the other track does not.
    let after = do_undo(
        &mut p,
        Op::SetClipSpeed {
            clip: a,
            speed: rat(1, 2),
            ripple: true,
        },
    );
    assert_eq!(geom(&after, a), (0, 10, 20));
    assert_eq!(geom(&after, b), (20, 30, 10));
    assert_eq!(geom(&after, c), (30, 50, 10));
    assert_eq!(geom(&after, o), (15, 0, 10));
    // Speeding up with ripple closes the gap.
    let after = do_undo(
        &mut p,
        Op::SetClipSpeed {
            clip: a,
            speed: rat(4, 1),
            ripple: true,
        },
    );
    assert_eq!(speed_of(&after, a), rat(4, 1));
    // 10 units = 10_000 ticks at 4x last 2_500 ticks: b closes up to start there.
    let b_start = all_clips(&after)
        .into_iter()
        .find(|x| x.id == b)
        .unwrap()
        .start;
    assert_eq!(b_start, Time::from_ticks(10_000 - 7_500));
}

#[test]
fn set_speed_rounds_down_to_whole_ticks_and_refuses_bad_values() {
    let (mut p, _, _, [_, _, c], _) = row();
    // 10_000 source ticks at 3/2x: 6666.67 ticks -> k = 10_000 / 3 = 3333 steps of 2 ticks = 6666 ticks, reading 9_999 source ticks.
    let after = do_undo(
        &mut p,
        Op::SetClipSpeed {
            clip: c,
            speed: rat(3, 2),
            ripple: false,
        },
    );
    let clip = all_clips(&after).into_iter().find(|x| x.id == c).unwrap();
    assert_eq!(clip.duration, Time::from_ticks(6_666));
    for bad in [rat(0, 1), rat(-1, 2), rat(1, 5), rat(41, 10), rat(5, 1)] {
        let before = p.clone();
        let e = apply(
            &mut p,
            Op::SetClipSpeed {
                clip: c,
                speed: bad,
                ripple: false,
            },
        );
        assert!(matches!(e, Err(OpError::BadSpeed)), "{bad:?}: {e:?}");
        assert_eq!(p, before);
    }
    assert!(matches!(
        apply(
            &mut p,
            Op::SetClipSpeed {
                clip: c,
                speed: rat(1, 0),
                ripple: false
            }
        ),
        Err(OpError::BadSpeed)
    ));
    // Speeding up cannot run past the media: 4x reads the same window, so it always fits; the original window is the limit.
    assert!(apply(
        &mut p,
        Op::SetClipSpeed {
            clip: c,
            speed: rat(4, 1),
            ripple: false
        }
    )
    .is_ok());
}

proptest! {
    #![proptest_config(ProptestConfig { max_shrink_iters: 2000, ..ProptestConfig::default() })]

    /// Any speed change that applies keeps the source window inside what it read before (never more), reads whole ticks, stays valid,
    /// and one undo restores the project exactly. After it, the source time of the clip's frames is monotonic.
    #[test]
    fn speed_change_keeps_window_undoes_exactly_and_maps_monotonically(
        num in 1..=16i64, den in 1..=4i64, dur in 1..40i64, ripple in any::<bool>(), second in 0..4usize,
    ) {
        let (mut p, mut ids) = base();
        let m = p.media[0].id;
        let c = clip(&mut ids, m, 0, 3, dur);
        let id = c.id;
        p.sequences[0].tracks[0].clips = vec![c];
        let before = p.clone();
        let old_src = i128::from(dur) * i128::from(U);
        let Ok(inv) = apply(&mut p, Op::SetClipSpeed { clip: id, speed: rat(num, den), ripple }) else {
            prop_assert_eq!(&p, &before);
            return Ok(());
        };
        p.validate().unwrap();
        let c = all_clips(&p).into_iter().find(|c| c.id == id).unwrap();
        let read = i128::from(c.duration.ticks()) * i128::from(c.speed.num) / i128::from(c.speed.den);
        prop_assert!(read <= old_src && old_src - read < i128::from(c.speed.num.max(1)));
        // Source time at consecutive timeline ticks never goes back.
        let mut prev = i128::MIN;
        for step in 0..c.duration.ticks().min(200 + second as i64) {
            let st = i128::from(c.source_in.ticks()) + i128::from(step) * i128::from(c.speed.num) / i128::from(c.speed.den);
            prop_assert!(st >= prev);
            prev = st;
        }
        apply_all(&mut p, &inv.0).unwrap();
        prop_assert_eq!(&p, &before);
    }
}

fn audio_of(p: &Project, id: ClipId) -> app_model::ClipAudio {
    all_clips(p).into_iter().find(|c| c.id == id).unwrap().audio
}

#[test]
fn set_clip_audio_sets_volume_and_fades_and_undoes_in_one_step() {
    let (mut p, _, _, [a, ..], _) = row();
    let want = app_model::ClipAudio {
        volume: 0.5,
        fade_in: t(2),
        fade_out: t(3),
    };
    let after = do_undo(
        &mut p,
        Op::SetClipAudio {
            clip: a,
            audio: want,
        },
    );
    assert_eq!(audio_of(&after, a), want);
    assert!(audio_of(&p, a).is_default(), "undo restores the plain clip");
    // A slider drag (same key) is one undo step.
    let mut h = History::new();
    for v in [60u8, 70, 80] {
        let audio = app_model::ClipAudio {
            volume: f32::from(v) / 100.0,
            ..Default::default()
        };
        h.apply(&mut p, Op::SetClipAudio { clip: a, audio }, Some(7))
            .unwrap();
    }
    assert_eq!(audio_of(&p, a).volume, 0.8);
    assert!(h.undo(&mut p).unwrap());
    assert!(audio_of(&p, a).is_default());
    assert!(!h.can_undo());
}

#[test]
fn set_clip_audio_refuses_what_is_out_of_range() {
    let (mut p, _, _, [a, ..], _) = row();
    let before = p.clone();
    for bad in [
        app_model::ClipAudio {
            volume: 2.5,
            ..Default::default()
        },
        app_model::ClipAudio {
            volume: -0.5,
            ..Default::default()
        },
        app_model::ClipAudio {
            volume: f32::NAN,
            ..Default::default()
        },
        app_model::ClipAudio {
            fade_in: t(-1),
            ..Default::default()
        },
    ] {
        assert_eq!(
            apply(
                &mut p,
                Op::SetClipAudio {
                    clip: a,
                    audio: bad
                }
            ),
            Err(OpError::BadAudio)
        );
        assert_eq!(p, before);
    }
}

#[test]
fn split_gives_the_fade_in_to_the_left_and_the_fade_out_to_the_right_and_undo_restores_both() {
    let (mut p, mut ids) = base();
    let m = p.media[0].id;
    let mut c = clip(&mut ids, m, 0, 0, 10);
    c.audio = app_model::ClipAudio {
        volume: 0.7,
        fade_in: t(2),
        fade_out: t(3),
    };
    let id = c.id;
    p.sequences[0].tracks[0].clips = vec![c];
    let new_id = ClipId::new(&mut ids);
    let after = do_undo(
        &mut p,
        Op::Split {
            clip: id,
            at: t(5),
            new_id,
            new_link: None,
        },
    );
    let (l, r) = (audio_of(&after, id), audio_of(&after, new_id));
    assert_eq!((l.volume, l.fade_in, l.fade_out), (0.7, t(2), Time::ZERO));
    assert_eq!((r.volume, r.fade_in, r.fade_out), (0.7, Time::ZERO, t(3)));
}

#[test]
fn a_clip_with_audio_survives_the_file_round_trip_and_a_plain_one_writes_nothing() {
    let (mut p, _, _, [a, b, _], _) = row();
    apply(
        &mut p,
        Op::SetClipAudio {
            clip: a,
            audio: app_model::ClipAudio {
                volume: 1.5,
                fade_in: t(1),
                fade_out: Time::ZERO,
            },
        },
    )
    .unwrap();
    let json = serde_json::to_string(&p).unwrap();
    assert_eq!(
        json.matches("\"audio\":{").count(),
        1,
        "only the clip that has one writes it"
    );
    let back: Project = serde_json::from_str(&json).unwrap();
    assert_eq!(back, p);
    assert!(audio_of(&back, b).is_default());
}
