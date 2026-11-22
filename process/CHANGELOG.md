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
