# Performance

"Fast" is a requirement with numbers. Budgets are measured in CI where possible and on the device lab otherwise; a milestone cannot exit with a budget missed. Numbers are initial and are tuned by the S1-S8 spikes; changing one is a PR to this file with data.

## Reference devices (to be fixed in ADR 0013; proposal)
| Tier | Example | Used for |
|---|---|---|
| Low phone | Android, Snapdragon 6-series / 4 GB RAM, Chrome WebView | floor for mobile budgets |
| Mid phone | iPhone 12-class, mid Android (8 GB) | typical mobile |
| Laptop | Apple M1 / recent integrated-GPU x86, 8-16 GB | desktop baseline |
| Desktop | discrete GPU, 16-32 GB | high-end, 4K |

## Budgets
| Area | Metric | Low phone | Mid phone | Laptop | Desktop |
|---|---|---|---|---|---|
| Startup | web: interactive after cached load | <= 2.5 s | <= 1.5 s | <= 1 s | <= 1 s |
| Startup | first-ever load, shell JS (gzip) | <= 250 KB | <= 250 KB | <= 250 KB | <= 250 KB |
| Startup | engine WASM download (gzip, lazy) | <= 2.5 MB | | | |
| Project | open 500-clip project | <= 1.5 s | <= 1 s | <= 0.5 s | <= 0.5 s |
| Preview | 1080p30, 3 video layers + 2 effects | 30 fps | 30-60 fps | 60 fps | 60 fps |
| Preview | 4K30, 1 layer (proxy allowed) | n/a | 30 fps | 30 fps | 60 fps |
| Scrub | first frame after seek (warm) | <= 120 ms | <= 80 ms | <= 50 ms | <= 33 ms |
| Timeline UI | pan/zoom, 1000 clips, 20 tracks | 30 fps | 60 fps | 60 fps | 60 fps |
| Editing op | apply op + patch UI, 5k clips | <= 8 ms | <= 4 ms | <= 2 ms | <= 1 ms |
| Input | pointer-to-visual response while dragging | <= 33 ms | <= 20 ms | <= 16 ms | <= 16 ms |
| Export | 1080p30 H.264, real-time multiple | >= 0.7x | >= 1.5x | >= 3x | >= 5x (HW) |
| Export | 4K30 | n/a | >= 0.5x | >= 1.5x | >= 3x |
| Memory | 30 min 4K project (with proxies) | no OOM at 4 GB | | <= 3 GB | <= 4 GB |
| Battery | 10 min editing session | <= 8% drain on mid phone (indicative) | | | |
| Size | native install (no models) | <= 80 MB mobile | | <= 150 MB desktop | |

## How we measure
- **Microbenchmarks** (`criterion`) per crate for ops, evaluate, render graph build, DSP, cache; CI compares to the main-branch baseline (warn +10%, fail +25%).
- **Scenario benchmarks** (`tests/perf`, Playwright + engine hooks): open project, scrub script, play 30 s, export 60 s clip; run on CI hardware for trends and on the device lab per release.
- **Frame-time instrumentation** always compiled in, exposed in a debug overlay (p50/p95/p99 frame time, dropped frames, decode queue, GPU time, memory), and recorded in benchmark output.
- **Bundle budget** check in CI (shell JS, WASM size, per-route chunks); lighthouse-style startup test on throttled CPU.

## Design rules that keep it fast
1. Nothing heavy on the UI thread; engine in a Worker (web) / dedicated threads (native).
2. GPU-resident frames end to end where the platform allows; avoid CPU readbacks except at export.
3. Decode ahead of the playhead with a byte-budgeted cache; proxies for large media on weak devices (automatic).
4. Timeline and waveforms are canvas/GPU, virtualized, with level-of-detail; no DOM node per clip.
5. Allocation-free hot paths (frame evaluate, mixer callback); arenas and ring buffers.
6. Quality adapts before smoothness does (drop preview resolution, then effects quality, never audio).
7. Every long operation is a cancellable, resumable job.
