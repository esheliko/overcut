//! `Op`: the only way a project changes (ADR 0006). Ops address things by id, never by index, and carry every
//! id they create (the host supplies fresh ids), so applying the same op list to the same project is deterministic.

use app_model::{Clip, ClipId, MediaId, MediaRef, Rational, Resolution, SequenceId, Time, TrackId};
use serde::{Deserialize, Serialize};

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
    /// Remove the clip.
    Delete { clip: ClipId },
    /// Set a clip's geometry exactly. Used by inverses (restore what a trim or split changed); also a valid edit.
    SetClip {
        clip: ClipId,
        start: Time,
        source_in: Time,
        duration: Time,
    },
    /// Set where a media file is found and its content fingerprint (`b3-64k:...`, `docs/features/project-file.md`).
    /// Used by import (record the fingerprint) and relink (the file moved); clips are untouched.
    SetMedia {
        media: MediaId,
        uri: String,
        hash: Option<String>,
    },
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
