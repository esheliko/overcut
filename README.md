# OverCut

> A free, fast, feature-complete video and media editor for every device and screen: comfortable and quick to use, no watermark, no paywall, no account, everything running on your own device.

**Status: foundations only (milestone M0).** The repository holds the plan, the architecture and an empty-but-wired skeleton. No editing feature exists yet. Start with [`docs/README.md`](docs/README.md).

## The idea in five lines
- **Free, really**: no watermark, no paywalled effects, no account, no ads, no subscription. Sustained as an open project, not by locking features.
- **Everywhere**: one codebase for browser (installable PWA), Windows, macOS, Linux, iOS and Android; phone, tablet, laptop and desktop layouts are all first-class.
- **Fast**: a Rust engine with GPU compositing (WebGPU/wgpu) and hardware codecs; editing never waits for the network.
- **Private**: projects and media stay on your device; AI features run on-device; nothing is uploaded unless you choose to share.
- **Complete**: multi-track timeline, keyframes, text and captions, audio mixing, effects, transitions, color, masks, chroma key, speed ramps, templates, and on-device AI tools. See [`docs/FEATURES.md`](docs/FEATURES.md).

## Where things are
| Read | For |
|---|---|
| [`docs/PRODUCT.md`](docs/PRODUCT.md) | vision, principles, who it is for, how it beats CapCut, success measures |
| [`docs/FEATURES.md`](docs/FEATURES.md) | the full feature list with priority, milestone and CapCut parity |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | milestones M0 to M9 with exit criteria |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | system design, engine modules, data flow, platforms |
| [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) | risk-first spikes, workstreams, the first issues, how work flows |
| [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md), [`docs/QUALITY.md`](docs/QUALITY.md) | budgets, testing, accessibility |
| [`docs/adr/`](docs/adr/) | the decisions made so far, and the ones still open |

## Run it
You need Node 22+, a recent stable Rust (`rustup`) and the bindgen CLI:
```bash
cargo install wasm-bindgen-cli --version 0.2.130 --locked   # the version pinned in crates/wasm/Cargo.toml
npm ci
npm run dev        # http://localhost:5173: the empty editor shell and the engine handshake
```
Checks: `npm run lint && npm run typecheck && npm test`, then `npm run build && npm run smoke`. Shipping: [`DEPLOYING.md`](DEPLOYING.md). Working rules for people and Claude sessions: [`CLAUDE.md`](CLAUDE.md).

## License
Not chosen yet: it is an open decision with a recommendation in [`docs/adr/0009-license.md`](docs/adr/0009-license.md). Until it is decided, all rights are reserved.
