# 0013 Reference devices
**Status**: **open: owner decision** (blocks the M1 performance gates)

**Context.** Budgets in `docs/PERFORMANCE.md` are only meaningful on named hardware.

**Proposal.** Four tiers: low phone (Android, Snapdragon 6-series class, 4 GB), mid phone (iPhone 12-class), laptop (Apple M1 or recent integrated-GPU x86, 8-16 GB), desktop (discrete GPU, 16-32 GB). A concrete device list (2 iOS, 3 Android incl. one low-end, 1 Mac, 1 Windows laptop, 1 Windows/Linux desktop, 1 Chromebook) forms the device lab. Owner decides which devices already exist and which to buy or borrow; until then the CI runners and the owner's own devices are the interim references and results are labelled "interim".
