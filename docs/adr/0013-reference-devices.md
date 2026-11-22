# 0013 Reference devices
**Status**: **accepted** (2026-11-22; owner delegated to the work manager). Some device details are still to be filled in by the owner.

**Context.** Budgets in `docs/PERFORMANCE.md` are only meaningful on named hardware.

**Decision.** Four tiers as proposed: low phone (Android, Snapdragon 6-series class, 4 GB), mid phone (iPhone 12-class), laptop (Apple M1 or recent integrated-GPU x86, 8-16 GB), desktop (discrete GPU, 16-32 GB).

**Concrete lab (the owner's physical devices).**
| Tier | Device | Notes |
|---|---|---|
| Laptop (x86) | Windows 10 laptop | CPU / GPU / RAM: **owner to fill in** |
| Laptop (Apple) | Mac | model / chip / RAM: **owner to fill in** |
| High phone | Samsung Galaxy S24 | above the mid tier; used as the Android upper reference |
| Mid phone | iPhone 14 | stands in for "iPhone 12-class" (faster than that class, so treat as the mid-tier ceiling) |
| Low phone | none yet | proxy: Chrome DevTools CPU 4x throttling and an assumed 4 GB memory budget; every number from the proxy is labelled **"proxy"** until a real low-end Android device exists |
| Desktop | none yet | CI runners and any owner desktop are interim; results labelled "interim" |

**Open items.** (1) Owner: Windows laptop CPU/GPU/RAM and Mac chip/RAM. (2) A real low-end Android device (Snapdragon 6-series, 4 GB) to replace the proxy. (3) A discrete-GPU desktop. (4) iOS 12-class device and a Chromebook are optional additions.
