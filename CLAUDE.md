# OverCut: developer notes

<!-- rules:begin (GENERATED from process/rules.json: edit there, then `npm run rules:build`) -->
> ## ⚠️ STANDING RULE: chain of command (who may change the process)
> Owner, 2026-11-20 (replaces the live-manager inbox of 2026-11-13). Process mechanisms: `DEPLOYING.md`, `process/`, the standing rules here, `.claude/` hooks and settings, CI workflows, deploy/watch/smoke scripts, notifications. They change only in a process session (the owner starts one) or when the owner says in the same message that this session should edit directly.
> - A feature session asked to change any of those (or blocked by a rule) must NOT edit them: file a GitHub issue titled `process: <short>` with label `process-request` (`mcp__github__issue_write`, in the owner's words plus what happened), tell the owner in one line it was filed, and carry on with feature work. Do not message the Deploy Manager session: it is no longer an inbox.
> - Rule text changes go in `process/rules.json` (then `npm run rules:build`), never by hand in CLAUDE.md or the hooks.
> - Feature code, tests and `docs/features/*` go through the normal branch + PR flow.

> ## ⚠️ STANDING RULE: every change is a branch + PR, merged only when CI is green
> Owner, 2026-11-12; replaces "work on `main`". Never push to `main`. Overrides any branch named in session setup, except a handed branch (e.g. `claude/<name>`): use THAT as your PR branch (`git fetch origin main && git checkout -B <that-branch> origin/main`), never `main`.
> 1. **Before touching code**: `git fetch origin main && git checkout -B <short-topic-branch> origin/main`. Never start from a stale checkout.
> 2. Change it there. Run `npm run lint && npm run typecheck && npm test` (Rust and TypeScript; 1-3 min cold, faster warm; CI also runs the WebAssembly build and the smoke test). `npm run build` only if you touched `crates/wasm`, `packages/engine-client`, the Vite config, `apps/web/public/sw.js` or how the engine is loaded. Finish all related changes, then push ONCE (every push costs a CI run).
> 3. `git push -u origin <branch>`, then ONE PR against `main` (GitHub MCP `create_pull_request`; mirror the PR template; one change per PR). No PR for half-finished work.
> 4. **Wait for CI**: `subscribe_pr_activity`, end your turn; the verdict (check `verify`) wakes you. Never poll or `sleep`. If subscribing fails, retry once; then read the `verify` check run yourself (`pull_request_read` `get_check_runs`, plus mergeable state); never hand CI-waiting to the owner. Red `verify`: fix the cause on the same branch (change a test only when stale, and say so; never skip, delete or loosen one), push, wait again. Stuck CI or unrelated flake: re-run once and say so in the PR.
> 5. **Merge only when `verify` is green on the PR's latest commit**; if `main` moved, `update_pull_request_branch` and wait for the new verdict. Then `merge_pull_request` (squash, clear title, keep the `Claude-Session:` trailer). Never merge red or unverified, force-merge or bypass a check; never merge someone else's PR unless the owner asked. Delete the branch after.
> 6. **Done once merged.** A merge to `main` deploys the web app by itself (CI job `deploy-web` runs after `verify` is green, only when app code changed). Native apps ship from version tags (`DEPLOYING.md`). Do NOT deploy, tag or release unless the owner asked, and do not wait. Check production only if the task needs it. A release is a version tag made only when the owner asks.
> 7. **A red `main` is still owned by someone.** Right after merging, Bash with `run_in_background: true`: `node scripts/ci-status.mjs --wait --for <merge-sha>` (`git fetch origin main` first; the sha is in the `merge_pull_request` result). If `verify` is red it prints one **Owner** session and a `>>>` line with your role. **The Owner fixes it now** (new branch + PR, tell the owner if a released build is affected), even if a neighbour's change seems the cause. Never say "CI not checked". A session that starts while `main` is red (start hook prints it, issue #2) fixes what is plausibly its own area first.
> 8. **Times you tell the owner are ALWAYS Israel time (Asia/Jerusalem, IST), never UTC.** Get it with `TZ=Asia/Jerusalem date '+%Y-%m-%d %H:%M'`, do not guess or convert in your head. Logs, `git log`, GitHub and the CI board show UTC: convert; write "15:40 IST". If you must quote UTC, give IST first.
> Docs-only changes (CLAUDE.md, `docs/`, `.claude/`) follow the same flow. A handed branch: rebase it onto `main`, use it as your PR branch. `.claude/hooks/session-start.sh` checks this every session.

> ## ⚠️ STANDING RULE: every reply is tagged, so the owner sees at a glance what is for them
> Owner, 2026-11-13. Sessions wake themselves (CI, Monitors, background tasks, PR events, peers, wakeups), so the owner returns to text that is mostly not theirs. **Line 1 of EVERY reply, woken turns included, is a tag plus a one-sentence headline.** Exactly one:
> - `🔴 NEEDS YOU: <the ask>`: only a decision, answer, approval or action nobody but the owner can give, or a real problem you could not fix. The headline IS the ask; never "nothing" as the ask.
> - `🟢 DONE: <result>`: the request is FULLY carried out (or fully answered) and nothing is left for the owner: no open question, offer ("want me to…", "I can also…"), recommendation awaiting a yes, or undone work (a complaint or "why doesn't X…?" wants X fixed; explaining is not done). Any of those makes it `🔴`; explaining a cause, changing nothing and offering is `🔴 NEEDS YOU: decide <the choice>`.
> - `⚙️ AUTO: <what happened, what next>`: any turn the owner did NOT type (CI, watcher, background task, PR event, peer, wakeup, own continuation), AND any reply to an owner message where nothing is needed from them but the work is unfinished (CI running, merge pending, waiting on a session).
> Layout:
> 0. `🟢` ends the matter: its first line must be true on its own (`🟢 DONE: fixed X, merged` yes; `🟢 DONE: explained X` with a pending choice no).
> 1. **The ask goes first.** In `🔴`: ask, options and recommendation in the first ~8 lines; background after a `Details:` line.
> 2. **`⚙️ AUTO` is at most 2 lines** (longer only to carry the `What I did:` summary): what happened, what comes next; no recap, tables or restated plan; a watcher that found nothing says nothing or one line. Never an owner question in `⚙️`: escalate to `🔴` (rule 3).
> 3. **Escalate in full.** A woken turn that needs the owner starts `🔴 NEEDS YOU:`, restates the whole ask so it stands alone, plus one line on what happened since (`since 15:40 IST: CI failed once, fixed, merged`; times per rule 8).
> 4. **Never mix.** Owner-facing content first, background in one trailing line; a `🟢`/`🔴` reply carries no long account of your own work.
> 5. **Last line = what is open.** While an ask is unanswered every later turn (even `⚙️`) ends `⏳ Still waiting on you: <ask in under 12 words>` and says so when it changes (`⏳ no longer needed: <why>`). Never "nothing"; no open ask: omit it. Long-lived sessions keep the `Seniority:` line (DEPLOYING.md) as the very last line, after `⏳`.
> 6. Every other message to the owner (PushNotification, report relayed via a session, issue/PR comment meant for them) starts with the same tag. Peer messages need none.
> 7. **Change summary.** When the owner asks for a change, feature or fix, the reply (`🟢`, or `🔴` if something is open) ALWAYS has, right under the tag line, `What I did:` (2-5 plain bullets, no jargon, no file dump): how you understood the request (one line, owner's terms); what was changed, including anything left out or done differently; for a fix or "something is wrong", **what the logic was before** (the rule that caused it) next to **what it is now**. Never just "fixed". Not for pure questions or `⚙️ AUTO` turns.
> Generated from `process/rules.json` (edit there, then `npm run rules:build`; lint fails when out of sync). The hooks print the short form of these rules every session.
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
- `scripts/`: tooling (`build-wasm`, `check-boundaries`, `smoke`, `shot`, `vercel-output`, rules/CI helpers).
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

## Token cost (every turn re-reads the whole context, so size x turns is the bill)
- A session starts at ~104k tokens (tools, skills, connectors, before any code); a small fix costs ~25 turns x that. `.claude/settings.json` switches off org plugins this project never uses; do not re-enable them. Connectors (Figma, Gmail, Drive, Spotify, the Vercel MCP) are account-level: turn off the ones you do not need in claude.ai settings, they add ~10k tokens per session.
- One task per session; start a new session instead of continuing a long one. Never run a manager/orchestrator session for hours (a worker restart re-writes all of it to the cache). Hand work over with a short note, not a long thread.
- **Orchestrator cap:** any session that spawns child sessions retires at ~250k context and hands off a short note (an orchestrator once reached 784k tokens, $29.56).
- Read narrowly: `Grep`/`Read` with `offset`+`limit`, never whole big files (big stylesheets, big action files) or whole docs; read a `docs/features/*.md` only for the feature you change (create one per feature that has rules worth keeping). Use a subagent for wide research so its output stays out of the main context.
- Look at each screenshot once, at the size needed (`scripts/shot.mjs --sel` over `--full`); do not re-read the same picture. Never dump `list_events`/log output into the conversation: write it to a file and filter with a script.
- Run the checks once at the end, not after every edit; `npm run smoke` only when the change touches a page flow.

## Screenshots for visual changes
- **Show a screenshot** (same view, viewport/device and data as the owner's; a before/after pair when it was a complaint) when: the owner sent a screenshot or complained about how something looks; OR you chose the visuals yourself (layout, colours, spacing, icons, animation, new UI the owner did not specify); OR the owner asked for a specific design/look and the result is your interpretation of it. **Do not call it done without it.** If the exact view cannot be reproduced (needs data or an account you lack), say so and show the closest view.
- **Skip it** when the request was tiny AND the owner described the exact visual result so precisely that there is little room for interpretation ("make this button red", "change the label to X"), or the change has no visible effect (logic, data, docs, CI). Say in one line that you skipped it and why, so the owner can ask.
- Rule of thumb: "is there a good chance the owner will want to look at this?" If yes, screenshot; if the owner dictated the exact outcome, trust it.
- Token thrift: one command, no hand-written Playwright, one screenshot per view, look at it once, never loop; prefer the element (`--sel`) over the full page; at most one before/after pair; `--phone` when the change matters on mobile. Example: `node scripts/shot.mjs "/" --sel "main" --out <scratchpad>/here.png`. It builds if needed, serves, signs in as the smoke user, opens the path, clicks the given visible texts in order, waits for `--text`, and screenshots the element (`--sel`), the viewport, or `--full`. `--phone` gives 390x844 (default 820x900). Then `SendUserFile` the path (it must be inside your scratchpad dir to open in the app). Take a "before" the same way by running it before your edit.
- Enforced two ways: `.claude/hooks/session-start.sh` prints the rule every session, and `.claude/hooks/prompt-submit.sh` repeats a one-line version on every owner message. Keep both when editing hooks.

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
