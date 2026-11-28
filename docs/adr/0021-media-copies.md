# 0021 Keeping copies of imported media on the device
**Status**: **accepted** (owner approved keeping copies within a budget, with a way to free space, 2026-11-28, UX round 16 lane F)

**Context.** Chromium can keep a file handle across a reload; Safari, Firefox and every phone browser cannot. After a reload those users had to pick every file again, and every card and clip was blank. UX r15 rejected copying every import into OPFS because it doubles disk use for multi-GB video. ADR 0005 already says projects and media live on the device (OPFS or the file system).

**Decision.**
- A file imported **without a handle** (and not from the desktop shell, which reads files where they lie) is copied into OPFS (`overcut-media/<media id>` plus a `<id>.json` sidecar with name, size and owner project) when it fits the budget. The project stores the locator `kept:<id>`; reading it back needs no permission prompt.
- **Budget**: at most 2 GB of copies, and never more than half of the browser's storage quota (`navigator.storage.estimate()`). A file that does not fit is not kept: today's relink flow applies. The same happens where OPFS or Workers are missing, or when a copy fails midway (the locator reverts with `set_media`).
- The copy is streamed by a Worker (`createSyncAccessHandle`, which works in every browser with OPFS; `createWritable` on the main thread does not on Safari), so the UI thread never holds or copies the file. Big files show "Saving a copy… n%". The sidecar is written last: a copy cut short is never read.
- The app asks `navigator.storage.persist()` when it first keeps a copy, and the bin shows "N of 2 GB kept on this device" with **Remove unused media copies**. That removes copies the open project does not use and copies of deleted projects; copies owned by another existing project are never touched.
- **Posters** are cached apart from copies, by the media's content id (`posters` in OPFS, LRU, 32 MB, about 2,000 pictures), so cards show their picture after a reload before any file is readable. Filmstrip thumbnails already use a content-id keyed LRU cache (256 MB).
- Nothing leaves the device; the network smoke test covers it.

**Consequences.** (+) a reload keeps working media on phones, Safari and Firefox. (-) disk use up to the budget; a duplicated project shares copies, so removing "unused" copies from the original can strand the duplicate (it falls back to relink). The browser may still evict non-persisted storage; then the relink flow applies.
