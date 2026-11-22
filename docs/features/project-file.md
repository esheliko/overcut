# Feature: the `.overcut` project file (`app-model::file`, M1-005)

## Behaviour
Bytes in, bytes out; no I/O (hosts own storage: OPFS/file handles on the web, the filesystem natively). `ProjectFile::read(bytes)` / `write()`; the bindings expose `open_json(bytes)` and `save_bytes(project_json, previous)` (wasm `project_open`/`project_save`, Tauri commands of the same names, `Engine.openProject`/`saveProject`).

## Container (decision)
A zip (ADR-agnostic: `docs/ARCHITECTURE.md` says "a zip with `project.json`"):
- `project.json`: required, deflated, pretty JSON with sorted keys and a trailing newline (diff-friendly, and writing is deterministic: same project in, same bytes out).
- Any other entry (`thumbnails/<media id>.jpg`, `peaks/<media id>.bin`, `journal`, anything a future version adds) is an opaque blob, stored uncompressed, preserved on round trip. Names are `/`-separated, no `..`, no absolute paths, no backslashes (refused with `limits`).
- **Media is referenced, never embedded.** Only small derived assets belong in the container.
- Limits (zip-bomb guard, checked while reading, not from declared sizes): `project.json` 64 MiB, any entry 64 MiB, 256 MiB total, 4096 entries.

## Versions and migrations
- `schema_version` (from M1-002, `SCHEMA_VERSION`) lives in `project.json`.
- **Older**: migrated in memory by the chain `MIGRATIONS[n-1]: fn(Value) -> Value` (`vN -> vN+1`, pure, on the JSON document before typing). `ProjectFile::migrated()` is true; saving rewrites the file in the current format.
- **Same**: parsed and `Project::validate`d.
- **Newer**: if it still parses as the current shape the file opens **read-only** (`read_only: true`); `write`, `project_mut`, `set_entry` and `save_bytes` all fail with code `read_only`, so a newer file is never rewritten. If it does not parse, `open` fails with `newer_version` and a message telling the user to update the app. A read-only project is not validated (invariants may have changed).
- A format change: bump `SCHEMA_VERSION`, append one function to `MIGRATIONS`, check in `crates/model/fixtures/project.v<new>.json`. Keep every old fixture. Tests: `every_fixture_migrates_to_current_and_round_trips` (fails when a version has no fixture), `migration_machinery_runs_every_step_in_order`.

## Forward compatibility
Unknown JSON fields are preserved at every depth: on write the typed document is overlaid on the document as read (`merge_preserving`): keys the model knows come from the model, keys only the file has are kept. Arrays of objects with an `id` are matched by id, so reordering, inserting or deleting clips never attaches unknown data to the wrong element (a deleted element's extras go with it). Unknown zip entries are preserved the same way.

## Errors (never a panic)
Codes: `corrupt` (not a zip / damaged entry), `missing_project`, `bad_project` (JSON/shape/invariant), `newer_version`, `read_only`, `limits`, `invalid`. Bindings throw/reject the JSON string `{"code","message"}`; `Engine` turns it into `ProjectFileError`. Tests flip every byte and truncate at every length of a valid file; `crates/model/fuzz` is a cargo-fuzz target (`cargo +nightly fuzz run project_file` from `crates/model`; not run in CI).

## Media references and relink
`MediaRef.uri` is a path **relative to the project file's folder**, `/`-separated (host-resolved; web hosts map it to a handle key). Moving the project together with its media folder keeps every uri valid. `MediaRef.hash` is a content fingerprint, `fingerprint(size, first, last)` = `b3-64k:<size>:<blake3 hex>` over the size and the first and last 64 KiB (the whole file when smaller). Cheap for multi-GB files; edits confined to the unhashed middle are not detected (accepted trade-off; the size catches most).
Relink (host side, using `fingerprint_size` for a free pre-check): (1) resolve `uri` against the project folder and compare size, then fingerprint; (2) if missing or different, scan the project folder and any folder the user points at for files of the same size and compare fingerprints; (3) on a match update `uri` through an op; (4) otherwise the media is **offline**: the reference and every clip stay, never deleted. No fingerprint yet (`hash: None`): match on relative uri only.

## Open points / follow-ups
Tauri passes bytes as JSON number arrays (fine for KB-sized projects; switch to raw IPC bodies when thumbnails grow). The journal entry is reserved for M1-003. Nothing computes fingerprints in the UI/host yet.
