# 0008 AI runs on-device, models on demand
**Status**: proposed (validate with S6)

**Decision.** All AI features run locally with open-weight models fetched on demand (checksummed, versioned, removable, size and licence shown), using WebGPU/ONNX-WASM on the web and native runtimes in apps. Each task has quality tiers selected by device capability. Tasks produce ops so results are editable and undoable. Models whose licence forbids free redistribution or commercial use of outputs are not shipped. Cloud AI is never required; optional bring-your-own-key integrations (AI-14) are post-1.0 and visibly off-device.

**Consequences.** (+) privacy, offline, zero server cost. (-) large downloads, slower than datacentre GPUs on weak devices (mitigated by tiers and background jobs), model-licence review is part of adding any model.
