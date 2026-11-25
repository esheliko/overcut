# M2 UX audit (round 1)

Build: `m2` at the time of the audit, `npm run build`, driven with Playwright (Chromium) at 390x844 (phone, touch), 820x1180 (tablet, touch) and 1440x900 (desktop), plus 320x640 for overflow. Clips: `crates/media/tests/fixtures/flash_click.mp4` (3 s) and `h264_aac.mp4` (1 s). Screenshots were looked at one by one; they are not committed.

Journeys run: (a) first-time user: import, trim, split, delete, undo, export, reload; (b) creator: two clips, canvas 9:16, reorder, undo/redo; (c) keyboard: Tab order, S, Space, Ctrl+Z, `?`; (d) phone touch only.

**What works well (keep it):** import to a trimmed export is 8 taps and finished in about 10 s; undo/redo and the "Undid delete of 2 clips" toast; a split/delete of linked picture and sound as one; the project survives a reload; no page overflow at 320, 390, 820 or 1440 px; no console errors in any run; the export preset cards and the "ready" screen are clear.

Owners: `[C]` = lane C files (`timeline/`, `layout/`, `commands/`, `store/`, `Timeline.tsx`, `Home.tsx`, `App.tsx`, `styles.css`): routed by the lead. `[QA]` = files this role may fix (export dialog, media bin, preview panel, dialogs, `i18n/en.json`).

## P0 (broken or blocks)

None found in the journeys above. Not verified: touch drag on the timeline (a scripted CDP touch drag changed nothing, but that may be the script, see P1-1).

## P1 (confusing, ugly, or what a real editor is expected to have)

**P1-1 Clips cannot be reordered or moved by dragging** `[C]`. Where: timeline, all sizes. Steps: import two clips, drag the second clip onto the first with the mouse (desktop, 15 steps). Saw: the clip is only selected, nothing moves. Expected: drag to reorder/move, with a drop indicator, the first thing a creator (persona b) tries. Fix: clip move by drag (mouse and touch long-press), snapping, and a keyboard equivalent (move clip left/right). Also the media bin has no drag-to-timeline: import is the only way to add a clip, and it always appends at the end.

**P1-2 Canvas chip contradicts the project** `[C]` (chip) / `[QA]` (canvas dialog). Where: canvas button next to the transport. Steps: import a 320x180 clip, open the chip. Saw: the button's accessible name says "Canvas: 16:9 · 1920 × 1080" while the dialog says "Set by your first clip: 320 × 180 at 30 fps" and Export says 320×180. Expected: one truth. Fix: the chip should show the effective size (or "16:9 · 320×180 from first clip"); the label is also the only place the size is visible.

**P1-3 Canvas dialog wording when clips exist** `[QA]`. Saw: "Your project already has a clip, so the canvas can only be changed to a size you choose (or undo your change)." with "Match first clip" still preselected and Apply looking inert. Expected: plain words ("Pick a shape to change how your video is framed"), Apply disabled until something changes with a visible reason. Fix: `i18n/en.json` + dialog.

**P1-4 Export primary button is below the fold on a phone** `[QA]`. Where: Export dialog at 390x844. Saw: the Export button is cut off at the bottom edge; the user has to scroll the dialog without any hint. Expected: the main action always visible. Fix: sticky footer for the Export button in the dialog (`ExportDialogView.tsx`/CSS in the dialog's own styles).

**P1-5 Contradictory export hint** `[QA]`. Saw, right under "About 113 KB · MP4 (H.264), works in most apps and devices": "Heads up: some phones, TVs and editing apps may not play this file. WebM or a different browser gives the widest support." Expected: one message that matches the format; the warning should only show when it applies, and say what to do. Same text repeats on the "ready" screen.

**P1-6 Preset descriptions are repetitive and unclear** `[QA]`. Saw: YouTube/X/Facebook/Small file all read "Full HD at most, stays 320×180, never enlarged"; "Facebook: Feed and Reels". For a small project all presets are the same file, so the choice looks meaningful but is not. Expected: say what the preset changes for this project ("No change for your 320×180 project") or collapse identical presets.

**P1-7 Disabled Export explains itself only in a tooltip** `[C]`. Where: empty project. Saw: Export is disabled and the reason ("Add a clip to the timeline to export") is only the `title`, invisible on touch. Expected: a visible reason (hint under the preview, or leave it enabled and show the message). The empty timeline also gives no hint ("Import media to start") and the empty preview is the only call to action on phone.

**P1-8 No keyboard shortcut help; `?` does nothing** `[C]`/`[QA]`. The timeline lists its shortcuts only in a hidden screen-reader summary. Expected: a shortcuts sheet (menu item and `?`), key hints in the tooltips (Split is `S`, Undo `Ctrl+Z`). Persona (c) cannot discover S, brackets, comma/period.

**P1-9 Project actions hide behind an unlabelled "…" menu mixed with appearance** `[C]`. The menu holds accent colours, Smooth scrubbing, Projects, New, Open, Save as, Versions, Privacy, About in one flat list. Expected: Save/Open/New grouped apart from preferences; Help/Shortcuts present. Also the menu has no "Rename", the title field has no visible edit affordance on a phone.

**P1-10 Phone: save state not visible** `[C]`. "Saved on this device" is shown on desktop only; on a phone nothing says the project is saved, which a first-time user who closes the tab wants to know. Tablet truncates it to "Saved o…".

## P2 (polish)

- **Desktop/tablet targets under 44 px** `[C]`: desktop toolbar buttons are 36x36 (acceptable for a mouse, but they stay 36 px in the touch tablet too: Export 101x38, Project name 260x36, Search media 634x40, zoom slider 16 px high at 820 px touch). Phone is all >= 44.
- **Timeline toolbar is icon-only on a phone**, two rows of 12 icons with no labels; Split (scissors), Duplicate/Copy are hard to tell apart. Consider labels in the first row or a long-press hint.
- **At 320 px** the project title is cut ("Untitled pro…") and the A1 track is half hidden behind the bottom bar; the timeline gets only about 150 px.
- **Export file name** is "OverCut export 2026-11-25.mp4", not the project name (`[QA]`, `export/deliver.ts`): a user with several projects gets identical names.
- **Export "ready" screen** has no preview of the result, and the heads-up text repeats.
- **Media bin item** shows "On the timeline" but not how many times or a way to add it again; truncated specs ("H.2…").
- **Phone**: clip names on the timeline have a dark label background that hides the thumbnails; the Media sheet slide-up animation was still in progress after 500 ms in a screenshot (fine, noting).
- **Focus order**: Tab visits Theme, Project name, Menu, Media, Search, Import, preview Import, transport, Canvas, then toolbar; the timeline canvas ("Playhead position") is last, after History. Reasonable, but the duplicate Import buttons (bin and preview) both take a stop.

## Missing, what a "real editor" user expects next (steers M2)

1. Drag to move/reorder clips and drag from the media bin onto the timeline (P1-1).
2. More than one video track with overlay (V2), and drag between tracks.
3. Text/titles, and transitions between clips.
4. Audio: volume per clip, mute track, fade in/out.
5. Speed change, volume and crop/zoom for a clip (the timing button exists; check what it does).
6. A shortcuts sheet and a command palette (P1-8).
7. Ripple delete (close the gap) as an explicit choice.
8. Trim by dragging clip edges (only keyboard `[` `]` was found; not verified by drag).
9. Export progress that can run in the background and a "done" notification.
10. Project thumbnails in the project list.

## Top 10 for the lead

1. P1-1 no drag to move/reorder clips, no drag from bin (`Timeline.tsx`, `timeline/`) `[C]`
2. P1-2 canvas chip says 1920×1080 while the project is 320×180 (canvas chip in `layout/` / canvas dialog)
3. P1-4 Export button below the fold on phone (`export/ExportDialogView.tsx`) `[QA]`
4. P1-5 contradictory "works in most apps" / "may not play" hint (`i18n/en.json`) `[QA]`
5. P1-8 no keyboard shortcuts help (`?`) `[C]`
6. P1-7 disabled Export reason only in a tooltip, no empty-timeline hint `[C]`
7. P1-3 canvas dialog wording (`ProjectDialogs.tsx`/`en.json`) `[QA]`
8. P1-6 repetitive preset descriptions (`export/model.ts`, `en.json`) `[QA]`
9. P1-10 save state invisible on phone `[C]`
10. P1-9 "…" menu is one flat list, no Help/Shortcuts `[C]`
