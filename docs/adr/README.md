# Architecture decision records

Format: Context, Decision, Consequences, Status (`proposed` -> `accepted` -> maybe `superseded by NNNN`). A decision that changes module boundaries, the file format, a platform strategy or a licence needs an ADR in the same PR.

| # | Title | Status |
|---|---|---|
| [0001](0001-rust-engine.md) | One Rust engine for web and native | proposed (accept at M0 exit) |
| [0002](0002-shells.md) | PWA + Tauri 2 shells, one UI | proposed (accept at M0 exit) |
| [0003](0003-gpu.md) | GPU: wgpu, WebGPU first, WebGL2 fallback, linear-light pipeline | **accepted** (2026-11-24; device frame times: M2 field validation) |
| [0004](0004-media-io.md) | Media I/O per platform; codec and patent policy | **accepted** (2026-11-24; device encode speed/drift: M2 field validation) |
| [0005](0005-local-first.md) | Local-first, no backend | proposed (accept at M0 exit) |
| [0006](0006-edit-operations.md) | Edits are serializable operations with inverses | accepted (S7 passed) |
| [0007](0007-ui-and-extensibility.md) | React UI, canvas timeline, effects as data | proposed |
| [0008](0008-on-device-ai.md) | AI runs on-device, models on demand | proposed (validate with S6) |
| [0009](0009-license.md) | Licence | **accepted** (GPL-3.0-or-later apps, MIT OR Apache-2.0 engine, DCO) |
| [0010](0010-time.md) | Time as integer ticks | proposed |
| [0011](0011-distribution-costs.md) | Distribution, signing and the real costs of "free" | **accepted** (as recommended, 2026-11-22) |
| [0012](0012-name.md) | Name and trademark check | **open: deferred by owner, revisit before M3 public beta** |
| [0013](0013-reference-devices.md) | Reference devices for budgets | **accepted** (owner's devices; low-end Android via proxy) |
| [0014](0014-governance-funding.md) | Governance and funding | **open: by M3** |
| [0015](0015-keyframes.md) | Keyframes and animatable properties (spike S9, M2-001) | **accepted** (bars met: wasm = native over 1M samples, ~100 ns per bezier eval) |
| [0016](0016-proxies.md) | Proxies: codec, resolution, storage, resume (S10, M2-020) | proposed (engineering; container bars met, device bars are calibrated estimates until a device run) |
| 0017 | A/V drift measurement and VFR policy (S11, M2-021) | proposed (engineering) |
| 0018 | Export queue and resume (S12, M2-022) | proposed (engineering) |
| 0019 | Optional crash-report endpoint (XT-06b, M2-053) | **open: owner-level** (first server, running cost; do not pick) |
| [0020](0020-op-patches.md) | Edits report what they changed (op patches, M2 UX P-4) | **accepted** (engineering; additive, no ABI bump; bars met in UX round 10) |

## Open decisions (do not silently pick one)
Open: **0012** (deferred to before M3 public beta) and **0014** (by M3). 0009, 0011 and 0013 accepted 2026-11-22 (0013: Mac and Windows specs assumed; low-end Android is an emulator-based calibrated proxy). Proposed 2026-11-24 for M2 (files are written by the spike named in each row, [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md) section 4b.3): 0015 accepted by S9; 0020 accepted 2026-11-27; 0016-0018 are engineering decisions with a recommendation; **0019 needs the owner** (before M2-053 ships a remote endpoint; local-only crash reports need no decision). Each file ends with options and a recommendation.
