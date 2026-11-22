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
//! Status: `time` (M1-001) is in; the document structs arrive with `M1-002` (see docs/IMPLEMENTATION_PLAN.md).

pub mod time;

pub use time::{Rational, Time, TICKS_PER_SECOND};
