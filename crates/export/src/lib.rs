//! # app-export
//!
//! **Owns**: export jobs (queue, progress, cancel, resume), the `Encoder` trait and host backends, muxers (MP4, WebM, MOV, GIF/WebP/APNG), presets and
//! size-targeted bitrate, A/V sync guarantees.
//!
//! **Rules**: export is deterministic and not tied to real time; sync tests use the click-track fixture; codec policy follows ADR 0004.
//!
//! Status: M0 skeleton, empty. First content: `M1-014`, `M1-022`.
