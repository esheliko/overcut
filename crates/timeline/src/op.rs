//! `Op`: the only way a project changes (ADR 0006). Ops address things by id, never by index, and carry every
//! id they create (the host supplies fresh ids), so applying the same op list to the same project is deterministic.

use app_model::{
    Clip, ClipId, LinkId, MediaId, MediaRef, Rational, Resolution, SequenceId, Time, Track, TrackId,
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

/// One edit. `#[non_exhaustive]` + the `op` tag leave room for M2 ripple / roll / slip / slide, which are new variants
/// (with their own inverses), not changes to these.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
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
    /// Add a source file to the project's media list (import). Its id must be new; clips are untouched.
    AddMedia { media: MediaRef },
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
}

/// Ops that undo an applied op, in the order they must be applied.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Inverse(pub Vec<Op>);
