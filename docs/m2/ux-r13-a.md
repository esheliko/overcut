# UX round 13, lane a: missing media frame, plain open errors, name field edge, Projects rows

Issues: #247, #243, #242, #238. Screenshots: `docs/features/img/m2-r13/a/` (`before-*` / `after-*`; phone 390x844 and desktop 1440x900, scale 1).

| # | Finding | Fix | Evidence |
|---|---|---|---|
| 247 | A clip whose file is not on this device left the preview plain black; the only words were in a note above the tool bar. | `MissingFrame` in `PreviewPanel.tsx`: while the playhead is on such a clip the picture says "Media missing", the file name and a "Choose file" button (same relink flow as the Media panel; 44 px). Hidden while playing. Missing set comes from `App.tsx` (`missingMedia`). | `*-phone-missing.png`, `*-desktop-missing.png`; smoke `phone-r12.spec.ts` "a project whose media is missing…" |
| 243 | Toast ended with library text ("invalid Zip archive: Could not find EOCD"). | `openError.ts` classifies the failure; the toast now reads "That file is not an OverCut project, or it is damaged. Choose a .overcut file saved from OverCut." (a newer-version project keeps its own sentence). The raw text sits behind a "Show details" disclosure with a "Copy details" button. | `*-failure-details.png`; unit `tests/unit/open-error.test.ts`; smoke `ux-r13-a.spec.ts` |
| 242 | Project name had no boundary at rest (0:1 against the bar). | 1 px bottom edge in `--line-strong` at rest (>= 3:1 in dark, light and high contrast); rest of the bar unchanged. | `*-topbar.png`; smoke `ux-r13-a.spec.ts` (computed border) |
| 238 | Compact Projects rows on phones. | Already done by PR #245 (`home-library.css`, <= 520 px): no code change. Measured: at 390x844 and 320x640 five projects fit (rows 76 px high, "..." menu 44x44, no horizontal scroll); on 1440 wide the poster cards are unchanged. | `*-projects-390.png`, `*-projects-320.png`, `*-projects-1440.png`; smoke `phone-r12.spec.ts` Projects list |

Two existing assertions matched the old copy ("could not be opened") in `phone-r12.spec.ts` and `project-lifecycle.spec.ts`; they now match the new sentence (the copy changed on purpose, the checks are as strict).

## Not verified
- Screen-reader reading of the new frame and the disclosure (axe spec is green in all themes; no real reader run).
- "Choose file" on the picture was checked for layout and test ids; the full relink round trip is covered by existing specs, not re-run on the new button.
- The Edit-sheet-covers-lanes note in #247 (ergonomics lane) is not part of this PR.
