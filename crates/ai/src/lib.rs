//! # app-ai
//!
//! **Owns**: the model registry (id, version, size, checksum, licence, quality tier), the download/verify/cache contract, the `Runtime` abstraction
//! (WebGPU/ONNX on web, native runtimes in apps) and task pipelines (speech to text, matting, tracking, reframe, TTS, interpolation).
//!
//! **Rules**: everything runs on-device (ADR 0008); tasks return `app-timeline` ops so results are editable and undoable; a model's licence is reviewed
//! before it is added to the registry.
//!
//! Status: M0 skeleton, empty. Spike S6 in M1, first tasks in M3 and M6.
