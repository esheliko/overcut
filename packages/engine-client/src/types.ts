import type { Clip, ClipId, Project, Time, TrackId } from "./model.generated";

/** What the engine says about itself. Mirrors `app_core::EngineInfo` (crates/core/src/lib.rs). */
export interface EngineInfo {
  name: string;
  version: string;
  /** Bumped when anything crossing the JS boundary changes incompatibly. */
  abi: number;
}

/** Which implementation answers: the WebAssembly build in a browser, or the native engine inside a Tauri shell. */
export type EngineBackend = "wasm" | "tauri";

/**
 * The ONLY way UI code talks to the engine. Add methods here, implement them in both backends (`wasm.ts`, `tauri.ts`),
 * and cover both with the same tests. UI code must never import wasm or Tauri modules itself (`npm run check:boundaries`).
 */
export interface Engine {
  readonly backend: EngineBackend;
  info(): Promise<EngineInfo>;
  /** Edit the open project: apply ops, undo, redo (M1-003). The UI wiring comes with the timeline (M1-034). */
  readonly editing: Editing;
}

/**
 * One edit (ADR 0006; mirrors `app_timeline::Op`, kept in sync by `schema/edit-contract.json`, which both sides test against).
 * Ops address things by id; ids they create (`clip` in insert_clip, `new_id` in split) come from the caller: 32 lowercase hex chars.
 * Times are integer ticks.
 */
export type Op =
  | { op: "insert_clip"; track: TrackId; clip: Clip }
  | { op: "split"; clip: ClipId; at: Time; new_id: ClipId }
  | { op: "trim_in"; clip: ClipId; start: Time }
  | { op: "trim_out"; clip: ClipId; end: Time }
  | { op: "move"; clip: ClipId; track: TrackId; start: Time }
  | { op: "delete"; clip: ClipId }
  | { op: "set_clip"; clip: ClipId; start: Time; source_in: Time; duration: Time };

/** What the engine reports after every edit. Re-read `project()` when `revision` moved. */
export interface EditOutcome {
  revision: number;
  can_undo: boolean;
  can_redo: boolean;
  /** False for an undo/redo that had nothing to do. */
  changed: boolean;
}

export interface Editing {
  /** Opens a project (replacing any open one) with an empty history. Rejects a project that does not validate. */
  open(project: Project): Promise<void>;
  /**
   * Applies one op, or an array of ops as one atomic undo step. Rejects (and changes nothing) if any op is invalid.
   * Consecutive calls with the same `coalesce` number share one undo step (a drag = one Ctrl+Z).
   */
  apply(ops: Op | Op[], coalesce?: number): Promise<EditOutcome>;
  undo(): Promise<EditOutcome>;
  redo(): Promise<EditOutcome>;
  /** The current project document. */
  project(): Promise<Project>;
  /** Every applied op as JSON Lines (autosave / crash recovery). */
  journal(): Promise<string>;
}

export const EXPECTED_ABI = 1;

export function parseEngineInfo(json: string): EngineInfo {
  const v: unknown = JSON.parse(json);
  if (!v || typeof v !== "object") throw new Error("engine info is not an object");
  const o = v as Record<string, unknown>;
  if (typeof o.name !== "string" || typeof o.version !== "string" || typeof o.abi !== "number") throw new Error("engine info has the wrong shape");
  if (o.abi !== EXPECTED_ABI) throw new Error(`engine ABI ${o.abi} does not match the UI (${EXPECTED_ABI}): rebuild the engine`);
  return { name: o.name, version: o.version, abi: o.abi };
}
