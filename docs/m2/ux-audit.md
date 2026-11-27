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

## Round 2: editing core (m2 at 7fa42a0)

Driven at 1440x900 with the keyboard, against a real export checked with `ffprobe`. Correction to P1-1: the media bin does have an Add (+) button and its cards are draggable; what is missing is dragging clips on the timeline itself.

**Verified fine**
- Keyboard precision: Right/Left step one frame, Shift+Right one second, `,` `.` nudge a frame, Home/End jump; the timecode matches every step (00:00:01:00 after Shift+Right, 01:02 after one more Shift+Right from 00:02, and so on).
- Split at the playhead (`S`), select clip with Enter, Delete: linked picture and sound go together, the gap closes (3 s becomes 2 s). `]` trims the end to the playhead and Ctrl+Z restores it.
- Undo and redo: 6x Ctrl+Z goes back to an empty project, 6x Ctrl+Shift+Z returns to the same edit.
- Playback: Space plays and pauses; the timecode advances (about 1.2 s of play moved the playhead 1 s 3 frames; start-up latency, not measured further).
- Export file: 320x180, H.264 30 fps, video 2.000 s, Opus audio 2.020 s, container 2.020 s. Matches the 2 s edit; the audio is 20 ms longer than the picture (P2-a below).
- Reload straight after a split: the split was kept ("4 clips"), with a "Recovered unsaved changes / Undo recovery" toast.

**P1**
- **Offline media card was unreadable** `[QA]`, fixed in this PR. After a reload in a browser without file handles the bin card showed the message one word per line next to the Tags and "Choose file" buttons. The Choose file button now sits under the message. Screenshots at phone and desktop widths.
- **After a reload the picture is gone until every file is chosen again** (browsers without file handles, for example Firefox and Safari). By design (the message explains it), but for a creator who closes the tab it means re-picking every clip; consider a single "Choose all files" action (the code has `relinkMany`) offered in the toast. `[C]`

**P2**
- a. Exported audio is 20 ms longer than the picture (Opus pre-roll/padding); harmless alone, watch it when A/V sync work lands. `[A]`
- b. The recovery toast on a phone wraps its close button onto a second row and covers the preview. `[C]`

## Round 3: drag, shortcuts dialog, grouped menu (m2 at c5d6ce0)

Driven as a human with mouse (1440x900), touch emulation (820x1180 and 390x844) and keyboard. No P0.

**Works**
- Mouse drag of a clip past its neighbour reorders it (picture and sound together), the preview shows the new first frame, the status line says "Moved 2 clips", and one Ctrl+Z puts it back.
- Touch: press and hold about 0.7 s on an unselected clip, then drag, reorders it; the result matched the mouse.
- `?` opens "Keyboard shortcuts" with the key set picker and a Change button per row; the dialog fits at 390 px with no sideways scroll. The menu is grouped (Project, View, Help) and now holds the save and ready status on a phone, which closes P1-9 and P1-10.

**P2**
- The "…" menu is taller than a 844 px phone: "About OverCut" is below the fold; the menu scrolls, but nothing hints that it does. `[C]`
- The shortcuts dialog has a tall empty gap under the intro text on desktop and phone, and on a phone (no keyboard) its use is limited. `[C]`
- While a drag is in progress the dragged clip is drawn faded with its name nearly invisible; keep the name readable. `[C]`
- Tablet (820 px, touch): the saved status is still cut to "Saved o…" and the media list is clipped by the preview below it (it scrolls). `[C]`

## Round 4: keyboard-only and accessible names (m2 at c5d6ce0)

Every visible button, input, select, menu item and radio in the main view, menu, shortcuts, export and canvas dialogs has an accessible name (script check: none unnamed). Each dialog opens with focus on its heading and a `aria-labelledby` title; Esc closes it.

**P1**
- **Focus was lost when a dialog closed** `[QA]`, fixed in this PR. After Esc on the Export or Canvas dialog focus went to the page root instead of the button that opened it, so a keyboard or screen-reader user restarted from the top of the page. `a11y/restoreFocus.ts` puts focus back on the opener (Export, Canvas, project dialogs). Checked: Esc on Export returns to "Export", on Canvas to the canvas button.
- **The "…" menu does not follow the menu pattern** `[C]` (`App.tsx`). It has `role="menu"` but focus stays on the Menu button when it opens, and Arrow Down does nothing; only Tab walks the items (and the accent swatches). Expected: focus moves to the first item, Arrow Up/Down, Home/End, Esc returns to the button (Esc already does).

**P2**
- The history and clip timing dialogs (`timeline/EditDialogs.tsx`) and the shortcuts dialog (`commands/`) should use the same restore-focus helper if they do not already. `[C]`
- Dialogs wrap Tab through the page root before coming back (native dialog behaviour in this browser); acceptable, noted.
- Drag alternatives: with a clip selected `,` and `.` nudge it and announce "Can't move further" at a neighbour. There is no keyboard way to jump a clip over its neighbour (the mouse reorder); consider Alt+Arrow. `[C]`

## Round 5: trim tools, cross-track, one-row toolbar, transform inspector (m2 at ee27485)

Driven as a human with Playwright at 1440x900 (mouse and keyboard) and 390x844 (touch emulation, CDP touch drag for the handles). Clips: three generated 8 s H.264+AAC files with a burnt-in clock (so a slip or trim is visible in the preview and the export), `still_red.png`. Trim tests used clips with 1 s of spare footage on each side, made with `[` `]` and Close gap. The PiP project was exported to MP4 and checked with ffprobe and extracted frames. #152, #154, #155 and #153 were all merged by the end of the run; #158 (inspector polish) was still open.

**Works (keep it)**
- **Trim tools.** Ripple (end, in), Roll (cut, left and right), Slip (body, `Ctrl+,`) and Slide (body) give the result an editor expects: drag distance in whole frames, clamped at the spare footage (a 3 s drag with 1 s of handle stops at exactly 1 s), the linked sound follows in every case, no overlaps and no sound/picture drift in 15 variants, and exactly ONE `Ctrl+Z` restores the previous state each time. Slip was checked on the burnt-in clock: dragging right by 0.5 s moved the source in-point from 1.000 to 0.500. Alt+drag does the same without the tool (body = slip, shared edge = roll).
- **Ripple delete** (`Shift+Del`) on one clip and on a shift-click multi-selection, **Close gap** (`Ctrl+Del`): correct, undo is one step, and a second Close gap says "There is no gap before the selection".
- **Cross-track.** Dragging a picture to V2 leaves its sound on A1 and keeps them in time sync (also with a horizontal move), `Alt+Up/Down` moves it back and forth, undo is one step each.
- **PiP export.** V2 still, scale 40, position X 30 / Y -30, rotation 15: the exported frame at 3 s matches the preview (small rotated red rectangle top right) and the layer is gone after its end. File: 320x180, 30 fps, 390 frames, 13.00 s; audio is Opus in MP4 (13.02 s, the known 20 ms of #138).
- **Toolbar (#155).** One row at 1440 and 390: Undo, Redo, Split, Delete, Ripple delete, "Select ▾" tool picker (checkmark, key hint per tool), "More ▾" (Clip, Tracks, View groups, each item with its key and a reason when disabled), Fit. Keys V B N Y U switch the tool and announce it ("Ripple tool"); Esc returns to Select. No overflow at 390; the phone picker is a bottom sheet with 44 px rows.
- **Inspector (#153).** Position, scale, rotation, opacity, crop, Fit/Fill/Stretch, flips, Reset; each committed field is one undo step. On-canvas handles: body drag, corner scale, rotate; each drag is ONE undo step (checked by undoing once and reading the fields). Touch drag of the corner handle works at 390 (scale 100 -> 56.6 %), and the Edit bottom sheet shows the same values.

Owners: `[C]` = lane C files (`timeline/`, `layout/`, `commands/`, `store/`, `Timeline.tsx`, `App.tsx`, `styles.css`, `inspector/`, `preview/TransformHandles.tsx`). `[QA]` = files this role may fix. All findings below are `[C]`; routed to the lead, nothing was fixed in this PR.

### P1
- **P1-1 The Home key leaves the preview on a stale frame** `[C]` (`commands/` "step to start", `Timeline.tsx`). Steps: three clips, timeline focused, click the ruler at 20 s (preview shows clip C), press `Home`. Saw: the timecode goes to 00:00:00:00 but the preview keeps showing the 20 s frame, even after 3 s; the transport "skip to start" button, `End`, arrows and ruler clicks all update it. Expected: Home shows frame 0. Fix: send Home through the same seek that updates the preview.
- **P1-2 A video with sound dropped or pasted over existing time lands at the END of the project, not at the pointer** `[C]` (`timeline/arrange.ts` `placeAt`, `clipboard.ts`). Steps: add V2, drag a bin card (picture + sound) onto V2 at 2 s, or copy a linked clip and paste with the playhead at 2 s. Saw: the picture goes to 16 s on V2 (paste: 24 s on V1), a second sound is appended on A1, status "Added to the timeline". A still image (no sound) lands at the pointer on V2, so the cause is the sound clashing on A1. Expected: the picture lands where it was dropped on V2 and its sound goes to a free audio lane (auto A2) or is left out with a message; at minimum say why it moved. This blocks the main PiP route (a second video over the first) from the bin and from copy/paste.
- **P1-3 Roll, Slip and Slide do nothing, silently, on a clip that uses its whole source** `[C]` (`timeline/ripple.ts`, `interact.ts`). Steps: import a clip, pick Slip (Y), drag its body. Saw: nothing changes, the status line stays empty. Every fresh import has no spare footage, so a new user's first try of these tools looks broken (the tools work once a clip is trimmed). Expected: a one-line message ("No spare footage to slip: trim the clip first") or the handle-less clips greyed in the picker.

### P2
- Ripple tool on a shared edge: pressing 3 px on the right clip's side of the cut still trims the LEFT clip's end (A grew 1 s and pushed everything). Decide the side by the pointer. `[C]`
- Alt+drag on a shared edge rolls (as documented); there is no way to ripple a shared edge without switching to the tool; the picker label does not say so. `[C]`
- A cross-track drag that also moves in time, where the sound would collide on A1, silently keeps the old time (B dragged to V2 and +2 s stayed at 8 s). The ghost should show where it will land. `[C]`
- Status says "Moved 2 clips" when only the picture changed lane (the pair is counted). `[C]`
- Bin drop: the clip starts about 0.5-0.9 s before the pointer (pointer at 1 s -> clip at 0.53; at 2 s -> 1.07). Scripted drag, so it may be a grab offset; check with a real mouse. `[C]`
- Rotation has no snap to 0/15/45/90 (got 23.82); no hint that Shift snaps. `[C]` `preview/TransformHandles.tsx`
- Phone: the corner handles of a full-frame layer sit on the screen edge (centre x = 378 of 390), so half of the 44 px target is off screen. Inset them when the frame touches the viewport. `[C]`
- Inspector: at 1440x900 Crop bottom, Fit/Fill/Stretch, Flip and Reset are below the fold with no scroll hint; the phone Edit sheet cuts "Flip horizontal / vertical / Reset" at the bottom. The rotated layer's outline is drawn outside the preview panel (#158 fixes this and the "Animati…" tab). `[C]`
- Toolbar: the picker button reads just "Select ▾" (no icon or "Tool"); its accessible name "Edit tool: Select. Change tool" and the bottom-nav "Edit" are easy to confuse; the phone sheet shows keyboard hints (V B N Y U) that touch users cannot use. `[C]`
- Export hint still contradicts itself: "MP4 (H.264), works in most apps and devices" directly above "This browser can't make the most compatible version, so some phones, TVs and editing apps may not play this file" (round 1, P1-5). The MP4 carries Opus audio. `[QA]`, file `export/` dialog + `i18n/en.json` (not touched here, the wording needs the lead's call on what to say).
- After the start trim `[`, the status line once read "Trimmed end of B.mp4" (seen once, not reproduced): check the live-region text for start trims. `[C]`

### Project library (#157, m2 at 32af437), 1440 and 390
Two projects, per-card "…" menu (Rename, Duplicate, Export…, Archive, Delete), Archive with an "Archived 'Beta'. Undo" toast and a Projects (n) / Archived (n) filter: all worked, no sideways scroll, the phone "…" is 44 px (36 px with a mouse), no console errors. P2: a project with one imported video says "2 clips" (picture and sound are counted separately); the card thumbnail is still a generic rectangle (round 1 wish: real project thumbnails). `[C]`

## Round 6: palette, track headers, round-5 fixes, keyframes end to end (m2 at 4683413)

Driven as a human with Playwright against a local `npm run build` + `vite preview` (the deployed preview is frozen by the Vercel quota), at 1440x900 (mouse and keyboard), 390x844 and 820x1180 (touch emulation). Clips: two generated 8 s H.264+AAC files with a burnt-in clock (`testsrc2`, `testsrc`). The keyframed project was exported to MP4 and checked with ffprobe and frame grabs.

**Keyframes, end to end (#168): the export moves exactly as the preview does.** Position X keyed 0 % at 0 s and 40 % at 2 s, Opacity 100 % to 30 %, linear. Preview frames (ruler clicks at 0, 1, 2, 3 s) next to export frames (`ffmpeg -ss`) match: the clock burnt into the clip shows the same source time and the picture sits in the same place. Measured on the export: the left black edge is 10.0 % of the width at 0.5 s, 20 % at 1 s, 30 % at 1.5 s, 40 % at 2 s and still 40 % at 5 s (the last key holds); the red bar falls from (239,20,1) to (178,13,1) to (146,9,0) at 0.5, 1.5 and 5 s. The inspector value between keys reads 19.33 % / 66.17 % at 0:29, which is the linear value. File: h264 320x180, 30 fps, 240 frames, 8.000 s; audio Opus 8.02 s (the known 20 ms of #138). Diamonds toggle (aria-label flips to "Remove keyframe for Position X"), prev/next key jump the playhead to the neighbour key and the fields update, the easing picker is per key, and "Crop & flip" is a collapsible under the five rows. On the phone Edit sheet and the 820 px tablet the diamonds are 44 px.

**Works (keep it)**
- **Command palette.** Ctrl+K on the timeline, the top-bar search button (desktop), and the "…" menu row "Commands" (phone) all open it with the input focused; typing narrows the list; Enter runs; the next open lists the last two commands first; shortcuts are shown on the right of each row; no match says "No command matches that"; at 390 px it fits and the input and rows are 44 px.
- **Track headers.** Video tracks show only Lock and Hide (desktop switches and phone menu); audio tracks show Mute, Solo, Lock, Hide. The phone chevron opens the track menu (V1: Lock, Hide, Rename, Move up/down, Add video/audio track, Remove track).
- **Round-5 P1 fixes.** Home with the playhead at 3 s now shows frame 0 (preview pixel difference to frame 0 is 0.6, to the 3 s frame 18.6). A video+sound clip dragged from the bin to V2 at the 2 s tick lands at exactly 2.00 s on V2 with its sound on a new A2 at 2.00 s; one Ctrl+Z removes both. Copy/paste with V2 active and the playhead at 2 s does the same ("Pasted 2 clips at 00:02:00"). Slip on a fresh import says "No extra footage to slip: trim the clip first". Ripple on the right clip's side of a shared cut trims the RIGHT clip (12 frames for a 60 px drag, the left clip untouched).
- **Core journey.** Import two clips, split, delete, undo, export: correct at 1440 and 390 (status lines "Split 2 clips at ...", "Deleted 2 clips", "Undid delete of 2 clips"; the export of the undone state is 16.02 s, h264 + Opus). No sideways scroll at 390.

### P1
- **P1-1 The Animation, Audio, Speed and Adjust tabs of the Details panel say "Nothing selected" while a clip is selected** `[C]` (`App.tsx` `DETAIL_TABS`, line 121: only `video` renders the inspector, the other four always render the empty state). Steps: import a clip, click it (the handles show on the preview), click "Animation". Saw: "Nothing selected. Select a clip on the timeline..." beside a selected clip. The keyframe controls are in the Video tab, so a user looking for animation under "Animation" concludes the feature is missing. Expected: either render the inspector (or its keyframe rows) under Animation, or say "Coming soon" / hide the tabs that have no content yet. #158 mentions the cut-off "Animati…" label but not this.

### P2
- **Esc does not close a track menu** `[C]` (`timeline/TrackMenu.tsx`). Open the V1 header menu (click or tap the chevron), press Escape: the menu stays (count 1); an outside click closes it. On the phone a keyboard-less user never sees it, but keyboard and switch users do; and a script that presses Esc then taps lands on "Rename…" (it happened in this run). Same menu pattern gap as the "…" menu of round 4.
- **Paste lands at the end when the copy's own lane is selected** `[C]` (`timeline/clipboard.ts`). With the V1 clip selected and the playhead at 2 s, Ctrl+V puts the copy at 8 s on V1 (status "Pasted 2 clips at 00:08:00": it does say where). An empty V2 exists, but is not tried. Works as expected once V2 is the active lane. Consider falling back to a free lane at the playhead, as the bin drop now does.
- **The "No extra footage to slip" toast was still on screen about 9 s later**, after other actions, over the lowest track. `[C]`
- **Shortcut hints on a touch phone.** The "…" menu row reads "Commands  Ctrl+K" and the palette rows show "Ctrl+Z" etc. on a 390 px phone with no keyboard; the tool picker sheet shows V B N Y U. Hide the key column when the pointer is coarse and no keyboard is attached. `[C]`
- **The palette lists commands that cannot run** (Undo, Redo, Copy, Cut, Paste with nothing selected) in the same style as the others, first in the default list. Grey them with the reason (as the More menu does) or sort runnable commands first. `[C]` (`commands/`)
- **Phone "…" menu order**: the theme choices (System, Dark, Light, High contrast) and the Ready / Saved lines come before Commands and Project, so the first thing a user sees in the menu is the theme. `[C]`
- **Export wording still contradicts itself** (round 1 P1-5, round 5): "About 301 KB · MP4 (H.264), works in most apps and devices" sits directly above "This browser can't add AAC sound to the MP4, so the sound is Opus and some phones, TVs and editing apps may not play it". Needs the lead's wording call. `[QA]` (`export/`, `i18n/en.json`)
- **`/?sample` project**: its two media entries show red "File not found on this device" cards and "Choose all 2 missing files..." in the bin, because the sample has no files. Fine for the smoke tests, but anyone who opens `?sample` to look around sees an error state; a note "sample, no media" would avoid it. `[C]`
- Not verified (script-driven, may be a harness effect): after `canvas.focus()` via script, Shift+Right did not move the playhead; a ruler click did.

Test notes for the next round: the browser's `showSaveFilePicker` blocks a headless Save; set `window.showSaveFilePicker = undefined` in an init script to get the anchor download. Clicking the canvas at x = 7 + gutter + offset selects a clip; the gutter is 148 px at 1440.

## Round 7: final M2 sweep (m2 at 66cbf66, after #182)

Driven as a first-time creator and as a pro editor with Playwright against a local `npm run build` + `vite preview` at 1440x900 (mouse and keyboard), 820x1180 and 390x844 (touch). Media: three generated clips (A: 6 s test pattern with a burn-in frame counter and a 440 Hz tone, B: 6 s colour bars and 880 Hz, C: a 4 s red 320x180 clip and 220 Hz) plus `flash_click.mp4`. The repo's own `npm run smoke` on this build: 169 passed, 41 skipped, 0 failed. Every screenshot was looked at.

**The one realistic project** (V3 empty, V2 overlay C, V1 A then B, A1 + A2 sounds): A and B on V1; C from the bin onto a new V2 at 2 s (its sound landed on a new A2); C as picture-in-picture (inspector: scale 40 %, X 35 %, Y -30 %; then the on-canvas handles: a corner handle scaled it, a body drag moved it to X 26.18 / Y -22.16); Position X keyed 35 % at 2 s and -35 % at 5 s, Opacity keyed 100 % and 30 %; B at 2x (Speed tab, "2×" badge on the clip and its sound, the project shortened from 12 s to 9 s); markers at 1 s and 7 s, in 1 s, out 8 s, Alt+P played the range from 1 s; Alt+drag ripple (C's end -15 frames), roll (the cut at 3 s +15 frames), Slide tool (A slid 9 frames, the neighbour followed); multi-clip drag of A and B from V1 to V3 (one drag, both ghosts on V3, "Moved 4 clips", ONE Undo put both back); edge auto-scroll (clip held at the right edge at 4 zoom steps: the view scrolled and the clip landed at 7.13 s); Ctrl+K palette (filtering "split" -> "Split at playhead  S"), `?` shortcuts dialog (presets, Change buttons); project library (rename, duplicate, export `.overcut` 1454 bytes, archive with Undo toast, import the `.overcut` back); reload (the edit comes back, the files must be chosen again: round 1, by design).

### Export of that project, checked with ffprobe and frame grabs (it matches the preview)
- **Duration**: video 9.000 s, 270 frames at 30 fps, 640x360 H.264; audio Opus 48 kHz stereo 9.02 s. The project says 0:09. 16 s to export.
- **Overlay position**: at 2.2 s the PiP covers x 386..640, y 0..144 (centre 513, 72): the keyframed X (30.3 %) and Y -30 % of the preview, scale 40 % = 256 px wide. At 3.5 s it is centred (X 0 %), half see-through (opacity ~65 %); at 5.0 s it hangs off the left edge (X -35 %, only x 0..224 visible) at 30 % opacity; gone after 6 s.
- **Keyframed motion**: the three frames sit exactly where the preview put them (the burn-in counter on A reads 66, 105, 150 at 2.2, 3.5, 5.0 s).
- **Speed**: B (6 s) occupies 6.0..9.0 s; the tone in 6.3..8.7 s is 880.0 Hz (**pitch kept**, not 1760); level steps at exactly 6.0 s and falls to silence at 9.0 s.
- **A/V sync at 2x** (`flash_click.mp4`, flash at frame 30, click at 1.000 s): 2x export is 1.52 s; the flash lands at 0.500 s (frame 15), the click at 0.509 s. Sync holds (9 ms is under a frame).

### Core journey regression (1440): passed
Import, split (status "Split 2 clips at 00:02:00"), delete ("Deleted 2 clips"), undo, redo, undo, wait for "Saved on this device", reload: the 6-clip timeline came back; the picture needs its file again (known).

### Timeline benchmark (`tests/perf/timeline-bench.mjs`, 1000 clips x 20 tracks, this container)
| Case | pan | zoom | pan+zoom | drag one / all 1000 (input-to-paint p95) |
|---|---|---|---|---|
| desktop 1280x800 | 60.0 fps | 60.0 | 59.8 | 2.9 ms / 1.9 ms |
| desktop, 4x CPU throttle | 57.1 (p95 33 ms) | 60.0 | 58.1 | 19.0 ms / 10.7 ms |
| phone 390x844 dpr3, 4x throttle | 59.5 | 60.0 | 60.0 | 13.2 ms / 9.9 ms |

Against `docs/PERFORMANCE.md` (Timeline UI, pan/zoom 1000 clips x 20 tracks: floor 30 fps, target 60 fps): every case clears the floor by ~2x; desktop and phone are at the 60 target; the only value under 58 is desktop-throttled pan (57.1), which is the container's noise, not a regression (no phase drops a frame budget twice in a row).

### P0
None.

### P1
- **P1-1 A cross-track drop that also moves in time silently keeps the old time** `[C]` (`timeline/interact.ts` lane-change plan, `arrange.ts`). Steps: V1 has A, B, C (C at 12 s with its sound on A1); More > Add video track; drag C from 13 s on V1 up to V2 at the 3 s mark (target start 2 s). Saw: the ghost sits on V2 at 12 s the whole drag, release gives "Moved 2 clips" and C is on V2 at 12 s (sound would collide with A's on A1 at 2 s). Expected: either the ghost shows where it will land and the status says why the time was kept ("kept at 12 s: the sound would overlap"), or the sound moves to a free audio track as the bin drop does (that path works: C from the bin to V2 at 2 s put its sound on a new A2). Round 6 listed this as a P2; it is the first thing a user who drags an overlay tries, so it is a P1 now. Fix: in the lane-change plan, when the linked sound blocks the new time, try a free same-kind track for the sound or refuse the lane change with a message; draw the ghost at the planned time.
- **P1-2 Markers and in/out points are not snap targets for clip moves** `[C]` (`timeline/arrange.ts` `targets()`: only 0, the playhead and clip edges; `docs/features/snapping.md` and M2-009 list markers). Steps: marker at 1 s, playhead far away; drag C so its start is 5 px (0.04 s) from the marker. Saw: it lands at 1.03 s. Control: the same drag 4 px from a clip edge snaps to exactly 6.00 s. Expected: it snaps to 1.00 s (and the guide line shows). Fix: pass the sequence markers and in/out into `targets()` (the engine's `snap_json` already knows them).

### P2
- **A reload loses the media for the web build** (round 1 P1, still open, by design): "Your browser does not keep imported files after a reload. Choose it again to use it." The "Choose all N missing files" row makes it one step, which is good; a creator who loses an hour of edits to a closed tab still sees black.
- **Status says "Moved 4 clips" when two pictures changed lane** (the two sounds stayed on A1 at the same time). Count only what moved. `[C]`
- **After a speed change the live status still reads the old span**: "B.mp4, V1, 0:06.00 to 0:12.00" while the clip is now 6.0..9.0 s. Re-announce the selection after the op. `[C]`
- **Alt+drag slip on the left half of a split clip did nothing and said nothing** (the left half had footage after its end); the next Ctrl+Z reverted the split instead. Not retried with the Slip tool (Y); check that a no-op slip says "No extra footage" and that the slip is announced when it works. Roll and the "No extra footage to roll/slip" messages are clear. `[C]`
- **Alt+Up on the top video track says "No free track there for this clip"** and does not offer to add one; a first-time user has to find More > Add video track. Offer "Add a video track and move there" or create it. `[C]`
- **A .overcut import of the project that is already in the library makes a second card with the same name** ("Round 7 project copy" twice, same time, same size): no way to tell them apart. Name it "... (imported)" or ask. Project cards have a blank placeholder thumbnail. `[C]`
- **The export file name ignores the project name** ("OverCut export 2026-11-25.mp4" for "Round 7 project copy"). The audio track is 20 ms longer than the picture (9.02 vs 9.00 s, 1.52 vs 1.50 s): harmless, but players show a different length. `[C]`
- **"Recovered unsaved changes / Undo recovery" stays on screen** over the lowest tracks (A1/A2) for the whole session after a reload (about 40 s of scripted use) and hides the clip labels there; auto-dismiss after ~8 s like the other toasts, or move it above the timeline. `[C]`
- **Phone (390x844)**: no horizontal scroll anywhere (empty, imported, Edit sheet, Speed tab, More sheet, app menu, palette, Export: scrollWidth = 390). The transform corner handles now sit inside the screen. The app menu still lists "Commands  Ctrl+K" on a touch phone and is cut off at the bottom ("Smooth scrubbing"); the preview leaves ~100 px of empty grey above the picture on this portrait layout while the timeline gets only ~236 px, so a 5-track project scrolls. `[C]`
- **Tablet (820x1180)**: no overflow; the timeline gets ~25 % of the height under a tall media panel, so a project with five tracks needs vertical scrolling to see them all. `[C]`

### Works (keep it)
Keyframes (diamond, "Between keyframes", prev/next, timeline diamonds) and the on-canvas handles follow the animated values; the PiP is identical in preview and export; the Speed tab (presets, field, "Move later clips to follow", "Keep pitch" note, badge on both rows); markers, I/O, Alt+P play range; clip-edge snapping; Alt+drag ripple and roll with clear refusals; Slide tool; multi-clip cross-track drag is one undo step; edge auto-scroll; palette and shortcuts dialog; project library (rename, duplicate, archive + Undo, export, import); export dialog wording is now consistent ("Plays in browsers, VLC and most phones. Some older apps may play it without sound").

### Ship readiness (M2 as it stands at 66cbf66)
**Ready to ship M2.** No P0. The core journey, every M2 feature and the export (duration, overlay position, keyframed motion, 2x clip length, pitch, A/V sync) check out against the preview, the smoke suite is green and the 1000-clip x 20-track timeline holds 57..60 fps desktop, throttled and phone. Two P1 fixes are recommended before or right after the merge, both small: P1-1 (cross-track drop that also moves in time must say what it did) and P1-2 (markers as snap targets, as the docs promise). Everything else is polish.

Test notes for the next round: a persistent profile (`launchPersistentContext`) lets one script build on the last one's project; set `window.showSaveFilePicker`, `showOpenFilePicker` and `showDirectoryPicker` to `undefined` in an init script so saves become downloads and "Choose files" becomes a `filechooser` event; at 1440x900 a 9 s project fits at about 131 px per second starting at x = 155.

## Round 8 (verification): m2 after #194 and #195, plus the closeout fixes

Driven like a person with Playwright against a local `npm run build` + `vite preview` (:4173) at 1440x900 (mouse, keyboard) and 390x844 (touch). Screenshots were looked at. The full `npm run smoke` is CI's job: locally it was too slow to finish (about 20 of ~210 steps in 7 minutes, all green), so the flows below were run as targeted specs (17 passed, 9 skipped by design, 0 failed: lanes, markers, persistence, project-library, activation, zoom-overview, drag-move) plus hand-driven scripts.

**Verdict: no P0, no P1.**

| Flow | 1440 | 390 |
|---|---|---|
| `/?sample=2h` fit, overview bar | Fit shows the whole 2 h; the bar hides when everything fits and appears after zooming in; dragging the window pans, dragging its edge zooms | The overview strip shows under the lanes with its window; fit is the toolbar button |
| Shift+Z (zoom to selection) | Selected clip fills the width (0.40 to 410 px/s) | n/a (no keyboard) |
| Pinch | n/a | Two fingers apart: 0.033 to 0.15 px/s, ruler labels follow (1:00, 1:10, 1:20); two-finger drag pans |
| Cross-track drop that also moves in time | Lands where the ghost showed; the sound that would clash goes to a new A2; one undo (lanes spec) | Same spec on phone viewport: skipped (needs a mouse); the two-picture lane change passes |
| Snapping | A clip dragged so its start was 3 px before a marker landed at exactly 2.00 s (marker and in/out snapping also covered by `snapMove` unit tests) | Touch drag shares the code path (unit) |
| Recovery toast | "Recovered unsaved changes" shows once, "Undo recovery" goes back, the next open is quiet | same |
| `.overcut` import name | Exported "Alpha.overcut", imported back as "Alpha (2)": the two cards can be told apart | same |
| Full journey | Import, split at 1 s, delete the first part, export (MP4, "0:02"), save: passes | passes |
| Phone app menu ("…") | n/a | Scrolls to its last item, About OverCut (its bottom edge 823 of 844 px; also fine at 600 px height); not cut off |

Closeout fixes in this round (all three P2s from round 7): the live status now reads the new span after a speed change ("Speed 2×: B.mp4, V1, 0:06.00 to 0:09.00"); an Alt+drag slip in the direction where a split half has no footage left now says "No more footage that way: drag the other way to slip this clip" (the other direction already worked, the drag simply clamped to 0 in silence); the phone menu needed no change.

Left as is: reading `data-pps` right after clicking Fit can still show the old value for a moment (the zoom applies on the next frame): a test-timing detail, not something a person sees.

## Round 9: ui-ux-pro-max pass verification (m2 at fa3b54a)

Driven like a demanding user with Playwright against a local `npm run build` + `vite preview` of m2 after #200, #202, #203, #204 and #205: 1440x900 (mouse, keyboard), 820x1180, 390x844, 844x390 and 320x640 (touch), dark and light, one run with reduced motion. Journey at every size: import three clips (3 s, 1 s, 1 s), overlay with More > "Add as overlay on a new track", split, speed 2x, Opacity keyframe, marker, right-click menu (desktop), Ctrl+wheel zoom, export (MP4 saved), Menu > Projects, reopen. No page overflow at any size, no touch target under 44 px on phone, no page error. Perf numbers are container numbers, 4x = CPU throttle (phone proxy), same scripts as the audit.

The full `npm run smoke` (244 steps, 3 workers) was started and stopped at 57 of 244 after 12 minutes on this container (too slow to finish; all of those passed except one that my own first polish edit broke, see the Projects header item below, reverted). Targeted run after the fixes: button-chrome, layout-ux, zoom-overview, inspector, speed, empty-hint, project-library, export-dialog and clip-menu, desktop and phone: 31 passed, 7 skipped by design, 0 failed. No flaky spec seen.

**Verdict: no P0. One P1 found and fixed in this PR (320x640 transport row under the timeline). One P1 from the perf audit is not fixed (edit latency, P-4).**

### P1 status of the three audit reports
| Finding | Status | Evidence |
|---|---|---|
| V-01 font shipped | Fixed | Inter woff2 in `dist/assets`, timeline text matches the UI |
| V-02 control borders 3:1 | Fixed | `--line-strong` 0.36 (dark) / 0.46 (light) alpha, M/S/lock boxes and Select/More visible in both themes |
| V-06 light scrim | Fixed | Export dialog in light dims to grey, the app is no longer washed out |
| V-12 selected clip | Fixed | Selected clip has a full outline and end handles, readable on light |
| V-13 audio identity | Fixed | Audio lanes are green with their own waveform, video blue-grey |
| V-19 overview strip | Partly, fixed here | Hidden when empty (was); still shown at 390 for a 5 s project that fits; now hidden when the clips fit in the viewport |
| V-31 project posters | Fixed | Poster of the first frame, clip count and length on each card, "Open" badge on the current one |
| I-01 disabled Export | Fixed | `.primary:disabled` / `.export-go:disabled` dimmed |
| I-05 touch tabs | Fixed | Tabs 44 px on coarse pointers (no small target reported at 390/820/320) |
| I-06 stuck drop outline | Fixed | `onDropCapture` clears it; not seen on the sample drag |
| L-01 phone landscape | Fixed | Preview 340x255 at 844x390 (was 34x19), tools rail, timeline beside it |
| L-02 phone portrait dead band | Fixed | Stage is as tall as the picture; timeline about 330 px at 390x844. **At 320x640 the new layout pushed the transport under the timeline: fixed here (P1 below)** |
| L-03 phone Edit sheet | Fixed | Peek detent with a mini transport; the keyframe helper "Move the playhead onto this clip" + "Go to clip" shows on desktop and phone |
| T-01 add a used clip again | Fixed | More > "Add media at playhead" / "Add as overlay on a new track" (palette too); the overlay lands on a new V2 and its sound on A2 in one step |
| L-06 auto fit after import | Fixed | Three clips fill the width (0:00 to 0:05), no manual zoom |
| I-03 shortcuts in tooltips | Fixed | Tooltips carry Home / comma / period / Space etc. |
| T-04 wheel zoom | Fixed | Six notches of Ctrl+wheel: a few steps of zoom, not a jump to the limit |
| I-02 touch spacing | Fixed | Toolbar groups spaced, Play 56 px |
| T-03 clip context menu | Fixed | Right-click and Shift+F10: Split at playhead, Duplicate, Delete, Ripple delete, Unlink, Speed 0.5x to 2x |
| P-01 / P-02 fullscreen, loop, handles | Fixed | Fullscreen and loop buttons in the transport bar; handles shown only when a clip is selected |
| **P-1 export dialog** | **Fixed** | Open-to-usable 320 ms at 1x, 380 ms at 4x (was 562 / 1256 ms), CLS 0 (was 0.103), no Loading pill, fixed-size body |
| **P-2 zoom re-renders the Editor** | **Fixed** | `zoomStore` + `useSyncExternalStore`: the Editor root no longer commits on a wheel tick. Main-thread busy during 30 wheel ticks at 4x: 54 % (script 13 %), 1 long task |
| **P-3 playhead re-renders everything** | **Partly** | Playback at 4x: 28 % busy (was 44 %), script 6 %, no long tasks. Still about 27 React commits per second during playback (Timecode, Timeline shell); the cost is small but not zero |
| **P-4 edit latency vs project size** | **Not fixed** | `?sample=2h` (2300 clips) split median 32 ms at 1x, 95 ms at 4x (undo 32 / 80 ms); budget 8 ms. `?sample` (small) 28 / 79 ms. Before #205: 42-53 ms at 1x, 118-161 ms at 4x, so a modest gain, nowhere near the budget. The patches of #205 do not yet avoid the full project JSON round trip on the UI thread (see open items) |

Timeline bench (`tests/perf/timeline-bench.mjs`, 1000 clips x 20 tracks): desktop 60 fps pan, zoom and pan+zoom (p95 16.7 ms), JS draw 1.0-1.3 ms; 4x desktop 46.6 / 49.3 / 46.9 fps, p95 33 ms; phone 4x 52.6 / 56.3 / 53.1 fps; drag input-to-paint p95 3.8 ms (single) and 1.8 ms (1000 selected), 26 ms at 4x. Same as before the pass within run-to-run noise (the 4x desktop runs vary by 10 fps between runs on this container); the new timeline look cost nothing measurable.

### P1 (fixed in this PR)
- **320x640: the transport row (Play, prev, next) is covered by the timeline toolbar.** The phone-portrait grid gave the timeline `minmax(260px, 1fr)` and the picture 38 dvh, which at 640 px high adds up to more than the screen. Now, on short phones (height up to 700 px), the picture is capped at 30 dvh and the timeline minimum is 190 px. Seen before and after in `scratchpad/r9/shots/p320` and `a320`.

### P2 (fixed in this PR)
- **Details panel gaps.** `.panel-body` is a grid that stretches its rows to the panel height: with nothing selected the hint sat at the top and the project info at the bottom with a big hole between; the Speed tab rows were 120 px tall; the Video tab rows spread out when the keyframe helper was shown. Now `.insp-body { align-content: start }`: everything packs at the top with the normal 8 px gap.
- **Phone landscape: the loop button and the timecode chip straddled the picture's bottom edge.** Moved up so they sit on the picture (844x390).
- **Overview strip on a project that nearly fits.** The 96 px end padding counted as content, so a 5 s project at 390 px kept a full-width teal bar. It now hides when the clips fit in the viewport (end padding ignored).

### P2 (open, not fixed here)
- **Projects header has both a "New project" button and a New project tile.** Left as is: `button-chrome.spec.ts` asserts the header button is accent-filled ("main actions are accent-filled"), so demoting it is a design call plus a test change, not a nit. Suggest: keep the tile as the accent action and hide the header button at >= 720 px, in one PR that updates that spec and the smoke steps that click `projects-new`.
- **Console: `wgpu: Validation Error ... copy_external_image_to_texture ... Copy of X 0..160 would end up overrunning the bounds of the Source texture`** repeats several times on desktop in the 3-clip journey (clips of 160x120 and 320x180 on a 160x120 canvas). Nothing visible breaks (preview and export are right) but it is a real engine/preview error: a texture upload uses the wrong source size when a clip's size differs from the previous one. Needs its own issue (preview worker, `crates/render`).
- **P-4 above**: engine edit calls still return/serialize the whole project; target is a patch applied on both sides without `JSON.parse` of 2300 clips.
- **Toast and the last lane**: the "Nothing to split here" toast still lays over the bottom track lane (K-03 partly); on desktop it also stays about 4 s.
- **Playhead still causes about 27 React commits per second** in playback (P-3 remainder).
- **Overview strip at 28 px visible on phone after zoom** looks heavy (full teal block when the window covers most of the range); a lighter fill for the bar outside the window would read better.

### Works (keep it)
- The new timeline look: lane identity colours, selection outline, track header tinting, thumbnails paced after import (no jank), the context menu and "Add as overlay" (one step from the More menu to a new V2 with its sound on A2).
- Export dialog: opens at final size, presets in a grid, Export button pinned at the bottom on phone, light and dark; "Your video is ready" with Save / Export again / Close.
- Projects home: posters, "Open" badge, clip count and length; one project round-trips (Menu > Projects > Open) with all 10 clips and the overlay.
- Phone: 390x844 shows a 270 px preview, a full transport row (shape chip, prev/next, Play 56 px, full screen) and a roomy timeline; Edit sheet peeks with a mini transport.
- Reduced motion: no animations in the journey (the `prefers-reduced-motion` block applies to everything), and nothing depends on motion to show state.
- Light theme: contrast of control borders, selection, disabled menu rows (with the reason shown under each) all legible.

### Ship readiness
Ready to ship once this PR is in (the 320 px fix is the only blocker found). Not ready to claim: the edit-latency budget (P-4) and the wgpu console error; both are listed as open items.

## Round 10 perf: edit latency (#208) and P-3

Script: `tests/perf/edit-latency.mjs` (Playwright, `?sample=2h` = 2300 clips, 1280x800, median of N split / undo / redo, CDP CPU throttle 1x and 4x; `EDIT_PROFILE=1` prints the main-thread self time). Two numbers per edit: **commit** = key press until the new project is in the DOM (engine apply + patch + store + React), **key->paint** = until the end of the next animation frame (includes the canvas redraw and the display's frame wait). Container numbers.

| | commit 1x | key->paint 1x | commit 4x | key->paint 4x |
|---|---|---|---|---|
| before (m2 at 8855660), split | 7.6 ms | 17.3 ms | 38.0 ms | 75.6 ms |
| after, split | 3.1 ms | 15.8 ms | 12.9 ms | 49.5 ms |
| after, undo / redo | | 13.3 / 13.6 ms | | 48.6 / 47.1 ms |

Where it went (4x profile, self time per edit): the overview bar rebuilt its clip bitmap with 2300 `fillRect` and read `clientWidth` after each React commit (forced layout); the `Splitter` read `getBoundingClientRect` in render, so every app render forced a layout; the sr-only clip list ran 200 `describeClip` + i18n calls inside the edit's commit; the preview project JSON was stringified and posted before the frame painted.

Fixes (behaviour unchanged):
- Overview: the clip layer is built from a per-pixel-column coverage mask and drawn as runs (a few hundred rects, not 2300); the bar's CSS size comes from its ResizeObserver, not from a read per paint.
- `Splitter`: the workspace height is state set from effects and its observer, never read in render.
- Clip list (`TimelineCanvas`): rendered from `useDeferredValue` of the scene and selection, so it follows the edit at low priority; same content, still complete (capped as before).
- Preview sync (`PreviewPanel`): the flush runs in a task after the frame that shows the edit has painted.
- **P-3:** `Timecode` is no longer a store subscription that renders per tick: it writes its text node from `store.subscribe`. React commits during playback of `?sample`: 29.3 per second -> 0.3 per second (counted with a devtools-hook commit counter over 3 s; only `Timecode` re-rendered before).

Verdict: apply + patch is within the 8 ms budget (3.1 ms at 1x, 12.9 ms at 4x which is the phone proxy); key->paint is at the aim at 1x (13-16 ms against < 16) and at 4x (47-50 ms against < 50), both close to the line, so a noisy run can land a little over. Not done: the preview Worker still receives the whole project JSON (built from cached per-track strings, now after the paint, about 5 ms per edit at 4x on the main thread) and the UI still parses the engine's project on load only. A patch binding (`apply_patch` in wasm + Tauri + both clients) would remove that; it needs its own PR and is not on the key->paint path any more.

## Round 10: final audit (m2 at 63ff521)

Who: W5. Method: `npm run build` + `vite preview`, Playwright driving Chromium at 1440x900 (mouse + keyboard), 820x1180 (touch), 390x844 (touch), 844x390 landscape and 320x640, dark and light. Scripted per size: empty app, import of 3 files (video+sound, a second video, a still), selection, Details/Edit sheet, More menu, command palette (Ctrl+K), shortcuts (`?`), Export dialog, Projects home; plus the creator path at desktop and phone (import, **Add as overlay on a new track**, Speed tab, marker, palette). Every step checks horizontal overflow, console errors/warnings and (touch sizes) targets under 44 px; screenshots were read at each size. Journeys that already have a smoke spec with real assertions (trim modes, snapping, opacity keyframes with easing, loop, remap, .overcut round-trip, archive/restore) were not re-driven by hand; they ran green in CI and are marked "covered by smoke" below. Final before/after images: `docs/features/img/m2-r10/audit-*`.

### Findings

| # | Pri | Where | Steps | Saw | Expected | Status |
|---|---|---|---|---|---|---|
| 1 | P1 | Editor -> Projects home | Split with the playhead on a clip edge ("Nothing to split here..."), then Menu > Projects | The toast stayed on the Projects list | Messages about the editor end with the editor | Fixed (#216): `goHome` clears the toast; smoke in `first-time.spec.ts` |
| 2 | P1 | Details "Clips", project card | Import 3 clips (picture+sound each) | "6 clips" | "3 clips": a linked picture+sound pair is one clip, detached audio counts on its own | Fixed (#216): `countClips`, unit test; card, Details and `clipCount` agree |
| 3 | P1 | Details > Speed (desktop, any clip) | Select a clip, open the Speed tab | The "Keep pitch..." note and the status message were drawn at the bottom of the window, outside the panel, half clipped | Both inside the panel under "Move later clips to follow" | Fixed: `.insp-note` was defined twice (a floating field note won); Speed now uses `.insp-help`. Smoke asserts the note sits under the checkbox and inside the viewport |
| 4 | P1 | Timeline toolbar at 820 px (tablet) | Select a clip that has linked sound | The pill "1 clip + linked audio" lay on top of the "More" button | No overlap | Fixed: tool groups never shrink, the zoom slider and the pill give way (pill ellipsizes, title carries the full text). Smoke checks the three boxes do not overlap at 820 |
| 5 | P2 | Timeline: Add as overlay on a new track | More > Add as overlay on a new track | New V2/A2 clips added but nothing selected: Details said "Select one video clip", no on-canvas handles | The new overlay is selected so it can be sized/placed at once (the PiP journey) | Fixed: the overlay (picture + linked sound) is selected after the add. Smoke |
| 6 | P2 | Timeline zoom slider on touch (tablet) | Measure targets | 140x24 px | 44 px high on `pointer: coarse` | Fixed |
| 7 | P2 | `#tl-summary` (screen-reader summary of the canvas) | Import one video | "2 clips" (picture and sound listed as two) | Same wording as the rest of the app | Fixed in the follow-up PR (lead's call): `#tl-summary` counts clips like Details and the project card; 49 smoke assertions on the old numbers were stale and updated (none loosened) |
| 8 | P2 | Phone/landscape | Overlay controls (loop, timecode) sit over the picture's bottom corners and can hide a corner handle of an overlay | Handle and timecode chip overlap on a 390 px phone | Handles stay reachable | Fixed in the follow-up PR (lead's call): on the phone shapes the chips fade out in 120 ms while the handles are up and return when they go; smoke at 390x844; `audit-chips-before/after.png` |

Checked and fine (no finding): no console errors or warnings on any size (the wgpu texture error of round 9 is gone with #211), no page overflow at 320 / 390 / 844 / 820 / 1440 in dark or light, Export dialog at 320 px (pinned button), Projects home at 320 px in light, More sheet on phone with reasons under disabled rows, Details sheet peek/half on phone, the command palette and `?` dialog at every size, selection handles on the preview on phone and desktop. Covered by smoke (not re-driven by hand): ripple/roll/slip/slide, snapping, opacity keyframes + easing, in/out loop, shortcut remap, .overcut export/import, archive/restore, rename/duplicate.

### Not verified here
- A real long (minutes) project on a phone-class CPU; the edit-latency numbers are in the perf section above.
- Real-device touch (Safari/iOS gestures, pinch zoom): Chromium touch emulation only.
- Full keyboard-only and touch-only runs of journeys (a) and (b) were done through the scripted steps above and the existing keyboard/touch smoke specs, not as one hand-driven pass.

### Ship readiness
Ready to ship once the two round-10 PRs are in: the four P1 findings are fixed with tests and no P0 was found. Remaining items are P2 (7 wording of the screen-reader summary, 8 the overlay chip vs. handle on a 390 px phone) and the open perf notes of the earlier rounds; none blocks the M2 journeys.
