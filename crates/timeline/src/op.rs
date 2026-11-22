//! `Op`: the only way a project changes (ADR 0006). Ops address things by id, never by index, and carry every
//! id they create (the host supplies fresh ids), so applying the same op list to the same project is deterministic.

use app_model::{Clip, ClipId, MediaId, Time, TrackId};
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
}

/// Ops that undo an applied op, in the order they must be applied.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Inverse(pub Vec<Op>);
