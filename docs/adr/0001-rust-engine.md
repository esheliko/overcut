# 0001 One Rust engine for web and native
**Status**: proposed

**Context.** The product must run on web, desktop and mobile with identical behaviour and native-grade speed on media work. Writing the editing core separately per platform triples the work and guarantees divergence in subtle things (time rounding, effect maths, file format).

**Decision.** All editing logic, evaluation, rendering orchestration, audio DSP, effects maths, export orchestration and AI orchestration are written once in Rust (`crates/`), compiled to WebAssembly for browsers and linked natively into Tauri shells. Platform capabilities (decode/encode, files, camera) are reached through traits the host implements. The UI never contains project logic.

**Consequences.** (+) one behaviour, one test suite, memory safety, performance, native tools (CLI, fuzzing). (-) WASM has limits (threads need cross-origin isolation, no direct GPU/codec access, binary size), a Rust learning curve for contributors, bridge overhead for large data (mitigated: typed buffers / shared memory / GPU textures, never JSON for media). A TypeScript engine was rejected for speed, determinism and code sharing; C++ for safety and contributor accessibility.
