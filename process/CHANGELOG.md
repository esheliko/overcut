# Process changelog

Every change to a rule, instruction, hook, CI or deploy mechanism gets an entry here (newest first) with an expected effect and a review-by date, so a change is judged by what happened, not by feel. Format and workflow: `.claude/skills/process/SKILL.md`. Checked by `tests/unit/process-changelog.test.ts`.

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
Expected effect: no needless pauses; fewer manager restarts. Worker cap of 3 and worker handoff at ~200k unchanged.
Review by: 2026-12-07
Status: pending
