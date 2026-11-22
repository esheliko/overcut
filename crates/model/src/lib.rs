//! # app-model
//!
//! **Owns**: the project document (`Project -> Sequence -> Track -> Clip`), media references, effects and keyframes as data,
//! markers and settings; integer-tick `Time` and `Rational` (ADR 0010); stable ids; serialization of `.overcut`
//! (versioned `project.json`, forward-compatible unknown fields) and schema migrations; JSON-Schema and TypeScript type export.
//!
//! **Does not own**: how a project is edited (that is `app-timeline`), how it is drawn (`app-render`) or decoded (`app-media`).
//!
//! **Rules**: no I/O; everything `Serialize + Deserialize`; no floats for positions in time; every format change ships a migration and a fixture test.
//!
//! Status: `time` (M1-001) and the document structs (M1-002, `docs/features/model.md`) are in; ops and undo are `M1-003`, the `.overcut` file is `M1-005`.

pub mod ids;
pub mod project;
pub mod schema;
pub mod time;

pub use ids::{ClipId, Id, IdSource, MediaId, ProjectId, SeqIds, SequenceId, TrackId};
pub use project::{
    Clip, MediaKind, MediaRef, ModelError, Project, Resolution, Sequence, Track, TrackKind,
    SCHEMA_VERSION,
};
pub use time::{Rational, Time, TICKS_PER_SECOND};
