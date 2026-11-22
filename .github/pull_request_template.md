## What and why
<!-- One change per PR. What changed, and why. -->

## Checks
- [ ] `npm run lint && npm run typecheck && npm test` pass locally (Rust and TypeScript)
- [ ] `npm run build` run if I touched `crates/wasm`, `packages/engine-client`, the Vite config, `apps/web/public/sw.js` or engine loading
- [ ] New engine logic has a Rust unit test in `crates/*`; new UI flow has a smoke step in `tests/smoke`
- [ ] Works on phone width and with a keyboard (screenshot attached for visual changes)

## Merge rule
Squash-merge only when `verify` is green on this PR's latest commit. A merge to `main` deploys the web app by itself; desktop/mobile apps ship from version tags only (`DEPLOYING.md`). Keep the `Claude-Session:` trailer if one was used.
