//! # app-timeline
//!
//! **Owns**: edit `Op`s (insert, split, trim, move, delete now; ripple, roll, slip, slide, group, keyframe edits later) and their inverses (ADR 0006),
//! `History` (undo/redo with drag coalescing), the operation journal for autosave and crash recovery, selection and snapping logic,
//! and `evaluate(t)`: what is visible and audible at a given time, as a frame description for render and audio.
//!
//! **Does not own**: pixels or samples; it never decodes or draws.
//!
//! **Rules**: project state changes only inside `apply`; every op has an inverse and a property test (`undo(do(x)) == x`,
//! `replay(journal) == state`); `evaluate` is pure and allocation-light (it runs every frame).
//!
//! Status: `Op`, `apply`, `History`, journal and the JSON `Editor` are in (M1-003, `docs/features/timeline-ops.md`);
//! `evaluate` is in (M1-004, `docs/features/evaluate.md`); selection and snapping are still to come.

mod apply;
mod editor;
mod evaluate;
mod history;
mod op;
mod recovery;
mod ripple;
mod snap;

pub use apply::{apply, apply_all, OpError};
pub use editor::{EditOutcome, Editor};
pub use evaluate::{
    evaluate, evaluate_into, AudioSegment, FrameDescription, Transform, VideoLayer,
};
pub use history::{journal_from_jsonl, journal_to_jsonl, replay, CoalesceKey, History};
pub use op::{Edge, Inverse, Op};
pub use recovery::Recovery;
pub use snap::{snap, snap_span, targets_of, Snap, Target, TargetKind};

#[cfg(test)]
mod tests;
