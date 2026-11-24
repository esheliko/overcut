# Activation test (M1-044)

The M1 exit criterion: a **first-time user imports a clip, trims it and exports it in under 90 s**, without help (`docs/ROADMAP.md`, `docs/PERFORMANCE.md`). M2 raises it to the PRODUCT.md activation goal (import, trim, caption, export in under 3 minutes, 8 of 10 succeed).

## Who
- 5 people who have **never seen OverCut**. Mix: at least 2 on a phone, at least 2 on a laptop, at least 1 who does not edit video normally.
- Not developers of the project, and not briefed on the UI.

## Setup (before the tester arrives)
1. Open the live app (production URL) in a fresh browser profile or private window, so there is no recovered project.
2. Put one ordinary phone video (10-60 s, 1080p, recorded on a phone) on the device, where the tester can find it (Downloads / Photos / Desktop).
3. Have a stopwatch and this sheet. Do not show the app before you start the clock.

## Script (read exactly this, then stay quiet)
> "This is a video editor. Please put the video called *<name>* into it, cut off the first few seconds, and save the result to this device. Think aloud if you like. I can't help you, but you can stop whenever you want."

- **Start** the clock when the tester first touches the device.
- **Stop** when the exported file is saved (the Save/Share step finishes), or at **5 minutes** (counts as a failure).
- Do not answer questions. If asked, say "do what you would do at home".

## Record per tester
| # | Device / browser | Time (s) | Success (y/n) | Where they hesitated > 5 s | What they said | Errors seen |
|---|---|---|---|---|---|---|
| 1 | | | | | | |
| 2 | | | | | | |
| 3 | | | | | | |
| 4 | | | | | | |
| 5 | | | | | | |

"Trim" counts if the exported file is shorter than the source at the start (a split and delete of the first part, or a trim of the clip's start, both count).

## Pass bar
- **M1 passes** when at least 4 of 5 succeed and the **median time is under 90 s**.
- Every hesitation over 5 s becomes an issue (label `activation`), even when the tester succeeded.

## After the test
Paste the table into a new issue titled `Activation test <date>` (or send it to the work manager session), so the results and the issues land in one place and `docs/M1-STATUS.md` can be updated.

## Automated proxy (`tests/smoke/activation.spec.ts`)
CI runs the same journey with a script at 1280x800 and at 390x844 touch, using only visible labelled controls (import, ruler click, Split, select + Delete on the picture and on the sound, Export, Export, Save), on the 3 s `flash_click.mp4` fixture. It asserts the file is saved, that it is 2 s long (so the cut start left no empty stretch), at most 12 clicks/taps, and under 60 s scripted. It does not replace the 5 real testers (a script never hesitates); it catches a journey that grew steps, dead ends or slowness.

| Date | Viewport | Clicks / taps | Scripted time |
|---|---|---|---|
| 2026-11-24 | desktop | 10 | 3.4 s |
| 2026-11-24 | phone | 11 | 3.8 s |

The 10 are: Import media, click the ruler, Split, select the first picture part, Delete, select the first sound part, Delete, Export (open), Export (go), Save (phone adds the Media tab). Fewer is better: linking audio and video (TL-05, M2) would remove 2 of them.
