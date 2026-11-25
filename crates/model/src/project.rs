//! The project document: `Project -> Sequence -> Track -> Clip`, plus the media it references.
//! Plain data. It is changed only by ops (ADR 0006, `app-timeline`), never directly by the UI.

use crate::ids::{ClipId, LinkId, MarkerId, MediaId, ProjectId, SequenceId, TrackId};
use crate::time::{Rational, Time};
use crate::transform::ClipTransform;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fmt;

/// Version of the document schema. Bump (and add a migration + fixture, M1-005) on any incompatible change.
pub const SCHEMA_VERSION: u32 = 4;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
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
    /// Markers and chapters (TL-07, M2-007, `docs/features/markers.md`), ordered by time then id. Absent in older files = none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub markers: Vec<Marker>,
    /// The in/out range (render range, loop range). `None` = the whole sequence. Absent in older files = none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<TimeRange>,
    /// True while playback loops over `range` (needs a range). Absent = false.
    #[serde(default, skip_serializing_if = "is_false")]
    pub loop_range: bool,
}

/// Most markers one sequence may hold, and the longest marker name (characters).
pub const MAX_MARKERS: usize = 10_000;
pub const MAX_MARKER_NAME: usize = 120;

/// A plain marker (a flag on the ruler) or a chapter (also exported as a chapter mark).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MarkerKind {
    #[default]
    Marker,
    Chapter,
}

impl MarkerKind {
    fn is_marker(&self) -> bool {
        *self == MarkerKind::Marker
    }
}

/// A point on the sequence's timeline (ticks, `>= 0`) with a name and an optional colour.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Marker {
    pub id: MarkerId,
    pub time: Time,
    #[serde(default, skip_serializing_if = "MarkerKind::is_marker")]
    pub kind: MarkerKind,
    /// 0-120 characters, no surrounding spaces. Empty is allowed (an unnamed marker).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    /// `#rrggbb`; `None` = the default colour.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub colour: Option<String>,
}

/// A half-open stretch of the timeline: `start <= t < end`, `0 <= start < end`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct TimeRange {
    pub start: Time,
    pub end: Time,
}

/// Name and colour rules shared by validation and the `AddMarker` / `SetMarkerProps` ops.
pub fn marker_props_ok(name: &str, colour: Option<&str>) -> bool {
    name.trim() == name
        && name.chars().count() <= MAX_MARKER_NAME
        && colour.is_none_or(is_track_colour)
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

/// Bounds of `Track::height` (UI pixels).
pub const MIN_TRACK_HEIGHT: u32 = 24;
pub const MAX_TRACK_HEIGHT: u32 = 400;
/// Longest track name, in characters.
pub const MAX_TRACK_NAME: usize = 64;

/// True for `#rrggbb` (hex digits of either case).
pub fn is_track_colour(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

impl Track {
    /// Whether the track takes part in the output (drawn / heard) given whether another track of its kind is soloed.
    pub fn is_live(&self, kind_has_solo: bool) -> bool {
        !self.muted && !self.hidden && (!kind_has_solo || self.solo)
    }
}

impl Sequence {
    /// True when some track of `kind` is soloed.
    pub fn has_solo(&self, kind: TrackKind) -> bool {
        self.tracks.iter().any(|t| t.kind == kind && t.solo)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Track {
    pub id: TrackId,
    pub kind: TrackKind,
    pub name: String,
    /// Silent (audio) / not drawn (video). The track keeps its clips and its place in the stack.
    pub muted: bool,
    pub locked: bool,
    /// Out of the output entirely (eye off): neither drawn nor heard. Added in schema 2; absent = false.
    #[serde(default, skip_serializing_if = "is_false")]
    pub hidden: bool,
    /// While any track of a kind is soloed, only the soloed tracks of that kind are drawn / heard. Schema 2; absent = false.
    #[serde(default, skip_serializing_if = "is_false")]
    pub solo: bool,
    /// Row height in UI pixels (`MIN_TRACK_HEIGHT..=MAX_TRACK_HEIGHT`); `None` = the view's default for the kind. Schema 2.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// Label colour as `#rrggbb`; `None` = the theme's default for the kind. Schema 2.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub colour: Option<String>,
    /// Sorted by `start`, never overlapping (see [`Project::validate`]).
    pub clips: Vec<Clip>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
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
    /// Clips sharing a link edit as one (TL-05, `docs/features/timeline-ops.md`): the picture and the sound of one import. `None` = alone.
    /// Only the editing layer acts on it; evaluation and export ignore it. Absent in files made before linking existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<LinkId>,
    /// Position, scale, rotation, crop, flip, opacity and fit (M2-003). The identity is the default and is not written.
    #[serde(default, skip_serializing_if = "transform_is_identity")]
    pub transform: Box<ClipTransform>,
}

/// Boxed so a `Clip` (and every `Op` carrying one) stays small: a transform is a dozen animatable numbers.
#[allow(clippy::borrowed_box)]
fn transform_is_identity(t: &Box<ClipTransform>) -> bool {
    t.is_identity()
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
    BadTrack {
        track: TrackId,
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
            hidden: false,
            solo: false,
            height: None,
            colour: None,
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
                markers: Vec::new(),
                range: None,
                loop_range: false,
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
            self.validate_markers(s)?;
            for t in &s.tracks {
                unique(t.id.0)?;
                if t.height
                    .is_some_and(|h| !(MIN_TRACK_HEIGHT..=MAX_TRACK_HEIGHT).contains(&h))
                {
                    return Err(ModelError::BadTrack {
                        track: t.id,
                        why: "height out of range",
                    });
                }
                if t.colour.as_deref().is_some_and(|c| !is_track_colour(c)) {
                    return Err(ModelError::BadTrack {
                        track: t.id,
                        why: "colour must be #rrggbb",
                    });
                }
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

    fn validate_markers(&self, s: &Sequence) -> Result<(), ModelError> {
        let bad = |why| {
            Err(ModelError::BadSequence {
                sequence: s.id,
                why,
            })
        };
        if s.markers.len() > MAX_MARKERS {
            return bad("too many markers");
        }
        for w in s.markers.windows(2) {
            if (w[0].time, w[0].id) >= (w[1].time, w[1].id) {
                return bad("markers must be ordered by time then id");
            }
        }
        for m in &s.markers {
            if m.time < Time::ZERO {
                return bad("marker time must not be negative");
            }
            if !marker_props_ok(&m.name, m.colour.as_deref()) {
                return bad("marker name or colour is invalid");
            }
        }
        if let Some(r) = s.range {
            if r.start < Time::ZERO || r.end <= r.start {
                return bad("range must satisfy 0 <= start < end");
            }
        }
        if s.loop_range && s.range.is_none() {
            return bad("loop_range needs a range");
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
        if c.transform.validate().is_err() {
            return bad("transform has a value that is not finite or out of range");
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
            link: None,
            transform: Default::default(),
        };
        let (c1, mut c2) = (clip(&mut ids, 0), clip(&mut ids, 3));
        // linked video + its own audio on the audio track
        let link = Some(crate::LinkId::new(&mut ids));
        let c1 = Clip { link, ..c1 };
        let a1 = Clip {
            id: ClipId::new(&mut ids),
            ..c1.clone()
        };
        c2.link = None;
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
        assert!(json.contains("\"schema_version\":4"));
    }

    #[test]
    fn links_are_saved_and_a_file_without_them_loads_unlinked() {
        let p = sample();
        let mut v = serde_json::to_value(&p).unwrap();
        let linked = |v: &serde_json::Value, t: usize, c: usize| {
            v["sequences"][0]["tracks"][t]["clips"][c]
                .get("link")
                .cloned()
        };
        assert!(
            linked(&v, 0, 0).is_some() && linked(&v, 1, 0) == linked(&v, 0, 0),
            "the pair shares one link in the file"
        );
        assert!(
            linked(&v, 0, 1).is_none(),
            "an unlinked clip writes no link at all"
        );
        // A project made before linking existed has no `link` anywhere: it opens, nothing is linked.
        for t in 0..2 {
            for c in v["sequences"][0]["tracks"][t]["clips"]
                .as_array_mut()
                .unwrap()
            {
                c.as_object_mut().unwrap().remove("link");
            }
        }
        let old: Project = serde_json::from_value(v).unwrap();
        old.validate().unwrap();
        assert!(old.sequences[0]
            .tracks
            .iter()
            .flat_map(|t| &t.clips)
            .all(|c| c.link.is_none()));
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
            edit(&|p| p.schema_version = 5),
            ModelError::UnsupportedVersion(5)
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

    #[test]
    fn markers_and_range_are_checked_and_written_only_when_used() {
        let mut p = sample();
        assert!(!serde_json::to_string(&p).unwrap().contains("markers"));
        let mut ids = crate::SeqIds::default();
        let mk = |ids: &mut crate::SeqIds, t: i64| Marker {
            id: MarkerId::new(ids),
            time: Time::from_ticks(t),
            kind: MarkerKind::Marker,
            name: String::new(),
            colour: None,
        };
        let (a, b) = (mk(&mut ids, 5), mk(&mut ids, 9));
        p.sequences[0].markers = vec![a.clone(), b.clone()];
        p.validate().unwrap();
        let back: Project = serde_json::from_str(&serde_json::to_string(&p).unwrap()).unwrap();
        assert_eq!(back, p);
        let bad = |f: &dyn Fn(&mut Sequence)| {
            let mut q = p.clone();
            f(&mut q.sequences[0]);
            q.validate().unwrap_err()
        };
        bad(&|s| s.markers.reverse());
        bad(&|s| s.markers[0].time = Time::from_ticks(-1));
        bad(&|s| s.markers[0].name = " x".into());
        bad(&|s| s.markers[0].colour = Some("red".into()));
        bad(&|s| s.markers.push(a.clone()));
        bad(&|s| {
            s.range = Some(TimeRange {
                start: Time::from_ticks(4),
                end: Time::from_ticks(4),
            })
        });
        bad(&|s| s.loop_range = true);
        let mut q = p.clone();
        q.sequences[0].range = Some(TimeRange {
            start: Time::ZERO,
            end: Time::from_ticks(8),
        });
        q.sequences[0].loop_range = true;
        q.validate().unwrap();
    }
}
