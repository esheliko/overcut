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
//! selection, snapping and `evaluate` are `M1-004`.

mod apply;
mod editor;
mod history;
mod op;

pub use apply::{apply, apply_all, OpError};
pub use editor::{EditOutcome, Editor};
pub use history::{journal_from_jsonl, journal_to_jsonl, replay, CoalesceKey, History};
pub use op::{Inverse, Op};

#[cfg(test)]
mod tests;
