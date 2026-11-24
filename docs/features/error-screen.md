# Feature: the error screen and "Copy diagnostics report" (XT-06)

Code: `apps/web/src/errorScreen/` (`crash.ts` pure state and report, `ErrorScreen.tsx` screen and boundary), wired in `main.tsx`, `persistence.tsx` (save state), `App.tsx` (engine failure). Tests: `tests/unit/crash-report.test.ts`, `tests/smoke/open-with.spec.ts` (forced error). The opt-in *remote* crash report stays XT-06b (M2); this is the local fallback that design asks for.

## Behaviour
- A top-level React boundary shows one calm screen instead of a blank page for: a render error, an uncaught exception (`window` `error`), and `reportFatal(source, error)` (used when the engine cannot start; the hook for any Worker whose loss makes the editor unusable). An unhandled promise rejection is **not** fatal (a failed import is not a crash); it is kept in a short list that goes into the report.
- The screen has the headline, **Reload**, **Copy diagnostics report**, and one sentence about the person's work. No stack trace on screen; the stack is in the copied report.
- **"Your work is saved" is said only when autosave confirms it.** `persistence.tsx` tells `errorScreen/crash.ts` the journal state (`saved` = every edit acknowledged as durable, `saving` = edits in flight, `error` = storage not working). Mapping: saved -> "Your work is saved on this device"; saving -> the last few edits may be lost; error -> changes since the last file save may be lost; no session ever opened -> no edits were made.
- The report is one JSON line: `overcut_crash_report`, time, source, error (name, message, stack), save state, up to 10 earlier non-fatal problems, and the `/diagnostics` device report (`diagnostics/report.ts` `buildReport`, no test results). No project data, file names or media. Copying uses the clipboard; when blocked the text is shown selected for manual copy. **Nothing is sent anywhere**; no network call, no new allow-list host.

## Test hook
`/?e2e&force-error=<ms>` makes the app throw while rendering after <ms> (smoke tests and screenshots). Needs `?e2e`; without it the parameter does nothing.

## Known gaps
- The device report on this screen has no GPU/codec capabilities (asking the engine that just failed is unreliable); `/diagnostics` has them.
- A Worker dying silently (preview, export) is not yet routed to `reportFatal`: the preview and export surfaces show their own errors; the persistence worker already turns into the "saving is not working" note.
