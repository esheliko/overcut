# UX round 16, lane F: media survives a reload

Evidence: PHONE-7, FIRST-9 and the r15 open item "posters after reload". Decision: `docs/adr/0021-media-copies.md` (owner approved keeping copies within a budget). Behaviour: `docs/features/media-bin.md`, section "Media that survives a reload".

## What changed (finding, before, after)

| ID | Before | After |
| --- | --- | --- |
| PHONE-7, FIRST-9 | After a reload every clip was blank and Safari, Firefox and phone users had to pick every file again. | A file imported without a handle is copied into OPFS by a Worker (streamed, progress on big files) and found again after a reload with no prompt and no relink. Over the budget (2 GB, at most half the quota) or without OPFS: the old relink flow. `navigator.storage.persist()` is asked at the first kept copy. |
| r15 open: posters after reload | Bin cards showed an icon until the file was readable. | Posters are cached by content id (OPFS, LRU, 32 MB, about 2,000 pictures) and show at once, even when the file is gone. Filmstrip thumbnails were already cached by content id (256 MB LRU). |
| Space | No way to see or free it. | The bin shows "N of 2 GB kept on this device" and **Remove unused media copies**. |

## Cost
Import adds one background copy in a Worker (no UI-thread read of the file; progress message every 8 MB). Reload adds one OPFS read per poster (about 15 KB each) and one small sidecar read per kept file. No network.

## Not done (and why)
- The wording of the reload banner and "Missing" badges: lane C owns it (`docs/m2/ux-r16-c.md` did not exist yet); this lane only made reloads work and added the storage line.
- Copies are keyed by media id, not by content hash, so the same file imported twice is stored twice.
- A duplicated project shares its source's copies; "Remove unused media copies" on the original can strand the duplicate (it falls back to relink). Listed in the ADR.
- Incomplete copies left by a killed tab are not listed or cleaned by "Remove unused media copies" (the Worker cleans up on errors it can see).

## Notes for the other lanes
- New media locator `kept:<id>`; `handleState` / `loadHandle(uri, request, name)` in `media/sources.ts` handle it. `BinItem.keeping` (0..1) is set while a copy is saved.
- Lane C: reloads of kept files come back `ready` with no permission step, so only truly missing files need the banner / "Missing" badge.
