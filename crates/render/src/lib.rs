//! # app-render
//!
//! **Owns**: the GPU compositor on wgpu (WebGPU and WebGL2 in browsers, Vulkan/Metal/DX12 natively), the render graph built from an evaluated frame,
//! linear-light colour management (ADR 0003), preview presentation and export readback.
//!
//! **Rules**: one renderer for every platform; golden-frame tests per backend with a documented tolerance; no per-frame allocation in the hot path;
//! output must be deterministic for export.
//!
//! Status: M0 skeleton, empty. First content: `M1-020`, `M1-021`, `M1-022`.
