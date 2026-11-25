# Feature: project model (`app-model`, M1-002)

## Behaviour
`Project -> Sequence -> Track -> Clip`, plus `Project.media: Vec<MediaRef>`. Plain serde data, no I/O, changed only by ops (ADR 0006, M1-003).
The M1 shape (one video + one audio track) is `Project::new`; tracks are a generic `Vec<Track>` with a `TrackKind`, so more tracks need no format change.

## Data model
- `schema_version: u32` on `Project` (`SCHEMA_VERSION = 4`; `v3 -> v4` is M2-007: sequences gained `markers`, `range`, `loop_range`, see `docs/features/markers.md`). Readers migrate older and refuse newer (M1-005 owns the migrations and fixtures; `v1 -> v2` is M2-002: tracks gained the fields below). Unknown fields from newer writers are preserved by the file layer (`docs/features/project-file.md`).
- **Ids**: 128-bit, typed (`ProjectId`, `SequenceId`, `TrackId`, `ClipId`, `MediaId`), serialized as 32 lowercase hex chars (a string, JS-safe). Unique across the whole document. The model never generates randomness: the host supplies an `IdSource` (`SeqIds` for tests/replay). Ops address things by id, never by index (mergeable, ADR 0006).
- **Time**: `Time` is integer ticks (ADR 0010; JSON integer, exact in JS up to ~147 days); `frame_rate` and `speed` are `Rational`.
- `Clip { id, media, start (timeline), source_in (in media), duration (timeline), speed }`; source length consumed = `duration * speed`.
- `MediaRef { id, kind, name, uri, hash?, duration? }`: `uri` is opaque, resolved by the host; clips never embed paths.

- `Track { id, kind (video | audio), name, muted, locked, hidden, solo, height?, colour?, clips }` (schema 2 added `hidden`, `solo`, `height`, `colour`; all optional in files, defaults = the M1 behaviour). A sequence's `tracks` run bottom-to-top: video draws in that order, so an overlay is simply a video track higher in the stack (TL-14). Text/effect kinds are reserved for M3/M4.
- **Track ops** (`app-timeline`, each undoable, `docs/features/timeline-ops.md`): `AddTrack { sequence, track, index }` (a track that carries clips is allowed: that is the undo of remove), `RemoveTrack`, `MoveTrack { track, index }`, `SetTrackProps { track, name?, muted?, solo?, locked?, hidden?, height?, colour? }` (absent = keep; `height`/`colour` `null` = default). Limits: at most 64 tracks per sequence; name 1-64 chars, trimmed; height 24-400; colour `#rrggbb`. A locked track cannot be removed; it can be moved, restyled and unlocked.
- **What evaluate draws / plays**: a track counts when it is not muted, not hidden, and, if any track of its kind is soloed, soloed itself. Solo is per kind (a video solo does not silence audio). Mute and hide beat solo.

- **Animatable values** (ADR 0015, `crates/model/src/anim.rs`, not yet in any document struct): `Animated { value: f64, keys: [Keyframe { t (clip-relative ticks), v, easing }] }`; easing is `hold`, `linear` or `bezier {x1,y1,x2,y2}`. Clip properties (M2-003) use it with `#[serde(default)]` so older files open unchanged.

## Invariants (`Project::validate`)
Version supported; ids unique; every clip's media exists; `duration > 0`, `start >= 0`, `source_in >= 0`, `speed > 0`; clips in a track sorted by `start`, non-overlapping (touching is fine); video track takes video/image media, audio track takes audio/video media; sequence rate/size positive.

## Schema and TypeScript
`crates/model/src/schema.rs` exports the JSON Schema (schemars). Checked in: `packages/engine-client/schema/project.schema.json` -> generated `packages/engine-client/src/model.generated.ts` (`npm run gen:model-types`, exported from `@app/engine-client`). Drift fails tests: the Rust test `checked_in_schema_matches_the_structs` (refresh: `UPDATE_SCHEMA=1 cargo test -p app-model schema`) and `tests/unit/model-types.test.ts`; `lint` also runs the generator `--check`.

## Edge cases
Overflowing `start + duration` is rejected; zero-length clips are rejected; an image clip's `source_in` is 0 by convention; `duration: None` on a `MediaRef` means still or not yet probed.

## Test plan
Unit tests next to the code: id round trip/malformed ids, M1 shape round trip, unknown-field tolerance, each invariant violation, duplicate ids, schema/type drift. M1-005 adds migration fixtures and a fuzz target on top.
