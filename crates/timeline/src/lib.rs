//! # app-timeline
//!
//! **Owns**: edit `Op`s (insert, split, trim, move, ripple, roll, slip, slide, group, keyframe edits, ...) and their inverses (ADR 0006),
//! `History` (undo/redo with drag coalescing), the operation journal for autosave and crash recovery, selection and snapping logic,
//! and `evaluate(t)`: what is visible and audible at a given time, as a frame description for render and audio.
//!
//! **Does not own**: pixels or samples; it never decodes or draws.
//!
//! **Rules**: project state changes only inside `apply`; every op has an inverse and a property test (`undo(do(x)) == x`,
//! `replay(journal) == state`); `evaluate` is pure and allocation-light (it runs every frame).
//!
//! Status: M0 skeleton, empty. First content: `M1-003`, `M1-004`.
