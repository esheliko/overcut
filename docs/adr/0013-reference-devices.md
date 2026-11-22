# 0013 Reference devices
**Status**: **accepted** (2026-11-22; owner delegated to the work manager). Mac and Windows specs are assumed (owner said "assume").

**Context.** Budgets in `docs/PERFORMANCE.md` are only meaningful on named hardware.

**Decision.** Four tiers as proposed: low phone (Android, Snapdragon 6-series class, 4 GB), mid phone (iPhone 12-class), laptop (Apple M1 or recent integrated-GPU x86, 8-16 GB), desktop (discrete GPU, 16-32 GB).

**Concrete lab (the owner's physical devices).**
| Tier | Device | Notes |
|---|---|---|
| Laptop (x86) | Windows 10 laptop | **assumed** (conservative): Intel Core i5 10th-gen class, Intel UHD / Iris Xe integrated GPU, 8 GB |
| Laptop (Apple) | Mac | **assumed** (conservative): Apple M1, 8 GB |
| High phone | Samsung Galaxy S24 | above the mid tier; used as the Android upper reference |
| Mid phone | iPhone 14 | stands in for "iPhone 12-class" (faster than that class, so treat as the mid-tier ceiling) |
| Low phone | **No physical device (owner decision, 2026-11-22): the emulator is the low-end tier** | see "Low-end Android method" below; numbers are labelled **"calibrated proxy"** |
| Desktop | none yet | CI runners and any owner desktop are interim; results labelled "interim" |

**Low-end Android method (no physical device).**
- **Function, layout, memory:** Android emulator, API 34, 4 GB RAM, 720x1600 screen.
- **Performance:** measure on the real Galaxy S24 (via `/diagnostics`), then scale by the published CPU/GPU benchmark ratio of a Galaxy A15-class SoC (Helio G99 / Exynos 1280 class) versus the S24 to get a low-end estimate. Cross-check it against Chrome CPU throttling on the laptop.
- **Labelling:** every such number is marked **"calibrated proxy"** and states the ratio used; it is never presented as a measurement on real low-end hardware.

**Open items.** (1) Owner: confirm or correct the assumed Windows laptop and Mac specs (numbers are recorded as "assumed" until confirmed). (2) The low-end tier has no physical device; the method below replaces it. The emulator CI job is requested via a `process-request` issue. (3) A discrete-GPU desktop. (4) iOS 12-class device and a Chromebook are optional additions.
