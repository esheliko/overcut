//! `apply`: validate, then mutate. Every check runs before the first write, so an error leaves the project untouched.

use crate::op::{Inverse, Op};
use app_model::{
    Clip, ClipAudio, ClipId, MediaId, MediaKind, Project, Rational, Time, Track, TrackId, TrackKind,
};
use std::fmt;

#[derive(Clone, Debug, PartialEq)]
pub enum OpError {
    UnknownClip(ClipId),
    UnknownTrack(TrackId),
    UnknownMedia(ClipId),
    /// `SetMedia` names a media id the project does not have.
    UnknownMediaId(MediaId),
    /// `RemoveMedia` of a media some clip still uses.
    MediaInUse(MediaId),
    UnknownSequence(app_model::SequenceId),
    /// A frame rate or size of zero.
    BadFormat,
    /// `SetMedia` / `AddMedia` with an empty uri, or a hash that is not a `b3-64k` fingerprint.
    BadMediaRef,
    /// `SetMediaTags` with an empty, untrimmed, duplicate or too long tag, or too many tags.
    BadTags,
    /// `SetClipTransform` (or an inserted clip) with a non-finite value, a scale <= 0, or opacity / crop out of range.
    BadTransform,
    /// `DeleteKeyframe` / `MoveKeyframe` / `SetEasing` at a time that holds no key.
    NoKeyframe,
    /// `SetClipAudio` with a volume outside `0..=2`, or a negative or non-finite value.
    BadAudio,
    /// `MoveKeyframe` onto a time that already holds another key.
    KeyframeOccupied,
    /// The id of a new clip is already used by something in the document.
    IdInUse(String),
    TrackLocked(TrackId),
    /// The track takes other media (video track with audio-only media, ...).
    KindMismatch,
    /// Overlaps the clip `with` on the destination track.
    Overlap {
        with: ClipId,
    },
    /// `in >= out`: zero or negative length.
    EmptyClip,
    /// Negative start or source_in, non-positive speed, or arithmetic overflow.
    OutOfRange,
    /// Reads past the end of the source media.
    BeyondMedia,
    /// `Split.at` is not strictly inside the clip.
    SplitOutside,
    /// A speed ratio would need a fraction of a tick.
    InexactSpeed,
    /// `SetClipSpeed` with a speed outside `MIN_SPEED..=MAX_SPEED`.
    BadSpeed,
    /// `SetTrackProps` / `AddTrack` with a bad name (empty, untrimmed, over `MAX_TRACK_NAME`), height or colour.
    BadTrack,
    /// A sequence may hold at most `MAX_TRACKS` tracks.
    TooManyTracks,
    /// `AddTrack` / `MoveTrack` position beyond the end of the stack.
    BadTrackIndex,
    /// `Roll` between clips that are not on one track or do not touch.
    NotAdjacent,
    /// `CloseGap` at a time that is on a clip or after the last clip, so there is no gap to close.
    NotInGap,
    UnknownMarker(app_model::MarkerId),
    /// `AddMarker` / `MoveMarker` / `SetMarkerProps` with a negative time, or a bad name or colour.
    BadMarker,
    /// A sequence may hold at most `MAX_MARKERS` markers.
    TooManyMarkers,
    /// `SetRange` with `start < 0`, `end <= start`, or `looping` without a range.
    BadRange,
    /// `SetBackground` with a blur above 100.
    BadBackground,
    /// A batch step failed; earlier steps were rolled back.
    Batch {
        index: usize,
        cause: Box<OpError>,
    },
}

impl fmt::Display for OpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for OpError {}

/// Where a clip lives. Indices are valid only until the next mutation.
#[derive(Clone, Copy)]
pub(crate) struct Loc {
    pub(crate) seq: usize,
    pub(crate) track: usize,
    pub(crate) clip: usize,
}

pub(crate) fn find_clip(p: &Project, id: ClipId) -> Option<Loc> {
    for (si, s) in p.sequences.iter().enumerate() {
        for (ti, t) in s.tracks.iter().enumerate() {
            if let Some(ci) = t.clips.iter().position(|c| c.id == id) {
                return Some(Loc {
                    seq: si,
                    track: ti,
                    clip: ci,
                });
            }
        }
    }
    None
}

pub(crate) fn find_track(p: &Project, id: TrackId) -> Option<(usize, usize)> {
    p.sequences
        .iter()
        .enumerate()
        .find_map(|(si, s)| s.tracks.iter().position(|t| t.id == id).map(|ti| (si, ti)))
}

/// True when any part of the document already uses this id.
fn id_in_use(p: &Project, id: app_model::Id) -> bool {
    p.id.0 == id
        || p.media.iter().any(|m| m.id.0 == id)
        || p.sequences.iter().any(|s| {
            s.id.0 == id
                || s.markers.iter().any(|m| m.id.0 == id)
                || s.tracks
                    .iter()
                    .any(|t| t.id.0 == id || t.clips.iter().any(|c| c.id.0 == id))
        })
}

/// Source ticks a stretch of timeline ticks consumes at `speed` (`None` if it is not a whole number of ticks).
pub(crate) fn scaled(d: Time, speed: Rational) -> Result<Time, OpError> {
    let n = i128::from(d.ticks()) * i128::from(speed.num);
    let den = i128::from(speed.den);
    if den <= 0 || n % den != 0 {
        return Err(OpError::InexactSpeed);
    }
    i64::try_from(n / den)
        .map(Time::from_ticks)
        .map_err(|_| OpError::OutOfRange)
}

pub(crate) fn add(a: Time, b: Time) -> Result<Time, OpError> {
    a.checked_add(b).ok_or(OpError::OutOfRange)
}

pub(crate) fn sub(a: Time, b: Time) -> Result<Time, OpError> {
    a.checked_sub(b).ok_or(OpError::OutOfRange)
}

/// Checks the clip as it would stand on `track` (everything but its position among the neighbours is checked here).
fn check_clip(p: &Project, track: &Track, c: &Clip) -> Result<(), OpError> {
    let media = p
        .media
        .iter()
        .find(|m| m.id == c.media)
        .ok_or(OpError::UnknownMedia(c.id))?;
    if c.duration <= Time::ZERO {
        return Err(OpError::EmptyClip);
    }
    if c.start < Time::ZERO || c.source_in < Time::ZERO || c.speed.num <= 0 || c.speed.den <= 0 {
        return Err(OpError::OutOfRange);
    }
    let kind_ok = match track.kind {
        TrackKind::Video => matches!(media.kind, MediaKind::Video | MediaKind::Image),
        TrackKind::Audio => matches!(media.kind, MediaKind::Audio | MediaKind::Video),
    };
    if !kind_ok {
        return Err(OpError::KindMismatch);
    }
    c.end().ok_or(OpError::OutOfRange)?;
    c.transform.validate().map_err(|_| OpError::BadTransform)?;
    if !c.audio.is_in_range() {
        return Err(OpError::BadAudio);
    }
    if let Some(len) = media.duration {
        let end_in_source = add(c.source_in, scaled(c.duration, c.speed)?)?;
        if end_in_source > len {
            return Err(OpError::BeyondMedia);
        }
    }
    Ok(())
}

/// Checks `c` against its neighbours on `track`, ignoring the clip `skip` (the clip itself when it already sits there).
fn check_overlap(track: &Track, c: &Clip, skip: Option<ClipId>) -> Result<(), OpError> {
    let end = c.end().ok_or(OpError::OutOfRange)?;
    // Clips are sorted and disjoint, so only the nearest neighbour on each side can collide.
    let at = track.clips.partition_point(|o| o.start < c.start);
    let mut before = track.clips[..at]
        .iter()
        .rev()
        .filter(|o| Some(o.id) != skip);
    if let Some(prev) = before.next() {
        if prev.end().ok_or(OpError::OutOfRange)? > c.start {
            return Err(OpError::Overlap { with: prev.id });
        }
    }
    let mut after = track.clips[at..].iter().filter(|o| Some(o.id) != skip);
    if let Some(next) = after.next() {
        if next.start < end {
            return Err(OpError::Overlap { with: next.id });
        }
    }
    Ok(())
}

fn unlocked(t: &Track) -> Result<(), OpError> {
    if t.locked {
        Err(OpError::TrackLocked(t.id))
    } else {
        Ok(())
    }
}

/// Finds the clip for a keyframe op, checks the track is unlocked and the key time is `>= 0`, and returns a copy of its transform to edit
/// (the edit is validated before it is written back, so an error changes nothing; a transform is a few hundred bytes).
fn key_target(
    p: &Project,
    clip: ClipId,
    t: Time,
) -> Result<(Loc, app_model::ClipTransform), OpError> {
    let loc = find_clip(p, clip).ok_or(OpError::UnknownClip(clip))?;
    unlocked(&p.sequences[loc.seq].tracks[loc.track])?;
    if t.ticks() < 0 {
        return Err(OpError::OutOfRange);
    }
    let x = (*p.sequences[loc.seq].tracks[loc.track].clips[loc.clip].transform).clone();
    Ok((loc, x))
}

fn track_mut(p: &mut Project, seq: usize, track: usize) -> &mut Track {
    &mut p.sequences[seq].tracks[track]
}

fn insert_sorted(t: &mut Track, c: Clip) {
    let at = t.clips.partition_point(|o| o.start < c.start);
    t.clips.insert(at, c);
}

/// Replace a clip's geometry. `SetClip` can hop a clip over a neighbour (the gap allows it), so re-seat it in sorted order.
fn set_geometry(
    t: &mut Track,
    idx: usize,
    start: Time,
    source_in: Time,
    duration: Time,
    speed: Option<Rational>,
) {
    let mut c = t.clips.remove(idx);
    if let Some(s) = speed {
        c.speed = s;
    }
    c.start = start;
    c.source_in = source_in;
    c.duration = duration;
    insert_sorted(t, c);
}

fn clip_at(p: &Project, loc: Loc) -> &Clip {
    &p.sequences[loc.seq].tracks[loc.track].clips[loc.clip]
}

fn restore_geometry(loc_clip: &Clip) -> Op {
    Op::SetClip {
        clip: loc_clip.id,
        start: loc_clip.start,
        source_in: loc_clip.source_in,
        duration: loc_clip.duration,
        speed: None,
    }
}

fn find_marker(p: &Project, id: app_model::MarkerId) -> Result<(usize, usize), OpError> {
    p.sequences
        .iter()
        .enumerate()
        .find_map(|(si, s)| s.markers.iter().position(|m| m.id == id).map(|mi| (si, mi)))
        .ok_or(OpError::UnknownMarker(id))
}

/// Keeps `markers` ordered by (time, id).
fn insert_marker(s: &mut app_model::Sequence, m: app_model::Marker) {
    let at = s
        .markers
        .partition_point(|o| (o.time, o.id) < (m.time, m.id));
    s.markers.insert(at, m);
}

fn check_marker(m: &app_model::Marker) -> Result<(), OpError> {
    (m.time >= Time::ZERO && app_model::marker_props_ok(&m.name, m.colour.as_deref()))
        .then_some(())
        .ok_or(OpError::BadMarker)
}

/// Most tracks one sequence may hold (a UI and render-cost guard, not a model limit).
pub const MAX_TRACKS: usize = 64;

fn valid_track_name(n: &str) -> bool {
    !n.is_empty() && n.trim() == n && n.chars().count() <= app_model::MAX_TRACK_NAME
}

fn valid_track_height(h: u32) -> bool {
    (app_model::MIN_TRACK_HEIGHT..=app_model::MAX_TRACK_HEIGHT).contains(&h)
}

/// Everything about a track that is not its clips: name, height and colour in range.
fn check_track_props(t: &Track) -> Result<(), OpError> {
    let ok = valid_track_name(&t.name)
        && t.height.is_none_or(valid_track_height)
        && t.colour.as_deref().is_none_or(app_model::is_track_colour);
    ok.then_some(()).ok_or(OpError::BadTrack)
}

pub const MAX_TAGS: usize = 16;
pub const MAX_TAG_LEN: usize = 40;

/// Tags are trimmed, non-empty, unique (case-insensitively), short, and few.
fn valid_tags(tags: &[String]) -> bool {
    tags.len() <= MAX_TAGS
        && tags.iter().enumerate().all(|(i, t)| {
            !t.is_empty()
                && t.trim() == t
                && t.chars().count() <= MAX_TAG_LEN
                && !tags[..i]
                    .iter()
                    .any(|o| o.to_lowercase() == t.to_lowercase())
        })
}

/// Applies `op` and returns the ops that undo it. On `Err` the project is exactly as it was.
pub fn apply(p: &mut Project, op: Op) -> Result<Inverse, OpError> {
    match op {
        Op::SetMedia { media, uri, hash } => {
            if uri.is_empty()
                || hash
                    .as_deref()
                    .is_some_and(|h| app_model::fingerprint_size(h).is_none())
            {
                return Err(OpError::BadMediaRef);
            }
            let m = p
                .media
                .iter_mut()
                .find(|m| m.id == media)
                .ok_or(OpError::UnknownMediaId(media))?;
            let old = Op::SetMedia {
                media,
                uri: std::mem::replace(&mut m.uri, uri),
                hash: std::mem::replace(&mut m.hash, hash),
            };
            Ok(Inverse(vec![old]))
        }
        Op::SetMediaTags { media, tags } => {
            if !valid_tags(&tags) {
                return Err(OpError::BadTags);
            }
            let m = p
                .media
                .iter_mut()
                .find(|m| m.id == media)
                .ok_or(OpError::UnknownMediaId(media))?;
            let old = Op::SetMediaTags {
                media,
                tags: std::mem::replace(&mut m.tags, tags),
            };
            Ok(Inverse(vec![old]))
        }
        Op::AddMedia { media, index } => {
            if media.uri.is_empty()
                || media
                    .hash
                    .as_deref()
                    .is_some_and(|h| app_model::fingerprint_size(h).is_none())
            {
                return Err(OpError::BadMediaRef);
            }
            if id_in_use(p, media.id.0) {
                return Err(OpError::IdInUse(media.id.to_string()));
            }
            let id = media.id;
            let at = index.map_or(p.media.len(), |i| i.min(p.media.len()));
            p.media.insert(at, media);
            Ok(Inverse(vec![Op::RemoveMedia { media: id }]))
        }
        Op::RemoveMedia { media } => {
            let i = p
                .media
                .iter()
                .position(|m| m.id == media)
                .ok_or(OpError::UnknownMediaId(media))?;
            let used = p.sequences.iter().any(|s| {
                s.tracks
                    .iter()
                    .any(|t| t.clips.iter().any(|c| c.media == media))
            });
            if used {
                return Err(OpError::MediaInUse(media));
            }
            let removed = p.media.remove(i);
            Ok(Inverse(vec![Op::AddMedia {
                media: removed,
                index: Some(i),
            }]))
        }
        Op::SetSequenceFormat {
            sequence,
            frame_rate,
            resolution,
        } => {
            if frame_rate.num <= 0
                || frame_rate.den <= 0
                || resolution.width == 0
                || resolution.height == 0
            {
                return Err(OpError::BadFormat);
            }
            let s = p
                .sequences
                .iter_mut()
                .find(|s| s.id == sequence)
                .ok_or(OpError::UnknownSequence(sequence))?;
            let old = Op::SetSequenceFormat {
                sequence,
                frame_rate: std::mem::replace(&mut s.frame_rate, frame_rate),
                resolution: std::mem::replace(&mut s.resolution, resolution),
            };
            Ok(Inverse(vec![old]))
        }
        Op::SetCanvas {
            sequence,
            frame_rate,
            resolution,
            size_fixed,
            rate_fixed,
        } => {
            const MAX_SIDE: u32 = 16_384;
            if frame_rate.num <= 0
                || frame_rate.den <= 0
                || resolution.width == 0
                || resolution.height == 0
                || resolution.width > MAX_SIDE
                || resolution.height > MAX_SIDE
            {
                return Err(OpError::BadFormat);
            }
            let s = p
                .sequences
                .iter_mut()
                .find(|s| s.id == sequence)
                .ok_or(OpError::UnknownSequence(sequence))?;
            let old = Op::SetCanvas {
                sequence,
                frame_rate: std::mem::replace(&mut s.frame_rate, frame_rate),
                resolution: std::mem::replace(&mut s.resolution, resolution),
                size_fixed: std::mem::replace(&mut s.size_fixed, size_fixed),
                rate_fixed: std::mem::replace(&mut s.rate_fixed, rate_fixed),
            };
            Ok(Inverse(vec![old]))
        }
        Op::AddTrack {
            sequence,
            track,
            index,
        } => {
            let si = p
                .sequences
                .iter()
                .position(|s| s.id == sequence)
                .ok_or(OpError::UnknownSequence(sequence))?;
            let n = p.sequences[si].tracks.len();
            if n >= MAX_TRACKS {
                return Err(OpError::TooManyTracks);
            }
            if index > n {
                return Err(OpError::BadTrackIndex);
            }
            check_track_props(&track)?;
            if id_in_use(p, track.id.0) {
                return Err(OpError::IdInUse(track.id.to_string()));
            }
            let mut prev_end = Time::ZERO;
            for (i, c) in track.clips.iter().enumerate() {
                if id_in_use(p, c.id.0)
                    || c.id.0 == track.id.0
                    || track.clips[..i].iter().any(|o| o.id == c.id)
                {
                    return Err(OpError::IdInUse(c.id.to_string()));
                }
                check_clip(p, &track, c)?;
                if c.start < prev_end {
                    return Err(OpError::Overlap { with: c.id });
                }
                prev_end = c.end().ok_or(OpError::OutOfRange)?;
            }
            let id = track.id;
            p.sequences[si].tracks.insert(index, track);
            Ok(Inverse(vec![Op::RemoveTrack { track: id }]))
        }
        Op::RemoveTrack { track } => {
            let (si, ti) = find_track(p, track).ok_or(OpError::UnknownTrack(track))?;
            unlocked(&p.sequences[si].tracks[ti])?;
            let removed = p.sequences[si].tracks.remove(ti);
            Ok(Inverse(vec![Op::AddTrack {
                sequence: p.sequences[si].id,
                track: removed,
                index: ti,
            }]))
        }
        Op::MoveTrack { track, index } => {
            let (si, ti) = find_track(p, track).ok_or(OpError::UnknownTrack(track))?;
            let tracks = &mut p.sequences[si].tracks;
            if index >= tracks.len() {
                return Err(OpError::BadTrackIndex);
            }
            let t = tracks.remove(ti);
            tracks.insert(index, t);
            Ok(Inverse(vec![Op::MoveTrack { track, index: ti }]))
        }
        Op::SetTrackProps {
            track,
            name,
            muted,
            solo,
            locked,
            hidden,
            height,
            colour,
        } => {
            let (si, ti) = find_track(p, track).ok_or(OpError::UnknownTrack(track))?;
            let t = &mut p.sequences[si].tracks[ti];
            // Build the changed track first and check it, so a bad patch leaves the project as it was.
            let mut next = t.clone();
            let mut undo = Op::SetTrackProps {
                track,
                name: None,
                muted: None,
                solo: None,
                locked: None,
                hidden: None,
                height: None,
                colour: None,
            };
            let Op::SetTrackProps {
                name: u_name,
                muted: u_muted,
                solo: u_solo,
                locked: u_locked,
                hidden: u_hidden,
                height: u_height,
                colour: u_colour,
                ..
            } = &mut undo
            else {
                unreachable!()
            };
            if let Some(v) = name {
                *u_name = Some(std::mem::replace(&mut next.name, v));
            }
            if let Some(v) = muted {
                *u_muted = Some(std::mem::replace(&mut next.muted, v));
            }
            if let Some(v) = solo {
                *u_solo = Some(std::mem::replace(&mut next.solo, v));
            }
            if let Some(v) = locked {
                *u_locked = Some(std::mem::replace(&mut next.locked, v));
            }
            if let Some(v) = hidden {
                *u_hidden = Some(std::mem::replace(&mut next.hidden, v));
            }
            if let Some(v) = height {
                *u_height = Some(std::mem::replace(&mut next.height, v));
            }
            if let Some(v) = colour {
                *u_colour = Some(std::mem::replace(&mut next.colour, v));
            }
            check_track_props(&next)?;
            *t = next;
            Ok(Inverse(vec![undo]))
        }
        Op::AddMarker { sequence, marker } => {
            let si = p
                .sequences
                .iter()
                .position(|s| s.id == sequence)
                .ok_or(OpError::UnknownSequence(sequence))?;
            check_marker(&marker)?;
            if id_in_use(p, marker.id.0) {
                return Err(OpError::IdInUse(marker.id.to_string()));
            }
            let s = &mut p.sequences[si];
            if s.markers.len() >= app_model::MAX_MARKERS {
                return Err(OpError::TooManyMarkers);
            }
            let id = marker.id;
            insert_marker(s, marker);
            Ok(Inverse(vec![Op::DeleteMarker { marker: id }]))
        }
        Op::MoveMarker { marker, time } => {
            let (si, mi) = find_marker(p, marker)?;
            if time < Time::ZERO {
                return Err(OpError::BadMarker);
            }
            let s = &mut p.sequences[si];
            let mut m = s.markers.remove(mi);
            let old = std::mem::replace(&mut m.time, time);
            insert_marker(s, m);
            Ok(Inverse(vec![Op::MoveMarker { marker, time: old }]))
        }
        Op::SetMarkerProps {
            marker,
            name,
            kind,
            colour,
        } => {
            let (si, mi) = find_marker(p, marker)?;
            let mut next = p.sequences[si].markers[mi].clone();
            let mut undo = (None, None, None);
            if let Some(v) = name {
                undo.0 = Some(std::mem::replace(&mut next.name, v));
            }
            if let Some(v) = kind {
                undo.1 = Some(std::mem::replace(&mut next.kind, v));
            }
            if let Some(v) = colour {
                undo.2 = Some(std::mem::replace(&mut next.colour, v));
            }
            check_marker(&next)?;
            p.sequences[si].markers[mi] = next;
            Ok(Inverse(vec![Op::SetMarkerProps {
                marker,
                name: undo.0,
                kind: undo.1,
                colour: undo.2,
            }]))
        }
        Op::DeleteMarker { marker } => {
            let (si, mi) = find_marker(p, marker)?;
            let s = &mut p.sequences[si];
            let removed = s.markers.remove(mi);
            Ok(Inverse(vec![Op::AddMarker {
                sequence: s.id,
                marker: removed,
            }]))
        }
        Op::SetRange {
            sequence,
            range,
            looping,
        } => {
            let s = p
                .sequences
                .iter_mut()
                .find(|s| s.id == sequence)
                .ok_or(OpError::UnknownSequence(sequence))?;
            if range.is_some_and(|r| r.start < Time::ZERO || r.end <= r.start)
                || (looping && range.is_none())
            {
                return Err(OpError::BadRange);
            }
            let undo = Op::SetRange {
                sequence,
                range: std::mem::replace(&mut s.range, range),
                looping: std::mem::replace(&mut s.loop_range, looping),
            };
            Ok(Inverse(vec![undo]))
        }
        Op::SetBackground {
            sequence,
            background,
        } => {
            if background.blur > app_model::MAX_BLUR {
                return Err(OpError::BadBackground);
            }
            let s = p
                .sequences
                .iter_mut()
                .find(|s| s.id == sequence)
                .ok_or(OpError::UnknownSequence(sequence))?;
            let undo = Op::SetBackground {
                sequence,
                background: std::mem::replace(&mut s.background, background),
            };
            Ok(Inverse(vec![undo]))
        }
        Op::InsertClip { track, clip } => {
            let (si, ti) = find_track(p, track).ok_or(OpError::UnknownTrack(track))?;
            let t = &p.sequences[si].tracks[ti];
            unlocked(t)?;
            if id_in_use(p, clip.id.0) {
                return Err(OpError::IdInUse(clip.id.to_string()));
            }
            check_clip(p, t, &clip)?;
            check_overlap(t, &clip, None)?;
            let id = clip.id;
            insert_sorted(track_mut(p, si, ti), clip);
            Ok(Inverse(vec![Op::Delete { clip: id }]))
        }
        Op::Delete { clip } => {
            let loc = find_clip(p, clip).ok_or(OpError::UnknownClip(clip))?;
            unlocked(&p.sequences[loc.seq].tracks[loc.track])?;
            let t = track_mut(p, loc.seq, loc.track);
            let track = t.id;
            let removed = t.clips.remove(loc.clip);
            Ok(Inverse(vec![Op::InsertClip {
                track,
                clip: removed,
            }]))
        }
        Op::SetLink { clip, link } => {
            let loc = find_clip(p, clip).ok_or(OpError::UnknownClip(clip))?;
            let t = track_mut(p, loc.seq, loc.track);
            let old = std::mem::replace(&mut t.clips[loc.clip].link, link);
            Ok(Inverse(vec![Op::SetLink { clip, link: old }]))
        }
        Op::SetClipTransform { clip, transform } => {
            let loc = find_clip(p, clip).ok_or(OpError::UnknownClip(clip))?;
            unlocked(&p.sequences[loc.seq].tracks[loc.track])?;
            transform.validate().map_err(|_| OpError::BadTransform)?;
            let t = track_mut(p, loc.seq, loc.track);
            let old = std::mem::replace(&mut t.clips[loc.clip].transform, transform);
            Ok(Inverse(vec![Op::SetClipTransform {
                clip,
                transform: old,
            }]))
        }
        Op::SetClipAudio { clip, audio } => {
            let loc = find_clip(p, clip).ok_or(OpError::UnknownClip(clip))?;
            unlocked(&p.sequences[loc.seq].tracks[loc.track])?;
            let t = track_mut(p, loc.seq, loc.track);
            if !audio.is_in_range() {
                return Err(OpError::BadAudio);
            }
            let old = std::mem::replace(&mut t.clips[loc.clip].audio, audio);
            Ok(Inverse(vec![Op::SetClipAudio { clip, audio: old }]))
        }
        Op::SetKeyframe { clip, prop, key } => {
            let (loc, mut x) = key_target(p, clip, key.t)?;
            let old = x
                .prop_mut(prop)
                .set_key(key)
                .map_err(|_| OpError::BadTransform)?;
            x.validate().map_err(|_| OpError::BadTransform)?;
            *track_mut(p, loc.seq, loc.track).clips[loc.clip].transform = x;
            Ok(Inverse(vec![match old {
                Some(old) => Op::SetKeyframe {
                    clip,
                    prop,
                    key: old,
                },
                None => Op::DeleteKeyframe {
                    clip,
                    prop,
                    t: key.t,
                },
            }]))
        }
        Op::MoveKeyframe {
            clip,
            prop,
            from,
            to,
            value,
        } => {
            let (loc, mut x) = key_target(p, clip, to)?;
            let a = x.prop_mut(prop);
            let i = a
                .keys
                .binary_search_by(|k| k.t.cmp(&from))
                .map_err(|_| OpError::NoKeyframe)?;
            if from != to && a.keys.binary_search_by(|k| k.t.cmp(&to)).is_ok() {
                return Err(OpError::KeyframeOccupied);
            }
            let old = a.keys.remove(i);
            let new = app_model::Keyframe {
                t: to,
                v: value.unwrap_or(old.v),
                ..old
            };
            a.set_key(new).map_err(|_| OpError::BadTransform)?;
            x.validate().map_err(|_| OpError::BadTransform)?;
            *track_mut(p, loc.seq, loc.track).clips[loc.clip].transform = x;
            Ok(Inverse(vec![Op::MoveKeyframe {
                clip,
                prop,
                from: to,
                to: from,
                value: Some(old.v),
            }]))
        }
        Op::DeleteKeyframe { clip, prop, t } => {
            let (loc, mut x) = key_target(p, clip, t)?;
            let old = x
                .prop_mut(prop)
                .remove_key(t)
                .map_err(|_| OpError::NoKeyframe)?;
            x.validate().map_err(|_| OpError::BadTransform)?;
            *track_mut(p, loc.seq, loc.track).clips[loc.clip].transform = x;
            Ok(Inverse(vec![Op::SetKeyframe {
                clip,
                prop,
                key: old,
            }]))
        }
        Op::SetEasing {
            clip,
            prop,
            t,
            easing,
        } => {
            let (loc, mut x) = key_target(p, clip, t)?;
            let a = x.prop_mut(prop);
            let i = a
                .keys
                .binary_search_by(|k| k.t.cmp(&t))
                .map_err(|_| OpError::NoKeyframe)?;
            let old = std::mem::replace(&mut a.keys[i].easing, easing);
            x.validate().map_err(|_| OpError::BadTransform)?;
            *track_mut(p, loc.seq, loc.track).clips[loc.clip].transform = x;
            Ok(Inverse(vec![Op::SetEasing {
                clip,
                prop,
                t,
                easing: old,
            }]))
        }
        Op::Split {
            clip,
            at,
            new_id,
            new_link,
        } => {
            let loc = find_clip(p, clip).ok_or(OpError::UnknownClip(clip))?;
            let t = &p.sequences[loc.seq].tracks[loc.track];
            unlocked(t)?;
            let c = &t.clips[loc.clip];
            let end = c.end().ok_or(OpError::OutOfRange)?;
            if at <= c.start || at >= end {
                return Err(OpError::SplitOutside);
            }
            if id_in_use(p, new_id.0) {
                return Err(OpError::IdInUse(new_id.to_string()));
            }
            let left_len = sub(at, c.start)?;
            let right = Clip {
                id: new_id,
                media: c.media,
                start: at,
                source_in: add(c.source_in, scaled(left_len, c.speed)?)?,
                duration: sub(end, at)?,
                speed: c.speed,
                link: c.link.and(new_link),
                transform: Box::new(c.transform.split_right(left_len)),
                // The fade in stays with the left piece and the fade out goes with the right one; the cut itself has no fade.
                audio: ClipAudio {
                    fade_in: Time::ZERO,
                    ..c.audio
                },
            };
            let undo = restore_geometry(c);
            let old_audio = c.audio;
            // Both halves lie inside the original, so they are valid whenever it was; no further checks needed.
            let t = track_mut(p, loc.seq, loc.track);
            t.clips[loc.clip].duration = left_len;
            t.clips[loc.clip].audio.fade_out = Time::ZERO;
            t.clips.insert(loc.clip + 1, right);
            let mut inv = vec![Op::Delete { clip: new_id }, undo];
            if old_audio.fade_out != Time::ZERO {
                inv.push(Op::SetClipAudio {
                    clip,
                    audio: old_audio,
                });
            }
            Ok(Inverse(inv))
        }
        Op::TrimIn { clip, start } => {
            let loc = find_clip(p, clip).ok_or(OpError::UnknownClip(clip))?;
            let c = clip_at(p, loc);
            let end = c.end().ok_or(OpError::OutOfRange)?;
            let moved = sub(start, c.start)?;
            let source_in = add(c.source_in, scaled(moved, c.speed)?)?;
            set_clip_checked(p, loc, start, source_in, sub(end, start)?, None)
        }
        Op::TrimOut { clip, end } => {
            let loc = find_clip(p, clip).ok_or(OpError::UnknownClip(clip))?;
            let c = clip_at(p, loc);
            let (start, source_in) = (c.start, c.source_in);
            set_clip_checked(p, loc, start, source_in, sub(end, start)?, None)
        }
        Op::SetClip {
            clip,
            start,
            source_in,
            duration,
            speed,
        } => {
            let loc = find_clip(p, clip).ok_or(OpError::UnknownClip(clip))?;
            set_clip_checked(p, loc, start, source_in, duration, speed)
        }
        op @ (Op::RippleTrim { .. }
        | Op::RippleDelete { .. }
        | Op::CloseGap { .. }
        | Op::Roll { .. }
        | Op::Slip { .. }
        | Op::SetClipSpeed { .. }
        | Op::Slide { .. }) => crate::ripple::apply_compound(p, op),
        Op::Move { clip, track, start } => {
            let loc = find_clip(p, clip).ok_or(OpError::UnknownClip(clip))?;
            let (dsi, dti) = find_track(p, track).ok_or(OpError::UnknownTrack(track))?;
            let src = &p.sequences[loc.seq].tracks[loc.track];
            let dst = &p.sequences[dsi].tracks[dti];
            unlocked(src)?;
            unlocked(dst)?;
            let c = &src.clips[loc.clip];
            let moved = Clip { start, ..c.clone() };
            check_clip(p, dst, &moved)?;
            let same = (dsi, dti) == (loc.seq, loc.track);
            check_overlap(dst, &moved, same.then_some(c.id))?;
            let undo = Op::Move {
                clip,
                track: src.id,
                start: c.start,
            };
            if same {
                let t = track_mut(p, dsi, dti);
                t.clips.remove(loc.clip);
                insert_sorted(t, moved);
            } else {
                track_mut(p, loc.seq, loc.track).clips.remove(loc.clip);
                insert_sorted(track_mut(p, dsi, dti), moved);
            }
            Ok(Inverse(vec![undo]))
        }
    }
}

/// Shared tail of trims and `SetClip`: check the new geometry, then write it.
fn set_clip_checked(
    p: &mut Project,
    loc: Loc,
    start: Time,
    source_in: Time,
    duration: Time,
    speed: Option<Rational>,
) -> Result<Inverse, OpError> {
    let t = &p.sequences[loc.seq].tracks[loc.track];
    unlocked(t)?;
    let c = &t.clips[loc.clip];
    let next = Clip {
        start,
        source_in,
        duration,
        speed: speed.unwrap_or(c.speed),
        ..c.clone()
    };
    check_clip(p, t, &next)?;
    check_overlap(t, &next, Some(c.id))?;
    let mut undo = restore_geometry(c);
    if let (Some(s), Op::SetClip { speed: back, .. }) = (speed, &mut undo) {
        if s != c.speed {
            *back = Some(c.speed);
        }
    }
    set_geometry(
        track_mut(p, loc.seq, loc.track),
        loc.clip,
        start,
        source_in,
        duration,
        speed,
    );
    Ok(Inverse(vec![undo]))
}

/// Applies `ops` in order as one unit: if step `i` fails, steps before it are undone and the error names `i`.
/// Returns the combined inverse (apply it as given to undo the whole batch).
pub fn apply_all(p: &mut Project, ops: &[Op]) -> Result<Inverse, OpError> {
    let mut undo: Vec<Op> = Vec::new();
    for (index, op) in ops.iter().enumerate() {
        match apply(p, op.clone()) {
            Ok(Inverse(inv)) => {
                // Latest inverse first, so applying the list in order walks the edits backwards. Appended reversed and flipped once
                // at the end: prepending each step (`splice(0..0, ..)`) made a ripple over n clips O(n^2).
                undo.extend(inv.into_iter().rev());
            }
            Err(cause) => {
                undo.reverse();
                for u in undo {
                    // An inverse always fits the state it was recorded from; failure here would be an engine bug.
                    apply(p, u).expect("inverse of an applied op must apply");
                }
                return Err(OpError::Batch {
                    index,
                    cause: Box::new(cause),
                });
            }
        }
    }
    undo.reverse();
    Ok(Inverse(undo))
}
