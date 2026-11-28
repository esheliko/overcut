# M2 preview feedback messenger: handoff log

Polish session: session_01VHHsocsw4fMVJuPbMMFNVt ("Overcut M2 UI/UX polish"), branch claude/kind-ptolemy-nvaqz6.
Preview: https://overcut-m2.vercel.app/

## Labels (owner's rule)
- dev: guidance from the owner. Replies to dev go under "To dev", with the tag line first.
- customer: complaints from the owner's review. Replies to customer are plain text, short, no jargon.
- Never mix the two in one block.

## Devices seen
- Windows laptop, Chrome (batches 1-11).
- Android phone, Chrome (batches 12-17).

## Batches sent to the polish session
1. Refresh: media shows "file not found" and needs relinking. Chrome asks for permission on reload; after granting it, files link again. Asked if per-refresh prompt is expected and whether copy should say "needs permission".
2. Timeline goes black while dragging the preview/timeline divider; flickers on slow drag. Code pointers: layout/Splitter.tsx, PreviewPanel.tsx ~288-291.
3. Linked clip cannot be moved to another track (product decision pending). Add video track is hidden under More menu and track right-click menu. Too many timeline controls. Re-link not offered after Unlink.
4. Undo toast after a move: should a move show an undo toast? (product choice)
5. Trim: linked audio jumps only on release; playhead pulse after trim (cause not found). Asked if partner should preview during drag.
6. Zoom "-" looks hovered when "+" is hovered (shared label, .icon-btn:hover). Needs browser check.
7. App menu and timeline More menu both crowded (two separate complaints). Correction sent: both stand.
8. Details panel looks inert with nothing selected. Asked for "Select a clip to change it" copy.
9. Trim leaves a gap by design; Ripple tool hard to find. Customer strongly wants ripple by default.
10. Media section: too many controls, third clip hidden below fold, no thumbnails (maybe from offline files), names cut off.
   Follow-up: filters open fill the whole section.
11. Theme button: icon-only, no label. Asked for clearer icon or label.
12. Android: toasts' X buttons on separate line, giant. Missing-file wording: on Android the file input has no handle, so files must be chosen again after reload (docs wording).
13. Magnet (snap) toggle hidden on phones (styles.css ~844). Asked if snapping should be reachable on phone.
14. Phone: drag on a selected clip moves it instead of scrolling. Asked: long press or clear selection on scroll?
15. Phone timeline too short to see three tracks; no resize on phone (Splitter tablet+ only). Asked for bigger default or resize.
16. Phone app menu: theme and green engine status take half the screen; customer doesn't understand. Asked: move/hide items, plain label for status.
17. Fullscreen: browser notice covers player controls for a long time. Asked: keep controls visible or use own overlay.

## Open questions to the owner (dev)
- Should a trim ripple by default, with an easy gap option? Owner's direction: yes, CapCut-like, gap must stay an easy action. Needs a docs PR first (project rule: plan change = docs PR).
- Auto-compaction or hand-off: owner said "ok" to a fresh session with this log.

## Open questions to the customer
- Batch 4: none pending (asked which action; answered "move").
- Undo toast: customer answered "move".
- Batch 1 permission: answered (Chrome, permission prompt, files relinked).

## Customer items still open (no answer needed unless the polish session asks)
- Linked video/audio cannot move between tracks (wants both linked and movable).
- Refresh permission prompt every reload (desktop Chrome).
- Android: files need to be chosen again after reload (expected per design; wording to check).
- Installed app (PWA) behaviour for files unconfirmed. Installed "Open with" may keep a file.

## Rules to keep
- Do not send to customer when there is no new information.
- Separate dev and customer replies completely.
- Keep customer replies short and plain.
- Times to the owner: Israel time (IST), via `TZ=Asia/Jerusalem date`.

## Handover from the customer support session (hand-off to successor 2)
Successor: session_01VHHsof6wDAPEHPiYXCrCQB (connected, idle, set up from this branch).

- Batches sent to the polish session: 1 to 17 (no change since the list above; batch 7 is still split into two items).
- Customer items not yet sent: none.
- Open customer items: none waiting on the customer. Linked video/audio moving between tracks, refresh permission prompt, Android re-choosing files after reload, and PWA file behaviour stay as listed above.
- Owner decisions:
  - Trim ripple by default: direction given (yes, like CapCut, with an easy, visible gap option). Implementation is open and needs a docs PR first. This is not a question for the owner. Do not ask it again.
  - Linked video/audio move between tracks: NOT decided. It is an open scope question in the polish session (batch 3, item 1). Do not record it as settled and do not raise it with the owner unless the polish session asks or the customer gives new information.
- Customer's last answers: Windows Chrome (permission prompt on refresh, files relinked after granting); Android Chrome (files chosen again after reload). The undo toast action was "move". The last reply sent was about the fullscreen notice (plain text).
- Nothing was left unhanded: no unsent customer item and no unpushed work from the previous session.

Rules for the successor: owner decisions and tags go only inside the "To dev" block; the customer block is plain language; do not re-send items already sent; read the customer's words before asking a question.
