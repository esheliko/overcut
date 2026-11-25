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
