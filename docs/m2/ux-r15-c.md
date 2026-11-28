# UX round 15, lane C: Details, export, projects home, audio import, polish

Evidence IDs point into the round-15 journey simulation (`desk.md`, `phone.md`, `first.md`). Screenshots: `SCRATCH/r15/c/` (`before-*` / `after-*`, 1440x900 at 2x).

## Fixed
| ID | Before | After |
|---|---|---|
| FIRST-1, DESK-2, PHONE-2 (engine side) | MP3 and WAV refused ("not a video or audio format") | WAV (PCM 8/16/24/32, float) and MP3 import as audio clips with a waveform; `crates/media/src/demux/{wav,mp3}.rs`, 7 Rust tests + 2 real ffmpeg fixtures, `pcmPlanes` unit tests, smoke import of both. ADR 0004 amended. |
| FIRST-5, DESK-10 | Details at 1440x900 showed 4 rows of Transform; Opacity header + row duplicated; ~110 px banner; footer floated over rows; sticky header sliver; native easing select | One Transform section with Position X/Y, Scale, Rotation and Opacity (rows ~46 px, was ~72 px), plus Crop & flip, Speed and Reset all visible at 1440x900; one-line chip for "playhead is off this clip"; Reset is the last row (not sticky), section headers not sticky; one group diamond keys position+scale+rotation (unit-tested `groupKeyOps`); easing is a button with a curve glyph and a 5-curve menu |
| FIRST-19 | "Select one video clip..." with no clips | "Add a clip to the timeline, then select it..." |
| DESK-11 | estimate 2.1x too high, shown as "About"; ETA jumped 7, 9, 12, 8 min | estimate says "Up to about" (it is the bitrate ceiling: the encoder undershoots simple footage); time left = rate over the last 10 s |
| FIRST-14 | file `OverCut export <date>`; black done thumbnail; "Also gives the same file as ..." | file named after the project (`Summer trip.mp4`); done card shows a frame of the finished file; tile line reads "Same file as YouTube, Facebook" |
| FIRST-15 | dialog height 735 / 530 / 680 | one min height for all states (`min(86dvh, 640px)`) |
| PHONE-7 | no Wake Lock | Wake Lock while exporting (re-requested on return), note "Keep this screen open until it finishes", and a louder note if the page was in the background |
| PHONE-18 | "Keep current project", "Keep browsing", Delete used the safe style | "Keep project", "Hide", "Delete" in the danger style |
| FIRST-7, PHONE-15 | Projects only via "..." | `Projects` button (chevron + word, chevron only on phones) in the editor top bar; new projects auto-named "Project 28 Nov", "... 2"; empty project card says "Empty"; floating "New project" at the bottom on phones |
| FIRST-9, DESK-18 | curved "smile" under the project name | straight 1 px line (gradient, no radius), asserted in smoke |
| FIRST-13 | accent swatches only in "..." | in the theme popover too |
| FIRST-16 | long spec-like intro; grey filled input | 3 shorter sentences; outlined input |
| FIRST-17 | accent text 4.37:1 in light + orange | `--accent-text` token (darker mix in light); used for the bin "On the timeline" label |

## Not done, and why
- PHONE-1 (AAC): the engine already tries AAC first (`mp4a.40.2` via `isConfigSupported`, ADR 0004 amendment 2026-11-25) and falls back to Opus with the "limited compatibility" note; the audit sandbox has no AAC encoder, so the Opus note is what it saw. Nothing to change without a real device; unchanged copy is pinned by a unit test.
- Gap warning in export: lane A's helper is not on `origin/m2` yet; skipped.
- One-click save (save picker on start): left out, needs a user-gesture design for the done state; "Save" stays one click on the done card.
- FIRST-18 (heading alignment 71 vs 75 px) and PHONE-19 (tool menu vocabulary): in files owned by other lanes (layout, tool menus).
- MP3 gapless trim (LAME encoder delay) is not applied: a few ms of lead-in (documented in media-io.md). Desktop libav PCM/MP3 mapping is written but not compiled here (needs libav).

## Cost
No per-frame work added. Wake Lock and the ETA window run in the export dialog only. Inspector rows render the same number of nodes; the easing popover mounts only while open. MP3 probing reads 256 KiB windows of frame headers (a 10 MB file is about 40 reads) and never payloads; WAV probing is O(packets) arithmetic.

## For other lanes
- Formats that import now: MP4, MOV, WebM, **MP3, WAV (PCM)**, M4A/AAC, JPG, PNG, WebP. Lane B can show the MP3/WAV chips.
- `--accent-text` token exists (tokens.css); `.bin-on-timeline` in `media/media.css` already uses it (one-line change in lane B's file).
- App.tsx edits are small: `ExportControl projectName`, the `topbar-projects` button, `homeNew` auto-name, `locale` from `useI18n`.
