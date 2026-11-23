//! The project document: `Project -> Sequence -> Track -> Clip`, plus the media it references.
//! Plain data. It is changed only by ops (ADR 0006, `app-timeline`), never directly by the UI.

use crate::ids::{ClipId, MediaId, ProjectId, SequenceId, TrackId};
use crate::time::{Rational, Time};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fmt;

/// Version of the document schema. Bump (and add a migration + fixture, M1-005) on any incompatible change.
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Project {
    /// The schema this document was written with; readers migrate older versions and refuse newer ones.
    pub schema_version: u32,
    pub id: ProjectId,
    pub name: String,
    /// Every media file used by any clip. Clips refer to these by id and never embed paths.
    pub media: Vec<MediaRef>,
    pub sequences: Vec<Sequence>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Resolution {
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Sequence {
    pub id: SequenceId,
    pub name: String,
    pub frame_rate: Rational,
    pub resolution: Resolution,
    /// True once the user chose the canvas size (an aspect/size preset or a custom one). While false the first picture imported sets
    /// `resolution` ("match first clip", the zero-question default). Absent in older files = false.
    #[serde(default, skip_serializing_if = "is_false")]
    pub size_fixed: bool,
    /// Same for `frame_rate`: true once the user picked a frame rate; while false the first picture imported sets it.
    #[serde(default, skip_serializing_if = "is_false")]
    pub rate_fixed: bool,
    pub sample_rate: u32,
    /// Bottom-to-top for video (later tracks draw over earlier ones). Any number of tracks of either kind.
    pub tracks: Vec<Track>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TrackKind {
    Video,
    Audio,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Track {
    pub id: TrackId,
    pub kind: TrackKind,
    pub name: String,
    pub muted: bool,
    pub locked: bool,
    /// Sorted by `start`, never overlapping (see [`Project::validate`]).
    pub clips: Vec<Clip>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Clip {
    pub id: ClipId,
    pub media: MediaId,
    /// Where the clip starts on the sequence timeline.
    pub start: Time,
    /// Where in the source media the clip starts.
    pub source_in: Time,
    /// Length on the timeline (source length is `duration * speed`).
    pub duration: Time,
    /// Playback speed, positive. 1/1 in M1.
    #[serde(default = "unit_speed")]
    pub speed: Rational,
}

fn unit_speed() -> Rational {
    Rational { num: 1, den: 1 }
}

impl Clip {
    /// First tick after the clip on the timeline (`None` on overflow).
    pub fn end(&self) -> Option<Time> {
        self.start.checked_add(self.duration)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MediaKind {
    Video,
    Audio,
    Image,
}

/// A source file as the project knows it. The bytes live outside the project; `uri` is resolved by the host.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct MediaRef {
    pub id: MediaId,
    pub kind: MediaKind,
    pub name: String,
    /// Host-resolved locator: a path relative to the project, a file handle key (web) or similar. Opaque to the model.
    pub uri: String,
    /// Content hash (hex) used to relink moved files; `None` until computed.
    #[serde(default)]
    pub hash: Option<String>,
    /// Source length; `None` for stills and until probed.
    #[serde(default)]
    pub duration: Option<Time>,
    /// Free-form labels the user put on the item in the media bin (`docs/features/media-bin.md`), trimmed, unique, at most `MAX_TAGS`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ModelError {
    UnsupportedVersion(u32),
    DuplicateId(String),
    UnknownMedia {
        clip: ClipId,
        media: MediaId,
    },
    BadClip {
        clip: ClipId,
        why: &'static str,
    },
    Overlap {
        track: TrackId,
        clip: ClipId,
    },
    KindMismatch {
        clip: ClipId,
    },
    BadSequence {
        sequence: SequenceId,
        why: &'static str,
    },
}

impl fmt::Display for ModelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for ModelError {}

impl Project {
    /// An empty project with one sequence holding one video and one audio track (the M1 shape).
    pub fn new(
        src: &mut impl crate::ids::IdSource,
        name: &str,
        frame_rate: Rational,
        resolution: Resolution,
    ) -> Project {
        let track = |src: &mut dyn crate::ids::IdSource, kind, name: &str| Track {
            id: TrackId(src.next_id()),
            kind,
            name: name.to_string(),
            muted: false,
            locked: false,
            clips: Vec::new(),
        };
        let id = ProjectId::new(src);
        let seq_id = SequenceId::new(src);
        let video = track(src, TrackKind::Video, "V1");
        let audio = track(src, TrackKind::Audio, "A1");
        Project {
            schema_version: SCHEMA_VERSION,
            id,
            name: name.to_string(),
            media: Vec::new(),
            sequences: vec![Sequence {
                id: seq_id,
                name: "Sequence 1".to_string(),
                frame_rate,
                resolution,
                size_fixed: false,
                rate_fixed: false,
                sample_rate: 48_000,
                tracks: vec![video, audio],
            }],
        }
    }

    /// Checks every invariant the rest of the engine relies on. Cheap (linear); run after load and in tests.
    pub fn validate(&self) -> Result<(), ModelError> {
        if self.schema_version != SCHEMA_VERSION {
            return Err(ModelError::UnsupportedVersion(self.schema_version));
        }
        let mut seen = HashSet::new();
        let mut unique = |id: crate::Id| {
            seen.insert(id)
                .then_some(())
                .ok_or_else(|| ModelError::DuplicateId(id.to_string()))
        };
        unique(self.id.0)?;
        for m in &self.media {
            unique(m.id.0)?;
        }
        for s in &self.sequences {
            unique(s.id.0)?;
            if s.frame_rate.num <= 0
                || s.sample_rate == 0
                || s.resolution.width == 0
                || s.resolution.height == 0
            {
                return Err(ModelError::BadSequence {
                    sequence: s.id,
                    why: "frame rate, sample rate and size must be positive",
                });
            }
            for t in &s.tracks {
                unique(t.id.0)?;
                let mut prev_end = Time::ZERO;
                for c in &t.clips {
                    unique(c.id.0)?;
                    self.validate_clip(t, c, prev_end)?;
                    prev_end = c.end().ok_or(ModelError::BadClip {
                        clip: c.id,
                        why: "end overflows",
                    })?;
                }
            }
        }
        Ok(())
    }

    fn validate_clip(&self, t: &Track, c: &Clip, prev_end: Time) -> Result<(), ModelError> {
        let media =
            self.media
                .iter()
                .find(|m| m.id == c.media)
                .ok_or(ModelError::UnknownMedia {
                    clip: c.id,
                    media: c.media,
                })?;
        let bad = |why| Err(ModelError::BadClip { clip: c.id, why });
        if c.duration <= Time::ZERO {
            return bad("duration must be positive");
        }
        if c.source_in < Time::ZERO || c.start < Time::ZERO {
            return bad("start and source_in must not be negative");
        }
        if c.speed.num <= 0 {
            return bad("speed must be positive");
        }
        if c.start < prev_end {
            return Err(ModelError::Overlap {
                track: t.id,
                clip: c.id,
            });
        }
        let ok = match t.kind {
            TrackKind::Video => matches!(media.kind, MediaKind::Video | MediaKind::Image),
            TrackKind::Audio => matches!(media.kind, MediaKind::Audio | MediaKind::Video),
        };
        if ok {
            Ok(())
        } else {
            Err(ModelError::KindMismatch { clip: c.id })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::SeqIds;

    fn sample() -> Project {
        let mut ids = SeqIds::default();
        let mut p = Project::new(
            &mut ids,
            "Demo",
            Rational::FPS_30,
            Resolution {
                width: 1920,
                height: 1080,
            },
        );
        let v = MediaRef {
            id: MediaId::new(&mut ids),
            kind: MediaKind::Video,
            name: "a.mp4".into(),
            uri: "media/a.mp4".into(),
            hash: None,
            duration: Time::from_seconds(10),
            tags: vec![],
        };
        let clip = |ids: &mut SeqIds, start: i64| Clip {
            id: ClipId::new(ids),
            media: v.id,
            start: Time::from_seconds(start).unwrap(),
            source_in: Time::ZERO,
            duration: Time::from_seconds(2).unwrap(),
            speed: unit_speed(),
        };
        let (c1, c2) = (clip(&mut ids, 0), clip(&mut ids, 3));
        // linked video + its own audio on the audio track
        let a1 = Clip {
            id: ClipId::new(&mut ids),
            ..c1.clone()
        };
        p.sequences[0].tracks[0].clips = vec![c1, c2];
        p.sequences[0].tracks[1].clips = vec![a1];
        p.media.push(v);
        p
    }

    #[test]
    fn m1_shape_is_valid_and_round_trips() {
        let p = sample();
        p.validate().unwrap();
        let json = serde_json::to_string(&p).unwrap();
        let back: Project = serde_json::from_str(&json).unwrap();
        assert_eq!(back, p);
        assert!(json.contains("\"schema_version\":1"));
    }

    #[test]
    fn unknown_fields_from_newer_writers_are_ignored_not_fatal() {
        let mut v = serde_json::to_value(sample()).unwrap();
        v["future_field"] = serde_json::json!({"x": 1});
        let back: Project = serde_json::from_value(v).unwrap();
        assert_eq!(back, sample());
    }

    #[test]
    fn duplicate_ids_across_the_document_are_rejected() {
        let mut p = sample();
        let mut t = p.sequences[0].tracks[0].clone();
        t.id = TrackId(p.id.0); // collides with the project id
        p.sequences[0].tracks.push(t);
        assert!(matches!(p.validate(), Err(ModelError::DuplicateId(_))));
    }

    #[test]
    fn rejects_broken_documents() {
        let edit = |f: &dyn Fn(&mut Project)| {
            let mut p = sample();
            f(&mut p);
            p.validate().unwrap_err()
        };
        assert!(matches!(
            edit(&|p| p.schema_version = 2),
            ModelError::UnsupportedVersion(2)
        ));
        assert!(matches!(
            edit(&|p| p.media.clear()),
            ModelError::UnknownMedia { .. }
        ));
        assert!(matches!(
            edit(&|p| p.sequences[0].tracks[0].clips[1].start = Time::from_seconds(1).unwrap()),
            ModelError::Overlap { .. }
        ));
        assert!(matches!(
            edit(&|p| p.sequences[0].tracks[0].clips[0].duration = Time::ZERO),
            ModelError::BadClip { .. }
        ));
        assert!(matches!(
            edit(&|p| p.sequences[0].tracks[0].clips[0].speed = Rational { num: 0, den: 1 }),
            ModelError::BadClip { .. }
        ));
        assert!(matches!(
            edit(&|p| p.media[0].kind = MediaKind::Audio),
            ModelError::KindMismatch { .. }
        ));
        assert!(matches!(
            edit(&|p| p.sequences[0].sample_rate = 0),
            ModelError::BadSequence { .. }
        ));
    }

    #[test]
    fn touching_clips_are_not_overlapping() {
        let mut p = sample();
        p.sequences[0].tracks[0].clips[1].start = Time::from_seconds(2).unwrap();
        p.validate().unwrap();
    }
}
