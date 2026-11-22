//! # app-fx
//!
//! **Owns**: effect and transition definitions as data + WGSL (the same format built-ins and plugins use, EF-20), parameter evaluation with keyframes,
//! colour maths and LUT parsing, masks, text layout and shaping (including RTL and complex scripts, TX-10).
//!
//! **Rules**: a definition is versioned and has a conformance test; parameters are typed with ranges and defaults so the UI can be generated;
//! no GPU calls here (that is `app-render`).
//!
//! Status: M0 skeleton, empty. First content arrives with M3 (text) and M4 (effects).
