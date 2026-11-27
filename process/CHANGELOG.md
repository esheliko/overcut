# Process changelog

Every change to a rule, instruction, hook, CI or deploy mechanism gets an entry here (newest first) with an expected effect and a review-by date, so a change is judged by what happened, not by feel. Format and workflow: `.claude/skills/process/SKILL.md`. Checked by `tests/unit/process-changelog.test.ts`.

## 2026-11-27 · #201 #199 · Preview URL parsing, service worker freshness
What: `preview.yml` takes the URL from `scripts/vercel-url.mjs` (exact `https://*.vercel.app` match) and the PR comment says a Vercel sign-in is needed; `sw.js` races network vs cached shell (3 s), cache name stamped with the build hash (Vite plugin), old caches deleted on activate; `/assets/*` served `immutable`.
Why: preview job reported "no deployment URL" although Vercel deployed (CLI 66 output); a slow network blocked app start and stale caches could linger.
Expected effect: `preview` job green on labelled PRs with a working link; installed app opens within ~3 s on a bad connection; repeat visits reuse hashed assets without revalidation.
Review by: 2026-12-11
Status: pending

## 2026-11-25 · #166 · Previews only for PRs labelled `preview`
What: `preview.yml` triggers on `pull_request` (labeled/synchronize/opened/reopened) and runs only with the `preview` label; no preview for branch pushes. A Vercel refusal now fails the job and comments on the PR instead of ending green with an empty URL. `deploy-web` unchanged.
Why: owner approved on #166 after previews on every push hit Vercel's free daily deployment limit.
Expected effect: far fewer Vercel deployments per day; no `api-deployments-free-per-day` refusal blocks a labelled preview silently.
Review by: 2026-12-09
Status: pending

## 2026-11-25 · #175 · E2 undo/redo gate in verify
What: `ci.yml` `verify` runs `npm run test:e2 --if-present` after the build.
Why: the 10k-sequence undo/redo gate (plan 4b.4) must run in CI; the script exists only on `m2` until it merges.
Expected effect: no change on main now; the gate (~45 s) turns on automatically when m2 lands.
Review by: 2026-12-09
Status: pending

## 2026-11-24 · #84 · main frozen to M1 work
What: new standing rule `m1-freeze` (main takes only M1 work until the owner lifts the freeze; M2 PRs wait on their branches); step 5 of `branch-pr` says so.
Why: owner said no M2 work merges into main until M1 is finished.
Expected effect: no M2 PR merges until the owner lifts the freeze; the M2 landing branch stays the owner's decision (#89).
Review by: 2026-12-08
Status: pending

## 2026-11-24 · #91 · Cut Actions minutes
What: `ci.yml` runs `perf` and `fuzz` only on pushes to `main` (not on every PR); `android-emulator.yml` runs weekly (Monday) instead of nightly. `deploy-web` already runs only on pushes to `main` and is unchanged; `verify` and the deploy on main are unchanged.
Why: a minute quota stopped every runner on 2026-11-24 and nothing could merge or deploy.
Expected effect: fewer billed minutes per PR (no perf or fuzz run on PRs); `verify` and `deploy-web` behave as before.
Review by: 2026-12-08
Status: pending

## 2026-11-24 · #52 · desktop-native job is not silenced
What: `desktop-check.yml` `desktop-native` drops `continue-on-error`. It stays a separate job outside `verify`, so a red run does not block merges, but it is no longer silently green.
Why: `continue-on-error` hid failures of the libav crate build; the lead ruled it out for CI jobs.
Expected effect: a broken native-media build shows as a red `desktop-native` job on PRs that touch those paths; `verify` unchanged. Release bundling (part 2) is still open on the issue.
Review by: 2026-12-08
Status: pending

## 2026-11-24 · #93 · Remove the deploy board
What: deleted the `deploy-board` workflow, its two scripts and unit test, the "deploy board" section of `DEPLOYING.md`, and the mentions in `CLAUDE.md`, `ci.yml` and `process-changelog.mjs`. The `deploy-web` step names are no longer load-bearing.
Why: owner asked to remove the board and every trace of it.
Expected effect: no Deploy board workflow runs, no board issue is written; `grep -ri "deploy.board"` finds only this entry; `verify` stays green.
Review by: 2026-12-08
Status: pending

## 2026-11-23 · #55 · CSP as a response header
What: `vercel.json` sends `Content-Security-Policy` (the `apps/web/csp.ts` value plus `frame-ancestors 'none'`) on every path; a unit test fails if the two drift apart.
Why: a header also covers frame-ancestors and the service worker script, which the meta tag cannot.
Expected effect: the production response carries the CSP header; the app still loads with no console CSP violations.
Review by: 2026-12-07
Status: pending

## 2026-11-23 · #52 · Native-media CI job and manual desktop preview build
What: `desktop-check.yml` gains a non-blocking `desktop-native` job (libav crate fmt, clippy, tests, shell check); new manual `desktop-preview.yml` builds unsigned Windows, macOS and Linux installers as run artifacts. The release-time libav build pipeline stays open on the issue.
Why: nothing built or tested the libav crate in CI, and the owner wants installers to try without tags or coding tools.
Expected effect: `desktop-native` goes green on main; one manual run yields downloadable installers for all platforms.
Review by: 2026-12-07
Status: pending

## 2026-11-22 · #27 · Orchestrators cap workers at 3; paused workers push WIP
What: new standing rule `orchestration` (max 3 parallel workers, stop spawning at `allowed_warning`, push WIP branch before a pause, one worker per slice).
Why: seven parallel workers used the 5-hour quota in 73 minutes and five lost unpushed work.
Expected effect: a 5-hour quota lasts 2 hours or more of orchestrated work; no unpushed WIP at a pause.
Review by: 2026-12-06
Status: pending

## 2026-11-22 · #28 · Vercel preview deployment per branch
What: new workflow `.github/workflows/preview.yml`: every push to a non-`main` branch (not docs-only) builds and deploys a Vercel preview, aliases it `<repo>-<branch>.vercel.app`, comments the URL on the PR.
Why: the owner wants to view each branch's work, including WIP without a PR.
Expected effect: every non-docs branch push has a preview URL within about 10 minutes; production deploys unchanged.
Review by: 2026-12-06
Status: pending

## 2026-11-22 · #14 · Software GPU adapter in `verify`
What: `ci.yml` installs mesa Vulkan/GL drivers before lint and tests.
Why: the render golden-frame tests skipped silently without an adapter.
Expected effect: the golden tests run (not skip) in CI; `verify` gets about 20 s longer.
Review by: 2026-12-06
Status: pending

## 2026-11-22 · #17 · Android emulator proxy job (non-blocking)
What: new workflow `.github/workflows/android-emulator.yml` (nightly and manual) boots an A15-class emulator and runs `scripts/emulator-probe.mjs`; results uploaded as an "emulator-proxy" artifact. Untested until its first run.
Why: owner chose an emulator over buying the low-end Android reference device (ADR 0013).
Expected effect: a nightly JSON of capabilities, overflow and load timing on a 4 GB Android profile; never gates `verify`.
Review by: 2026-12-06
Status: pending

## 2026-11-22 · — · Project created from project-kit
What: the work model (standing rules, hooks, CI `verify`, Deploy Manager, automation board, process skill) copied from the kit.
Why: same development cycle and instructions as the other projects.
Expected effect: none (housekeeping)
Review by: 2026-11-22
Status: n/a

## 2026-11-23 · owner (direct edit) · Token diet after two usage limits
What: orchestration rule tightened (max 3 workers counting resumed, no spawn/resume at allowed_warning, handoff at ~200k context or ~$2.50, no waking a session idle over 1 hour above ~150k). Branch+PR rule: workers spawned by an orchestrator stop after merging (no post-merge `ci-status --wait`, no branch-delete retries); owner-driven sessions keep the watch; orchestrator checks main once per batch. Reply-tag rule and CLAUDE.md Token cost and Screenshots sections shortened (CLAUDE.md 18.8 KB to ~16 KB; always-loaded rule budget 6500 to 5000 tokens).
Why: 2026-11-22/23 review of the oversight session: ~270M cache-read tokens for ~0.9M written, 13 workers in 35 minutes, 6 died at the limit, 150-270k tokens re-written on every wake after a long idle. Auto-merge was considered and is NOT possible (private repo on the free plan: no branch protection, `allow_auto_merge` false).
Expected effect: fewer simultaneous sessions, no marathon contexts, ~3k fewer tokens re-read per turn per session, no wasted post-merge turns. The 104k start-up cost is mostly account-level (skills, connectors), not repo files.
Review by: 2026-12-07
Status: pending

## 2026-11-23 · owner (direct edit) · Rate gate keys on the 5-hour window; active orchestrators retire at ~600k
What: orchestration rule: pause only when the 5-hour limit is not allowed, any status is `rejected`, or weekly use is about 80% or more; a weekly `allowed_warning` alone no longer blocks starts or resumes. Orchestrator retire threshold raised from ~250k to ~600k (while kept active); the 1-hour cache rule (hand off instead of waking a big session after a long idle) stays.
Why: the manager read the weekly `allowed_warning` (owner: 34% used) as a reason to pause all work until the weekly reset and to retire itself at 270k. An active session keeps a warm cache, so early retirement saves little; the 5-hour window is the limit that was actually hit.
Also (owner, same day): ALL work stops at 90% of the 5-hour limit; every running worker pushes WIP and stops until the window resets. Sessions only see a status (no percentage), so `five_hour` not `allowed` stands in for 90%.
Expected effect: no needless pauses; fewer manager restarts; no workers dying unsaved at the 5-hour wall. Worker cap of 3 and worker handoff at ~200k unchanged.
Review by: 2026-12-07
Status: pending
