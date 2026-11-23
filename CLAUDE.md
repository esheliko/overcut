# OverCut: developer notes

<!-- rules:begin (GENERATED from process/rules.json: edit there, then `npm run rules:build`) -->
> ## ⚠️ STANDING RULE: chain of command (who may change the process)
> Owner, 2026-11-20 (replaces the live-manager inbox of 2026-11-13). Process mechanisms: `DEPLOYING.md`, `process/`, the standing rules here, `.claude/` hooks and settings, CI workflows, deploy/watch/smoke scripts, notifications. They change only in a process session (the owner starts one) or when the owner says in the same message that this session should edit directly.
> - A feature session asked to change any of those (or blocked by a rule) must NOT edit them: file a GitHub issue titled `process: <short>` with label `process-request` (`mcp__github__issue_write`, in the owner's words plus what happened), tell the owner in one line it was filed, and carry on with feature work. Do not message the Deploy Manager session: it is no longer an inbox.
> - Rule text changes go in `process/rules.json` (then `npm run rules:build`), never by hand in CLAUDE.md or the hooks.
> - Feature code, tests and `docs/features/*` go through the normal branch + PR flow.

> ## ⚠️ STANDING RULE: every change is a branch + PR, merged only when CI is green
> Owner, 2026-11-12; steps 4-7 trimmed 2026-11-23. Never push to `main`. A handed branch (e.g. `claude/<name>`) is your PR branch: `git fetch origin main && git checkout -B <that-branch> origin/main`.
> 1. **Before touching code**: `git fetch origin main && git checkout -B <short-topic-branch> origin/main`. Never start from a stale checkout.
> 2. Change it there. Run `npm run lint && npm run typecheck && npm test` (CI also runs the WebAssembly build and smoke). `npm run build` only if you touched `crates/wasm`, `packages/engine-client`, the Vite config, `apps/web/public/sw.js` or how the engine is loaded. Finish all related changes, then push ONCE (every push costs a CI run).
> 3. `git push -u origin <branch>`, then ONE PR against `main` (`create_pull_request`; mirror the PR template; one change per PR). No PR for half-finished work.
> 4. **Wait for CI**: `subscribe_pr_activity`, end your turn; the `verify` verdict wakes you (cheap: a wake within the hour hits the warm prompt cache). Never poll or `sleep`. If subscribing fails, retry once; then read the `verify` check run yourself; never hand CI-waiting to the owner. Red `verify`: fix the cause on the same branch (change a test only when stale, and say so; never skip, delete or loosen one), push, wait again. Unrelated flake: re-run once and say so in the PR.
> 5. **Merge only when `verify` is green on the PR's latest commit**; if `main` moved, `update_pull_request_branch` and wait for the new verdict. Then `merge_pull_request` (squash, clear title, keep the `Claude-Session:` trailer). Never merge red or unverified, or someone else's PR unless the owner asked. Auto-merge is NOT available here (no branch protection on the free plan). If the branch delete fails, ignore it; do not retry.
> 6. **Done once merged.** A merge to `main` deploys the web app by itself (`deploy-web`, only when app code changed); native apps ship from version tags (`DEPLOYING.md`). Do NOT deploy, tag, release or wait unless the owner asked.
> 7. **A red `main` is still owned by someone.** A worker spawned by an orchestrator stops after merging (no watching, no extra report). An owner-driven session runs once in the background `node scripts/ci-status.mjs --wait --for <merge-sha>` (`git fetch origin main` first). The orchestrator runs `node scripts/ci-status.mjs` once per batch. Red `verify` prints one **Owner** session (the `Claude-Session:` trailer) and a `>>>` line with your role: **the Owner fixes it now** (new branch + PR, tell the owner if a released build is affected). A session that starts while `main` is red (start hook, issue #2) fixes what is plausibly its own area first.
> 8. **Times you tell the owner are ALWAYS Israel time (Asia/Jerusalem, IST), never UTC.** Get it with `TZ=Asia/Jerusalem date '+%Y-%m-%d %H:%M'`, do not convert in your head; logs, `git log`, GitHub and the CI board show UTC.
> Docs-only changes (CLAUDE.md, `docs/`, `.claude/`) follow the same flow. `.claude/hooks/session-start.sh` checks this every session.

> ## ⚠️ STANDING RULE: every reply is tagged, so the owner sees at a glance what is for them
> Owner, 2026-11-13; shortened 2026-11-23. Sessions wake themselves (CI, PR events, peers, wakeups), so **line 1 of EVERY reply, woken turns included, is one tag plus a one-sentence headline**:
> - `🔴 NEEDS YOU: <the ask>`: only a decision, answer, approval or action nobody but the owner can give, or a real problem you could not fix. The headline IS the ask.
> - `🟢 DONE: <result>`: the request is FULLY carried out or answered and nothing is left: no open question, offer ("want me to…"), recommendation awaiting a yes, or undone work (a complaint wants it fixed; explaining is not done). Any of those makes it `🔴 NEEDS YOU: decide <the choice>`.
> - `⚙️ AUTO: <what happened, what next>`: any turn the owner did NOT type (CI, PR event, peer, wakeup, own continuation), or an owner message where nothing is needed from them but work is unfinished. At most 2 lines (longer only to carry `What I did:`), no recap or tables. Never an owner question in `⚙️`: escalate to `🔴`.
> Layout: (1) the ask goes first: ask, options and recommendation in the first ~8 lines, background after a `Details:` line; (2) a woken turn that needs the owner restates the whole ask so it stands alone, plus one line on what happened since (times in IST); (3) owner-facing content first, background in one trailing line; (4) while an ask is unanswered every later turn (even `⚙️`) ends `⏳ Still waiting on you: <ask in under 12 words>` (`⏳ no longer needed: <why>` when it changes), no open ask: omit it; long-lived sessions keep the `Seniority:` line (DEPLOYING.md) last; (5) every other message to the owner (PushNotification, issue/PR comment meant for them) starts with the same tag, peer messages need none.
> **Change summary.** When the owner asks for a change, feature or fix, the reply has `What I did:` right under the tag line (2-5 plain bullets): how you understood it (owner's terms); what changed, including anything left out or done differently; for a fix, the logic before next to the logic now. Not for pure questions or `⚙️ AUTO` turns.

> ## ⚠️ STANDING RULE: orchestrators cap parallel workers, paused workers save their work
> Owner, 2026-11-22; tightened and corrected 2026-11-23. A session that spawns workers runs at most **3 at a time**, resumed ones included (park the extras). Before every spawn or resume read your own `rate_limit_info` (`get_session`). **All work stops at 90% of the 5-hour limit**: start and resume nothing, and every running worker (and the orchestrator) does the Pause step below and stops until the window resets. `rate_limit_info` shows only a status, not a percentage, so treat `rateLimitType` `five_hour` with any status other than `allowed` (the warning) as 90%, and any `rejected` as over it; use the owner's figure when they give one. A `seven_day` `allowed_warning` alone is NOT a reason to pause or park: pause for the weekly limit only at about 80% or more (ask the owner for the figure). Stagger spawns; never launch a wave.
> - **Pause** (the 90% stop, quota, or the owner says pause): every worker commits and pushes its WIP to its own branch (no PR) before stopping, then ignores CI and PR events until told to resume. Unpushed work in a container is lost. Resume only when the 5-hour window has reset (`resetsAt`) and status is `allowed` again.
> - One worker per vertical slice or set of related items; a follow-up goes to the session that holds the context; a docs-only edit is done directly, not by a new session.
> - **Handoff, not marathons.** A worker hands off at ~200k context or ~$2.50: push, then a short note (state, next step, branch) to a fresh session. Prompt cache lasts 1 hour: an ACTIVE session (woken within the hour) stays cheap, but one idle longer re-writes its whole context when woken, so above ~150k context hand off to a fresh session instead of waking it after a long idle. An orchestrator that is kept active retires only at ~600k context or when it starts losing track; do not retire it earlier.
> - Workers report once, in their final reply; the orchestrator does not poll them or message them one by one.
<!-- rules:end -->

## What this project is
A free, fast, feature-complete video and media editor for every device and screen: comfortable and quick to use, no watermark, no paywall, no account, everything running on your own device.

One codebase for every platform: a **Rust engine** (`crates/`) compiled to WebAssembly for browsers and used natively inside **Tauri 2** shells (`apps/desktop`: Windows, macOS, Linux, and iOS/Android via `tauri ios|android init`), with one **TypeScript + React UI** (`apps/web`, also the installable PWA). No backend: everything runs on the user's device. See README.md for setup and `DEPLOYING.md` for shipping.

## Layout
- `crates/core` (`app-core`): the engine's pure logic. No platform crates, no I/O except through traits. Everything testable lives here.
- `crates/wasm` (`app-wasm`): thin wasm-bindgen bindings. Forward to `app-core`; no logic.
- `apps/desktop/src-tauri`: native shell and its commands. Own Cargo workspace (needs webview libraries), thin like `crates/wasm`.
- `packages/engine-client` (`@app/engine-client`): the typed `Engine` interface and its two backends (`wasm.ts`, `tauri.ts`). **The only door from UI to engine.**
- `apps/web` (`@app/web`): the UI (React 19, Vite). Responsive from phone to ultrawide; keyboard and touch both first-class.
- `scripts/`: tooling (`build-wasm`, `check-boundaries`, `smoke`, `shot`, `vercel-output`, `deploy-board` (writes the Deploy board issue, `DEPLOYING.md`), rules/CI helpers).
- `docs/`: architecture, roadmap, decisions (create what the project needs; per-feature rules in `docs/features/<feature>.md`).

## Commands
- `npm ci` once. `npm run dev` (builds the engine, serves the web app on :5173), `npm run build` (engine + web, output `apps/web/dist`), `npm run typecheck`, `npm run lint` (eslint, boundaries, rules sync, rustfmt, clippy `-D warnings`), `npm test` (TypeScript + `cargo test --workspace`), `npm run smoke` (Playwright against the build, desktop and phone viewports).
- Engine only: `cargo test -p app-core`, `cargo clippy --workspace --all-targets`. Build the wasm package alone: `npm run build:wasm` (needs the `wasm-bindgen` CLI at the version pinned in `crates/wasm/Cargo.toml`; `--dev` skips optimisation).
- Desktop: `npm run desktop:dev` / `desktop:build` (needs the platform webview libraries: `DEPLOYING.md`).

## Conventions
- **Boundaries** (enforced by `npm run lint`, `scripts/check-boundaries.mjs`): the core depends on no platform crate; only `engine-client` imports the wasm package or `@tauri-apps/*`; UI never imports Rust paths. New capability = Rust function in `app-core` + binding in `crates/wasm` AND a command in `src-tauri` + method on `Engine` + both backends + a test. Never one platform only.
- **Cross-boundary data** is JSON or typed buffers described in `packages/engine-client/src/types.ts`; bump `ABI_VERSION` (core) and `EXPECTED_ABI` (client) together on an incompatible change. Large media data never goes through JSON.
- **Performance is a feature**: nothing heavy on the UI thread (engine work runs in a Worker on the web), no per-frame allocation in hot paths, measure before and after (`docs/` holds the budgets once they exist). A change that makes the app slower than its budget is a bug.
- **Every screen size**: no horizontal page scroll at 320 px, touch targets >= 44 px, safe-area insets respected, no hover-only controls. The smoke test checks overflow at phone and desktop widths; screenshot visual changes at both.
- **Free and private by default**: no accounts, no tracking, no paywalled feature, works offline. Anything that needs a server is optional, documented, and has a local fallback.
- Pure logic goes in Rust (`crates/core`, unit test next to it) or `packages/*` (test in `tests/unit/`); every new screen/flow gets a smoke step in `tests/smoke/`.
- Decorative or optional sections must fail soft: catch and render nothing or a small note, never take the app down.
- Verification: `npm run lint && npm run typecheck && npm test`; CI `verify` also runs the wasm build, the web build and smoke.

## Token cost (size x turns is the bill: ~300 tokens are re-read for every token written)
- A session starts at ~104k tokens (tools, skills, connectors) before any code, mostly account-level: turn off unused connectors in claude.ai settings (~10k each); `.claude/settings.json` disables the org plugins this project never uses, do not re-enable them.
- One task per session; hand over with a short note, not a long thread. Worker handoff at ~200k context and the 1-hour cache rule: orchestration rule above.
- Read narrowly (`Grep`/`Read` with `offset`+`limit`; `docs/features/<feature>.md` only for the feature you change); subagent for wide research; never dump `list_events` or logs into the conversation, filter them with a script.
- Run the checks once at the end, not after every edit; `npm run smoke` only when the change touches a page flow.

## Screenshots for visual changes
- **Show one** (same view, viewport and data as the owner's; before/after when it was a complaint) when the owner complained or sent a screenshot, you chose the visuals (layout, colours, spacing, icons, animation, new UI), or the result is your interpretation of a requested look. Not done without it; if the view cannot be reproduced, say so and show the closest.
- **Skip** when the owner dictated the exact result ("make this button red") or nothing visible changes (logic, data, docs, CI); say so in one line.
- Cheap: `node scripts/shot.mjs "/" --sel "main" --out <scratchpad>/here.png` (builds, serves, signs in as the smoke user; `--phone` = 390x844; flags in the script header). One shot per view, look once, then `SendUserFile` (path inside the scratchpad).
- Enforced by `.claude/hooks/session-start.sh` and `prompt-submit.sh`: keep both when editing hooks.

## Product rules (OverCut)
- **Read before building**: `docs/PRODUCT.md` (principles), `docs/ARCHITECTURE.md` (module boundaries), the feature's row in `docs/FEATURES.md` and the milestone in `docs/ROADMAP.md`. Read `docs/features/<feature>.md` before changing that feature; write it (short: behaviour, data model, edge cases, test plan) in the same PR that introduces the feature.
- **The plan is the scope.** Build only what the current milestone lists; anything else becomes an issue. Changing the plan (a feature, a milestone, a budget) is a PR to `docs/` with the reason, not a side effect of code.
- **Decisions are ADRs** (`docs/adr/NNNN-title.md`, Status: proposed/accepted/superseded). An architecture-level change without an ADR is incomplete. Open decisions are listed in `docs/adr/README.md`: do not silently pick one.
- **Free means free.** Never add a feature gate, watermark, account requirement, telemetry that is on by default, or a dependency whose license forbids free redistribution. Check codec/patent notes in `docs/adr/0004-media-io.md` before adding an encoder or decoder.
- **Engine module map** (`crates/`): `core` (handshake, shared types) -> `model` (project data, time, ids) -> `timeline` (edit operations, undo) / `media` (probe, decode traits, cache) / `audio` / `fx` -> `render` (GPU compositor) -> `export`; `ai` (on-device models) sits beside `fx`. Dependencies only point left to right (declared in each `Cargo.toml`); do not add a back edge.
- **Time is integer ticks** (`docs/adr/0010-time.md`), never floats; **edits are operations** (`docs/adr/0006-edit-operations.md`), never direct mutation of project state; both are enforced by review and by tests in `app-model` / `app-timeline` once they exist.
- **Performance budgets** are in `docs/PERFORMANCE.md`. A feature PR states its measured cost (frame time, memory, startup) when it touches playback, render, export or the timeline.

## Known gaps
- (none yet: list what is thin or missing so the next session does not assume it exists. Tauri mobile targets are not initialised until someone runs `tauri ios init` / `tauri android init`; the desktop shell is only compile-checked in CI, not covered by smoke tests.)

## Workflow
See the standing rule at the top: every change is a branch + PR, merged when its CI is green; a merge to `main` deploys the web app; native apps ship from version tags. No direct pushes to `main`.
