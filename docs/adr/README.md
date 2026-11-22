# Architecture decision records

Format: Context, Decision, Consequences, Status (`proposed` -> `accepted` -> maybe `superseded by NNNN`). A decision that changes module boundaries, the file format, a platform strategy or a licence needs an ADR in the same PR.

| # | Title | Status |
|---|---|---|
| [0001](0001-rust-engine.md) | One Rust engine for web and native | proposed (accept at M0 exit) |
| [0002](0002-shells.md) | PWA + Tauri 2 shells, one UI | proposed (accept at M0 exit) |
| [0003](0003-gpu.md) | GPU: wgpu, WebGPU first, WebGL2 fallback, linear-light pipeline | proposed (validate with S2) |
| [0004](0004-media-io.md) | Media I/O per platform; codec and patent policy | proposed (validate with S1, S3, S4) |
| [0005](0005-local-first.md) | Local-first, no backend | proposed (accept at M0 exit) |
| [0006](0006-edit-operations.md) | Edits are serializable operations with inverses | proposed (validate with S7) |
| [0007](0007-ui-and-extensibility.md) | React UI, canvas timeline, effects as data | proposed |
| [0008](0008-on-device-ai.md) | AI runs on-device, models on demand | proposed (validate with S6) |
| [0009](0009-license.md) | Licence | **accepted** (GPL-3.0-or-later apps, MIT OR Apache-2.0 engine, DCO) |
| [0010](0010-time.md) | Time as integer ticks | proposed |
| [0011](0011-distribution-costs.md) | Distribution, signing and the real costs of "free" | **accepted** (as recommended, 2026-11-22) |
| [0012](0012-name.md) | Name and trademark check | **open: deferred by owner, revisit before M3 public beta** |
| [0013](0013-reference-devices.md) | Reference devices for budgets | **accepted** (owner's devices; low-end Android via proxy) |
| [0014](0014-governance-funding.md) | Governance and funding | **open: by M3** |

## Open decisions (do not silently pick one)
Open: **0012** (deferred to before M3 public beta) and **0014** (by M3). 0009, 0011 and 0013 accepted 2026-11-22 (0013 device specs are assumed until the owner confirms). Each file ends with options and a recommendation.
