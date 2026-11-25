//! `Op`: the only way a project changes (ADR 0006). Ops address things by id, never by index, and carry every
//! id they create (the host supplies fresh ids), so applying the same op list to the same project is deterministic.

use app_model::{
    Clip, ClipId, ClipTransform, Easing, Keyframe, LinkId, Marker, MarkerId, MarkerKind, MediaId,
    MediaRef, Rational, Resolution, SequenceId, Time, TimeRange, Track, TrackId, TransformProp,
};
use serde::{Deserialize, Deserializer, Serialize};

/// Reads a field where "absent" means leave it alone, `null` means clear it and a value means set it
/// (`Option<Option<T>>` with `#[serde(default)]`).
fn set_or_clear<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// Which edge of a clip a ripple trim moves.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Edge {
    In,
    Out,
}

/// One edit. `#[non_exhaustive]` + the `op` tag leave room for new variants (with their own inverses), not changes to these.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
#[non_exhaustive]
pub enum Op {
    /// Put a whole clip on a track. Its id must be new.
    InsertClip { track: TrackId, clip: Clip },
    /// Cut `clip` at timeline time `at` (strictly inside it). The left part keeps `clip`'s id, the right part gets `new_id`.
    Split {
        clip: ClipId,
        at: Time,
        new_id: ClipId,
        /// The link of the right part, when the clip is linked: the caller gives both pieces of a linked pair the same new link,
        /// so the pieces stay linked pairwise. Absent = the right part is alone. Ignored for a clip that is not linked.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        new_link: Option<LinkId>,
    },
    /// Move the clip's start edge to `start` (timeline time); the end edge stays. `source_in` follows.
    TrimIn { clip: ClipId, start: Time },
    /// Move the clip's end edge to `end` (timeline time); the start edge stays.
    TrimOut { clip: ClipId, end: Time },
    /// Move the clip to `track` (may be another track of the same kind) starting at `start`.
    Move {
        clip: ClipId,
        track: TrackId,
        start: Time,
    },
    /// Link the clip to others (same id) or, with `None`, let it edit alone (TL-05). Only the editing layer reads links; undoable.
    SetLink { clip: ClipId, link: Option<LinkId> },
    /// Replace a clip's transform (position, scale, rotation, anchor, crop, flip, opacity, fit; M2-003, `docs/features/clip-transform.md`).
    /// Checked like a file (`BadTransform`). One drag = many of these under one `History` key = one undo step; the inverse is the old transform.
    SetClipTransform {
        clip: ClipId,
        transform: Box<ClipTransform>,
    },
    /// Add a keyframe to one animatable property of a clip's transform, or replace the key at the same clip-relative time (M2-004,
    /// `docs/features/keyframes.md`). Key times are `>= 0`; values are range-checked like `SetClipTransform` (`BadTransform`).
    /// Inverse: `SetKeyframe` of the key it replaced, else `DeleteKeyframe`.
    SetKeyframe {
        clip: ClipId,
        prop: TransformProp,
        key: Keyframe,
    },
    /// Move the key at `from` to the time `to` (`KeyframeOccupied` when another key is there) and, when `value` is given, give it that
    /// value. A drag is many of these under one `History` key = one undo step. Inverse: the move back with the old value.
    MoveKeyframe {
        clip: ClipId,
        prop: TransformProp,
        from: Time,
        to: Time,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<f64>,
    },
    /// Remove the key at `t` (`NoKeyframe` when there is none). Inverse: `SetKeyframe` of that key.
    DeleteKeyframe {
        clip: ClipId,
        prop: TransformProp,
        t: Time,
    },
    /// Change the easing of the segment leaving the key at `t`. Inverse: the old easing.
    SetEasing {
        clip: ClipId,
        prop: TransformProp,
        t: Time,
        easing: Easing,
    },
    /// Remove the clip.
    Delete { clip: ClipId },
    /// Set a clip's geometry exactly. Used by inverses (restore what a trim or split changed); also a valid edit.
    SetClip {
        clip: ClipId,
        start: Time,
        source_in: Time,
        duration: Time,
    },
    /// Add a track to a sequence at stack position `index` (0 = bottom, `tracks.len()` = top). Its id must be new. A track that carries
    /// clips is allowed (the inverse of `RemoveTrack` restores them); the clips are checked like `InsertClip`.
    AddTrack {
        sequence: SequenceId,
        track: Track,
        index: usize,
    },
    /// Remove a track and the clips on it (undo puts it all back). A locked track cannot be removed.
    RemoveTrack { track: TrackId },
    /// Move a track to stack position `index` in the order after it is lifted out (so `tracks.len() - 1` = top). Video draws bottom-to-top.
    MoveTrack { track: TrackId, index: usize },
    /// Change a track's properties; fields left out stay as they are. `height` / `colour`: a value sets, `null` resets to the default.
    /// Valid on a locked track (that is how it gets unlocked).
    SetTrackProps {
        track: TrackId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        muted: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        solo: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        locked: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hidden: Option<bool>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "set_or_clear"
        )]
        height: Option<Option<u32>>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "set_or_clear"
        )]
        colour: Option<Option<String>>,
    },
    /// Add a marker or chapter to a sequence (TL-07, M2-007, `docs/features/markers.md`). The marker's id must be new; time `>= 0`; name and
    /// colour as `marker_props_ok`; at most `MAX_MARKERS`. Inverse: `DeleteMarker`.
    AddMarker {
        sequence: SequenceId,
        marker: Marker,
    },
    /// Move a marker to `time` (`>= 0`). A drag is many of these under one `History` key = one undo step. Inverse: the move back.
    MoveMarker { marker: MarkerId, time: Time },
    /// Patch a marker's name, kind and colour; fields left out stay (`colour`: a value sets it, `null` resets it). Inverse: the old values.
    SetMarkerProps {
        marker: MarkerId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        kind: Option<MarkerKind>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "set_or_clear"
        )]
        colour: Option<Option<String>>,
    },
    /// Remove a marker. Inverse: `AddMarker` of it.
    DeleteMarker { marker: MarkerId },
    /// Set the sequence's in/out range and whether playback loops over it; `range: null` clears the range (and `looping` must then be
    /// false, else `BadRange`). The range needs `0 <= start < end`. Inverse: the old range and flag.
    SetRange {
        sequence: SequenceId,
        range: Option<TimeRange>,
        #[serde(default, skip_serializing_if = "is_false")]
        looping: bool,
    },
    /// Set where a media file is found and its content fingerprint (`b3-64k:...`, `docs/features/project-file.md`).
    /// Used by import (record the fingerprint) and relink (the file moved); clips are untouched.
    SetMedia {
        media: MediaId,
        uri: String,
        hash: Option<String>,
    },
    /// Replace a media item's tags (the media bin's labels, `docs/features/media-bin.md`). Tags are trimmed, non-empty, unique, at most
    /// `MAX_TAGS` of at most `MAX_TAG_LEN` characters each, else `BadTags`. Undoable; clips are untouched.
    SetMediaTags { media: MediaId, tags: Vec<String> },
    /// Add a source file to the project's media list (import). Its id must be new; clips are untouched. `index`: where in the list
    /// (clamped to the end); absent = append. The inverse of `RemoveMedia` sets it so undo restores the bin order.
    AddMedia {
        media: MediaRef,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        index: Option<usize>,
    },
    /// Remove a media entry that no clip uses (the inverse of `AddMedia`).
    RemoveMedia { media: MediaId },
    /// Set a sequence's frame rate and size (the first import adopts its clip's; also a valid edit).
    SetSequenceFormat {
        sequence: SequenceId,
        frame_rate: Rational,
        resolution: Resolution,
    },
    /// The project canvas (PM-01): frame rate and size as the user chose them, and whether each is now fixed (`true`) or follows the
    /// first picture imported (`false`, "match first clip"). Undoable; clips are untouched (times are ticks, frame rate only changes sampling).
    SetCanvas {
        sequence: SequenceId,
        frame_rate: Rational,
        resolution: Resolution,
        size_fixed: bool,
        rate_fixed: bool,
    },
    /// Ripple trim (TL-04): move one `edge` of `clip` by `delta` timeline ticks (positive = the edge moves later) and shift everything that
    /// starts at or after the clip's old end by the length change, so no gap opens or closes around it. `In` keeps the clip's start and moves
    /// its `source_in`; `Out` keeps its start and changes its length. `all_tracks`: also shift the clips after that point on every other
    /// unlocked track of the sequence (sync); otherwise only the clip's own track.
    RippleTrim {
        clip: ClipId,
        edge: Edge,
        delta: Time,
        #[serde(default, skip_serializing_if = "is_false")]
        all_tracks: bool,
    },
    /// Delete `clip` and close the hole: clips that start at or after its end move earlier by its length (see `RippleTrim` for `all_tracks`).
    RippleDelete {
        clip: ClipId,
        #[serde(default, skip_serializing_if = "is_false")]
        all_tracks: bool,
    },
    /// Close the empty gap on `track` that contains time `at` (between two clips, or between 0 and the first clip): everything after it
    /// moves earlier by the gap length. `NotInGap` when `at` is on a clip or after the last one.
    CloseGap {
        track: TrackId,
        at: Time,
        #[serde(default, skip_serializing_if = "is_false")]
        all_tracks: bool,
    },
    /// Roll: move the cut between two touching clips of one track (`left` ends where `right` starts) to `to`; total length is unchanged.
    Roll {
        left: ClipId,
        right: ClipId,
        to: Time,
    },
    /// Slip: show a different part of the source through the same window. `source_in` moves by `delta` source ticks; start and length stay.
    Slip { clip: ClipId, delta: Time },
    /// Slide: move `clip` by `delta` timeline ticks; a neighbour that touches it gives or takes the difference at its adjacent edge, so the
    /// total length of the three clips is unchanged. A neighbour that does not touch is left alone (and must not be overrun).
    Slide { clip: ClipId, delta: Time },
}

/// Ops that undo an applied op, in the order they must be applied.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Inverse(pub Vec<Op>);
