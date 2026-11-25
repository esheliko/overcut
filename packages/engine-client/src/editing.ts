import { parseRecovery, type SnapQuery, type SnapResult, type Editing, type EditOutcome, type FrameDescription, type Op, type TrackProps } from "./types";
import type { Project, SequenceId, Track, TrackId, TrackKind } from "./model.generated";

/** What each backend supplies: the engine's string-in, string-out editor calls. Rejections/throws carry the engine's message. */
export interface RawEditing {
  open(projectJson: string): Promise<void> | void;
  apply(opsJson: string, coalesce: number | undefined): Promise<string> | string;
  undo(): Promise<string> | string;
  redo(): Promise<string> | string;
  project(): Promise<string> | string;
  journal(): Promise<string> | string;
  /** `ticks` is an exact integer (i64 on the engine side). */
  evaluate(sequence: string, ticks: bigint, audioSamples: number): Promise<string> | string;
  snap(sequence: string, paramsJson: string): Promise<string> | string;
  takeLog(): Promise<string> | string;
  checkpoint(): Promise<string> | string;
  /** Returns the `Recovery` report JSON (snake_case, as the engine writes it). */
  recover(baseJson: string | null, checkpointJson: string | null, log: string): Promise<string> | string;
}

export function parseEditOutcome(json: string): EditOutcome {
  const v: unknown = JSON.parse(json);
  if (!v || typeof v !== "object") throw new Error("edit outcome is not an object");
  const o = v as Record<string, unknown>;
  if (typeof o.revision !== "number" || typeof o.can_undo !== "boolean" || typeof o.can_redo !== "boolean" || typeof o.changed !== "boolean") {
    throw new Error("edit outcome has the wrong shape");
  }
  return { revision: o.revision, can_undo: o.can_undo, can_redo: o.can_redo, changed: o.changed };
}

/** The coalesce key crosses as a u32. */
function checkKey(key: number | undefined): number | undefined {
  if (key === undefined) return undefined;
  if (!Number.isInteger(key) || key < 0 || key > 0xffff_ffff) throw new Error("coalesce key must be an integer in 0..2^32-1");
  return key;
}

async function call<T>(f: () => Promise<T> | T): Promise<T> {
  try {
    return await f();
  } catch (e) {
    // wasm-bindgen throws the engine's string, Tauri rejects with it: make it a real Error either way.
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/** One implementation of `Editing` over either backend's raw calls, so both behave identically. */
export function createEditing(raw: RawEditing): Editing {
  return {
    open: (project: Project) => call(() => raw.open(JSON.stringify(project))),
    apply: (ops: Op | Op[], coalesce?: number) => call(async () => parseEditOutcome(await raw.apply(JSON.stringify(ops), checkKey(coalesce)))),
    undo: () => call(async () => parseEditOutcome(await raw.undo())),
    redo: () => call(async () => parseEditOutcome(await raw.redo())),
    project: () => call(async () => JSON.parse(await raw.project()) as Project),
    journal: () => call(async () => raw.journal()),
    evaluate: (sequence: string, ticks: number, audioSamples = 0) =>
      call(async () => {
        if (!Number.isSafeInteger(ticks)) throw new Error("ticks must be a safe integer");
        if (!Number.isInteger(audioSamples) || audioSamples < 0 || audioSamples > 0xffff_ffff) throw new Error("audioSamples must be an integer in 0..2^32-1");
        return JSON.parse(await raw.evaluate(sequence, BigInt(ticks), audioSamples)) as FrameDescription;
      }),
    snap: (sequence: string, q: SnapQuery) =>
      call(async () => {
        const times = [q.t, q.tolerance, q.playhead ?? 0, q.span ?? 0, ...(q.markers ?? [])];
        if (!times.every(Number.isSafeInteger) || q.tolerance < 0) throw new Error("snap times must be safe integers and tolerance >= 0");
        return JSON.parse(await raw.snap(sequence, JSON.stringify(q))) as SnapResult;
      }),
    takeLog: () => call(async () => raw.takeLog()),
    checkpoint: () => call(async () => raw.checkpoint()),
    recover: (base: Project | null, checkpoint: string | null, log: string) =>
      call(async () => parseRecovery(await raw.recover(base ? JSON.stringify(base) : null, checkpoint, log))),
  };
}

// ---- Track ops (M2-002, `docs/features/model.md`): small builders for `Editing.apply`. Ids come from the caller (`newId()`). ----

/** A new, empty track. Pass it to `addTrackOp`. */
export function newTrack(id: TrackId, kind: TrackKind, name: string): Track {
  return { id, kind, name, muted: false, locked: false, clips: [] };
}

/** Add `track` at stack position `index` (0 = bottom, `tracks.length` = top). */
export function addTrackOp(sequence: SequenceId, track: Track, index: number): Op {
  return { op: "add_track", sequence, track, index };
}

/** Remove a track and its clips; one undo step brings both back. Locked tracks are refused by the engine. */
export function removeTrackOp(track: TrackId): Op {
  return { op: "remove_track", track };
}

/** Move a track to stack position `index` (counted after lifting it out, so `tracks.length - 1` is the top). */
export function moveTrackOp(track: TrackId, index: number): Op {
  return { op: "move_track", track, index };
}

/** Change some properties of a track (name, mute, solo, lock, hide, height, colour); see `TrackProps`. */
export function setTrackPropsOp(track: TrackId, props: TrackProps): Op {
  return { op: "set_track_props", track, ...props };
}
