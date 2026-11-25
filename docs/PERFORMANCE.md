# Performance

"Fast" is a requirement with numbers. Budgets are measured in CI where possible and on the device lab otherwise; a milestone cannot exit with a budget missed. Numbers are initial and are tuned by the S1-S8 spikes; changing one is a PR to this file with data.

## Reference devices (ADR 0013, accepted)
| Tier | Example | Used for |
|---|---|---|
| Low phone | Android, Snapdragon 6-series / 4 GB RAM, Chrome WebView. no physical device (owner decision): emulator (API 34, 4 GB, 720x1600) for function/memory; perf measured on the Galaxy S24 and scaled by SoC benchmark ratio (Helio G99 / Exynos 1280 class), numbers labelled "calibrated proxy" (ADR 0013) | floor for mobile budgets |
| Mid phone | iPhone 14 (owner's); high phone: Samsung Galaxy S24 (owner's) | typical mobile |
| Laptop | owner's Windows 10 laptop (assumed: i5 10th-gen class, integrated GPU, 8 GB) and Mac (assumed: M1, 8 GB) | desktop baseline |
| Desktop | discrete GPU, 16-32 GB; none yet, CI runners are "interim" | high-end, 4K |

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

## M1 exit criteria and where each is measured
| Exit criterion (ROADMAP M1) | Metric (`tests/perf/metrics.mjs`) | Budget | Measured today |
|---|---|---|---|
| 1080p preview 60 fps on the reference laptop | `device.decode_fps`, `device.fill_layers_at_60fps` (+ `preview.fps`) | decode >= 60 fps, >= 3 layers at 60 fps | **container only** (software decode, 320x180 clip): trend. Windows laptop: decode 720 fps, 11 layers at 60 fps (pass); `/diagnostics` has no end-to-end preview test, so 60 fps preview itself is still unproven on a device; Mac pending |
| Export >= 1x realtime on the reference phone browser | `export.speed_x` | low phone >= 0.7x, mid >= 1.5x | **container only**: 1080p30 5 s synthetic project, H.264 via software WebCodecs, about 0.16x, which says nothing about a phone with a hardware encoder. Phone numbers need an in-app export on the S24 and iPhone 14 (not in `/diagnostics` yet) |
| Activation test (import, trim, export) < 90 s | not automated | 90 s | **manual** (a person with a stopwatch on a first-time user, script in [ACTIVATION-TEST.md](ACTIVATION-TEST.md)); no harness number |
| Startup | `startup.warm_ms`, `startup.cold_ms`, `size.*` | table above | **container** (headless Chromium, no throttle): trend; sizes are exact |
| Budgets measured in CI | `npm run perf` + `perf:compare` | warn +10%, fail +25% | the CI job is requested separately (`process: perf job`), not wired yet |

## Real-device results (from `/diagnostics`, 2026-11-23; files in `tests/perf/devices/`)
| Metric | Budget (laptop / mid) | Windows laptop (UHD 630, Chrome 157; 12 cores, 32 GB: **not** the assumed i5 8 GB) | Galaxy S24 (Xclipse 940, Chrome 157) |
|---|---|---|---|
| 1080p H.264 decode | >= 60 fps | 720 fps (pass) | 234 fps (pass) |
| Random seek p50, GOP 30 | <= 50 / 80 ms | 37.6 ms (pass) | 58.5 ms (pass) |
| Random seek p95, GOP 150 | no budget | 201.7 ms | 376.2 ms |
| Full-HD layers at 60 fps | >= 3 | 11 (pass) | not measured: no WebGPU in this Chrome |
| VideoFrame to GPU, best path p50 | no budget | 5.9 ms (copy; direct import 22.8 ms is slower here) | not measured (no WebGPU) |

Findings: seek on long-GOP media is the weak spot on both (200-380 ms p95 against a 50-80 ms scrub budget for GOP 30), so proxies or a keyframe cache matter for long-GOP sources. The S24's Chrome exposes no WebGPU, so the compositor needs its WebGL2 path there (WebGL2 is available). The Mac and the iPhone 14 are not measured yet.

### Low-end Android (Galaxy A15-class), calibrated proxy

**Calibrated proxy, not a measurement** (ADR 0013; file `tests/perf/devices/galaxy-a15-proxy.json`). Galaxy S24 report scaled with `npm run perf:device -- --tier low --name galaxy-a15-proxy --proxy-ratio 3.333`. Target: Galaxy A15 (MediaTek Helio G99, Mali-G57 MC2, 4 GB) vs Galaxy S24 (Exynos 2400, Xclipse 940). **Ratios are conservative estimates to verify** against published figures (not yet cited): CPU about 0.30 (Geekbench 6 multi-core class), GPU about 0.15. The tool takes one slowdown factor, so every metric below uses the CPU one (1 / 0.30 = 3.333: times x 3.333, rates / 3.333). The GPU ratio (0.15, slowdown 6.7) applies to the fill-rate and upload metrics, which have no S24 number (no WebGPU), so none is produced. Hardware decode speed does not really scale with CPU, so the decode figure is a pessimistic bound.

| Metric | Budget (low) | Calibrated proxy |
|---|---|---|
| 1080p H.264 decode | >= 30 fps | 70 fps (pass) |
| Random seek p50, GOP 30 | <= 120 ms | 195 ms (**fails**) |
| Random seek p95, GOP 150 | no budget | 1254 ms |

Update (seek decode change, `docs/features/preview.md`): the proxy numbers above are from before it and are **not re-derived**; the ratios are still estimates, and the change only helps streams with B-frames (about -25 % p50 on a container B-frame GOP-150 clip, ~0 on IPPP and GOP 30). Re-run `/diagnostics` on the S24 before claiming the low-tier budget.

Finding: scrubbing long-GOP media on a low phone misses budget on the proxy, so automatic proxies / a keyframe cache are required for low-tier devices.

**Scrub strip (done, `docs/features/preview.md` "Smooth scrubbing")**: clips the rule flags (estimated or measured seek p95 > 120 ms) get a background-built strip of small JPEGs, and the first picture of a scrub is the strip's picture of the exact frame (<= 1 frame off), so "first frame after seek <= 120 ms" is met by the strip while the exact frame still decodes in 200-380 ms (laptop/S24) or ~1.2 s (low proxy) and replaces it. The exact-frame time is unchanged by design (playback and export use the original). Container numbers on a 1280x720 GOP-150 fixture: stand-in distance p50/p95 12/83 -> 0/1 frames; exact frame ~95/175 ms before and after. **Not measured on a device**: re-run `/diagnostics` plus a real phone clip on the S24 before claiming the low-tier budget.

**Proxies (S10, `docs/adr/0016-proxies.md`, container, software, not a device)**: 4K30 45 Mbps GOP-150 source -> 720p/540p GOP-30 no-B H.264 proxy: transcode 2.3-2.6x realtime on 4 vCPU (0.7x on one), size 0.9-1.5% of the source (synthetic, optimistic; budgeted by bitrate cap), random seek p50/p95 28/58 ms (720p) and 9/25 ms (540p) against 2003/4473 ms on the original (single thread). Laptop (~25/33 ms) and low-tier proxy (~76/128 ms at 720p, ~49/79 ms at 540p) are **calibrated estimates** from the seek model, not measurements; transcode speed on the laptop is unverified. Resume after `kill -9`: byte-identical output, lost work one 4 s segment.

## Measurement status per metric and tier
`C` = measured in the container harness (trend number: shared Xeon CPU, software decode, no real GPU; compare only with a baseline from the same kind of machine). `D` = real-device number from `/diagnostics` (Windows laptop and Galaxy S24 so far, table above). `P` = calibrated proxy (S24 number scaled by the SoC benchmark ratio, ADR 0013; always labelled). `-` = not measured anywhere yet.

| Metric | Low phone | Mid phone (iPhone 14) | Laptop (i5 / M1) | Desktop |
|---|---|---|---|---|
| Startup, cached load | `C` | `-` | `C` | `C` |
| Shell JS gzip, engine WASM gzip | exact (build output) | | | |
| Open 500-clip project | `-` | `-` | `-` | `-` |
| Preview fps, dropped frames | `-` (decode: `P` from `D`) | `D` decode, fill rate | `D` decode, fill rate; `C` playback | `-` |
| Scrub, first frame after seek | `C`, `P` | `D` (random seek) | `D`, `C` | `-` |
| Timeline pan/zoom (1000 clips x 20 tracks) | `C` (4x throttle, dpr3 phone viewport) | `C` (4x throttle) | `C` (desktop) | `C` |
| Editing op, 5k clips (Rust) | `C` x CPU ratio only | `C` | `C` | `C` |
| Input, drag pointer-to-paint | `C` (throttled) | `C` (throttled) | `C` | `C` |
| Export 1080p30 speed | `-` | `-` | `-` | `-` |
| Memory, battery, native size | `-` | `-` | `-` | `-` |

The 4x CPU throttle approximates a phone but is not one; a throttled-container number never replaces a device number.

## How we measure
- **One command: `npm run perf`** (`tests/perf/run.mjs`) builds once, then runs everything headless and writes `tests/perf/perf-results.json` with the environment (CPU, cores, Node, browser, commit). Metrics and their budgets live in `tests/perf/metrics.mjs` (keep it in step with the tables above). `--no-build` reuses the last build; `--out <file>` writes elsewhere. About 2 minutes. Needs the Rust toolchain, the `wasm-bindgen` CLI and Playwright's Chromium (`PLAYWRIGHT_CHROMIUM_PATH` if it is installed elsewhere).
  - Timeline pan/zoom fps and drag input-to-paint at desktop, desktop 4x throttle, and phone 390x844 dpr3 4x throttle: `tests/perf/timeline-bench.mjs` (S8), reduced to the worst phase / worst drag p95.
  - Preview: 2 s of playback of `crates/media/tests/fixtures/flash_click.mp4` (presented fps, dropped frames, lateness p95); the 2 s window opens once playback is running (first frame advanced), and press-to-running start-up is reported separately as `startupMs` and 40 random seeks (scrub p50/p95), same method as `tests/smoke/preview.spec.ts`.
  - Export: 5 s 1080p30 synthetic project through the export harness (H.264 if the browser can encode it, else VP9); `export.speed_x` = video seconds per wall second.
  - Startup: cold (empty cache) and cached load until the engine badge says `(wasm)`. Sizes: gzip of the built shell JS/CSS, engine glue JS and the largest `.wasm`.
  - Rust: `cargo run --release -p app-timeline --example bench` (apply one op and evaluate one frame on 5000 clips, best of 5 rounds; no extra dependency).
- **Compare** (`npm run perf:compare -- [new.json] [baseline.json]`, defaults `perf-results.json` vs the checked-in `tests/perf/baseline.json`): prints the table, exits 1 at +25% worse, warns at +10%; "worse" follows each metric's direction; changes below an absolute noise floor are ignored. The baseline was taken in a container (`environment` in the file): refresh it in a PR when a deliberate change moves a number, never to hide a regression. Runs in CI as the non-blocking `perf` job (below).
- **CI** (`perf` job in `.github/workflows/ci.yml`, issue #51): after `verify` it downloads the `web-dist` build, runs `npm run perf -- --no-build --out perf-results.json`, compares with `tests/perf/baseline.json` (table in the job summary) and uploads `perf-results` (30 days). It is `continue-on-error` and nothing requires it, so a red perf job never blocks a merge; read the summary. Runner numbers differ from the container baseline, so expect warnings until the baseline is refreshed from CI.
- **Refreshing the baseline from CI**: download the run's `perf-results` artifact, copy `perf-results.json` over `tests/perf/baseline.json`, commit it in a PR that says why (a deliberate change or a new machine kind), never to hide a regression.
- **Fuzz** (`fuzz` job): `cargo +nightly fuzz run` for 60 s each on `crates/media` `demux` (seeded with the fixtures) and `crates/model` `project_file`. Non-blocking; a crash uploads its `fuzz-<target>` artifact. Reproduce: `cd crates/<crate> && cargo +nightly fuzz run <target> fuzz/artifacts/<target>/<file>`.
- **Devices** (`npm run perf:device -- --tier <low|mid|laptop|desktop> [--name <slug>] <pasted /diagnostics line or file>`): stores `tests/perf/devices/<slug>.json` and prints the numbers against that tier's budget. For the low tier pass the Galaxy S24 report with `--proxy-ratio <SoC ratio>`: the file is marked "calibrated proxy" with the ratio used. Device files are the record that a hardware bar was proven (plan section 4a).
- **Frame-time instrumentation** is compiled in (preview stats: presented, dropped, late); a debug overlay is still to come.
- **Microbenchmarks** for render graph, DSP and cache follow with those modules; add them to `tests/perf/run.mjs` and `metrics.mjs` in the PR that adds the module.

## E2 gate: editing ops (M2-011, measured 2026-11-25 in the container, 4-core Xeon 2.3 GHz, release)
- **Property run** (`npm run test:e2` = `PROPTEST_CASES=10000 cargo test -p app-timeline --release`): all 29 op kinds in the S7 generator, 10,000 random sequences each for the two properties, 0 failures. Whole `app-timeline` suite 3.7 s wall; 100,000 cases (the S7 bar) 33 s, 0 failures.
- **Op bench** (`cargo run --release -p app-timeline --example bench`, JSON keys `mix_20x250_*` and `mix_20x1000_*`; `BENCH_KINDS=1` prints each op kind): the compound edit mix (move, trim, split, ripple trim incl. all-tracks, slip, slide, transform, delete, each undone after) on 20 tracks.
  | Project | mean per op | worst op | budget |
  |---|---|---|---|
  | 20 tracks x 250 = 5k clips | 0.016 ms | 0.76 ms (all-tracks ripple trim from the start) | <= 2 ms |
  | 20 tracks x 1000 = 20k clips (stress) | 0.22 ms | 12.9 ms (same ripple, moves 20k clips) | none (4x the budget size) |
  Single-clip ops stay under 0.2 ms even at 20k clips. Before this gate a ripple over n clips was O(n^2) (each step prepended its inverse): 3.3 ms worst at 5k and 35 ms at 20k. What is left is one linear `find_clip` per shifted clip; an id index is the next lever if a UI test needs it.

## Design rules that keep it fast
1. Nothing heavy on the UI thread; engine in a Worker (web) / dedicated threads (native).
2. GPU-resident frames end to end where the platform allows; avoid CPU readbacks except at export.
3. Decode ahead of the playhead with a byte-budgeted cache; proxies for large media on weak devices (automatic).
4. Timeline and waveforms are canvas/GPU, virtualized, with level-of-detail; no DOM node per clip.
5. Allocation-free hot paths (frame evaluate, mixer callback); arenas and ring buffers.
6. Quality adapts before smoothness does (drop preview resolution, then effects quality, never audio).
7. Every long operation is a cancellable, resumable job.
