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
| [0009](0009-license.md) | Licence | **open: owner decision** |
| [0010](0010-time.md) | Time as integer ticks | proposed |
| [0011](0011-distribution-costs.md) | Distribution, signing and the real costs of "free" | **open: owner decision** |
| [0012](0012-name.md) | Name and trademark check | **open: owner action** |
| [0013](0013-reference-devices.md) | Reference devices for budgets | **open: owner decision** |
| [0014](0014-governance-funding.md) | Governance and funding | **open: by M3** |

## Open decisions (do not silently pick one)
Owner input is needed on **0009, 0011, 0012, 0013, 0014**. Each file ends with options and a recommendation.
