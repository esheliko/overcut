# Shipping OverCut

There is no server to run. Three things ship:

| What | How | When |
|---|---|---|
| **Web app / PWA** (every device with a browser) | CI job `deploy-web` uploads the finished static build to Vercel (`vercel deploy --prebuilt`) | automatically after `verify` is green on `main`, only if the commit changed app code (not docs/process) |
| **Desktop apps** (Windows, macOS, Linux) | `.github/workflows/release.yml` builds with Tauri and attaches installers to a draft GitHub Release | when a version tag `vX.Y.Z` is pushed (owner or release session) |
| **Mobile apps** (iOS, Android) | same workflow once `tauri ios init` / `tauri android init` are committed and signing secrets exist | later milestone; until then the PWA is the mobile app |

Vercel cannot build Rust, so CI builds the engine and web app, then uploads only the result (`scripts/vercel-output.mjs` packs it in the Build Output format and keeps the cross-origin-isolation headers that threaded WebAssembly needs).

**Previews (label only)**: `.github/workflows/preview.yml` deploys a Vercel preview only for pull requests that carry the `preview` label (owner decision, issue #166); plain branch pushes get none. A Claude session applies the label when a PR is important to preview, the owner when they want one, and it goes on major integration PRs (e.g. `m2` -> `main`). Built in CI like production (`vercel deploy --prebuilt`, no `--prod`), aliased to `https://<repo>-<branch-slug>.vercel.app` (falls back to the plain preview URL if the alias fails) and commented on the PR; it re-deploys on each push while the label stays. If Vercel refuses (e.g. `api-deployments-free-per-day`) the job goes red and the PR gets a comment saying the preview was refused and why. It skips lint and tests; only `main` after a green `verify` reaches production. Preview URLs may sit behind Vercel Deployment Protection (sign in to view).

## Repo secrets (set by the project creator)
- `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`: web deploy. Without `VERCEL_TOKEN` the deploy job idles and says so.
- Later, for signed native builds: Apple (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`), Windows code signing, Android keystore. Until then builds are unsigned and the OS asks the user to confirm the first launch. Never put these anywhere but repo secrets.

## Releasing the native apps
1. `main` is green and the web app is live. 2. Bump `version` in `Cargo.toml` (workspace), `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/tauri.conf.json`. 3. `git tag vX.Y.Z && git push origin vX.Y.Z`. 4. Check the draft release created by the workflow, then publish it.

## Local desktop builds need system libraries
- Linux: `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf build-essential`
- macOS: Xcode command line tools. Windows: Microsoft C++ Build Tools and WebView2 (preinstalled on Windows 11).
- Regenerate icons from a 1024 px square image: `npx tauri icon <image.png> --output apps/desktop/src-tauri/icons` (the committed icons are placeholders).

## For sessions
Nobody pushes to `main`: every change is a branch + pull request, `verify` must be green, then the PR is squash-merged (CLAUDE.md standing rule). Sessions do not deploy, tag or release unless the owner asks.

## Operating the system
- **A red `main`:** `node scripts/ci-status.mjs --sha <sha>` names failing tests and exactly one Owner session; the Owner fixes it (CLAUDE.md rule 7). Re-run CI once before blaming anyone.
- **Process changes:** requests are issues labelled `process-request`; a process session (`/process`) batches them into one PR; each change is logged in `process/CHANGELOG.md` with an expected effect and review date.
- **Sessions stopped by the usage limit:** in a process session, `list_sessions` (`mine: true`) written to a file, `node scripts/resume-limited.mjs <file>`, check each candidate's last result, message it to continue.
