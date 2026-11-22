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
  /** Reads a `.overcut` file (M1-005). Rejects with `ProjectFileError` (corrupt, too new to display, ...). */
  openProject(bytes: Uint8Array): Promise<OpenedProject>;
  /**
   * Writes a `.overcut` file. Pass the bytes you opened as `previous` (omit for a new file) so unknown fields and extra
   * entries (thumbnails, peaks, journal) survive. Rejects with code `read_only` when `previous` came from a newer app.
   */
  saveProject(project: Project, previous?: Uint8Array): Promise<Uint8Array>;
  /** Opens video/audio files for decoding (M1-016). */
  readonly media: MediaApi;
}

export { MediaDecodeError, type MediaErrorKind } from "./decode/errors";

export interface OpenMediaOptions {
  /** Sample rate `audio()` returns (the project rate). Default 48000. */
  audioRate?: number;
  /** Ask for GPU-resident frames (`VideoFrame` handles). Default true; falls back to CPU RGBA when the host cannot. */
  gpu?: boolean;
}

export interface TrackInfo {
  /** WebCodecs codec string. */
  codec: string;
  width: number;
  height: number;
  /** Clockwise degrees to apply when displaying (frames are returned in coded orientation). */
  rotation: number;
  sampleRate: number;
  channels: number;
  durationTicks: number;
  /** Frames (video) or packets (audio). */
  packets: number;
  fps?: { num: number; den: number };
  vfr: boolean;
}

export interface MediaFileInfo {
  container: string;
  durationTicks: number;
  video?: TrackInfo;
  audio?: TrackInfo;
}

/** One decoded video frame. Call `release()` when done: a GPU frame holds decoder/GPU memory until then. */
export type DecodedFrame = { index: number; ptsTicks: number; width: number; height: number; release(): void } & (
  | { kind: "gpu"; /** The WebCodecs `VideoFrame`; valid until `release()`. */ frame: VideoFrame }
  | { kind: "cpu"; /** RGBA8, row-major, no padding. */ rgba: Uint8Array }
);

/** An open media file. */
export interface MediaHandle {
  readonly info: MediaFileInfo;
  /** Which kind `videoFrame` returns. */
  readonly frameKind: "gpu" | "cpu";
  readonly audioRate: number;
  /**
   * Frame-accurate decode of frame `index` (presentation order). Latest wins: a call made while an older one is running or queued
   * makes the older reject with `MediaDecodeError` kind `cancelled` (scrubbing). Rejects `unsupported` naming the codec.
   */
  videoFrame(index: number): Promise<DecodedFrame>;
  /** Interleaved f32 PCM at `audioRate`, `count` frames from `startSample` (silence past the end of the stream). */
  audio(startSample: number, count: number): Promise<Float32Array>;
  /** Decoder frame accounting (`open` must be 0 once every result is released: the no-leak check). */
  stats(): { received: number; closed: number; open: number };
  close(): Promise<void>;
}

export interface MediaApi {
  /** Opens a `File`/`Blob`; bytes are read on demand with range reads, never loaded whole. Rejects `MediaDecodeError`. */
  open(file: Blob, opts?: OpenMediaOptions): Promise<MediaHandle>;
}

/** Result of `Engine.openProject`. Mirrors `app_model::open_json`. */
export interface OpenedProject {
  project: Project;
  /** True when the file is from a newer app: show it, never save it. */
  readOnly: boolean;
  /** Schema version found on disk, before migration. */
  foundVersion: number;
  /** The file was older and has been upgraded in memory (saving rewrites it in the current format). */
  migrated: boolean;
  /** Names of the extra container entries (thumbnails, peaks, ...). */
  entries: string[];
}

export type ProjectFileErrorCode = "corrupt" | "missing_project" | "bad_project" | "newer_version" | "read_only" | "limits" | "invalid" | "unknown";

/** A failure to read or write a `.overcut` file; `message` is fit to show the user. */
export class ProjectFileError extends Error {
  constructor(readonly code: ProjectFileErrorCode, message: string) {
    super(message);
    this.name = "ProjectFileError";
  }
}

const FILE_ERROR_CODES: readonly string[] = ["corrupt", "missing_project", "bad_project", "newer_version", "read_only", "limits", "invalid"];

/** Turns what a backend threw (a `{code, message}` JSON string, or anything else) into a `ProjectFileError`. */
export function toProjectFileError(thrown: unknown): ProjectFileError {
  if (thrown instanceof ProjectFileError) return thrown;
  const text = typeof thrown === "string" ? thrown : thrown instanceof Error ? thrown.message : String(thrown);
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.code === "string" && typeof o.message === "string") {
        return new ProjectFileError(FILE_ERROR_CODES.includes(o.code) ? (o.code as ProjectFileErrorCode) : "unknown", o.message);
      }
    }
  } catch {
    /* not JSON: fall through */
  }
  return new ProjectFileError("unknown", text);
}

export function parseOpenedProject(json: string): OpenedProject {
  const v: unknown = JSON.parse(json);
  if (!v || typeof v !== "object") throw new Error("opened project is not an object");
  const o = v as Record<string, unknown>;
  if (!o.project || typeof o.project !== "object" || typeof o.read_only !== "boolean" || typeof o.found_version !== "number" || typeof o.migrated !== "boolean" || !Array.isArray(o.entries)) {
    throw new Error("opened project has the wrong shape");
  }
  return { project: o.project as Project, readOnly: o.read_only, foundVersion: o.found_version, migrated: o.migrated, entries: o.entries.map(String) };
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
  /**
   * What is visible and audible in a sequence at `ticks` (integer ticks, ADR 0010), plus an audio window of `audioSamples`
   * samples starting there (0 = video only). See docs/features/evaluate.md.
   */
  evaluate(sequence: string, ticks: number, audioSamples?: number): Promise<FrameDescription>;
}

export interface Transform {
  center: [number, number];
  scale: [number, number];
  rotation: number;
}

export interface VideoLayer {
  track: string;
  clip: string;
  media: string;
  /** Source time in ticks (floor to the media's own frame grid). */
  source_time: number;
  transform: Transform;
  opacity: number;
}

export interface AudioSegment {
  track: string;
  clip: string;
  media: string;
  /** First sample of the segment, relative to the window start. */
  out_start: number;
  len: number;
  /** Source time in ticks of the segment's first sample. */
  source_start: number;
  speed: { num: number; den: number };
  gain: number;
}

export interface FrameDescription {
  time: number;
  frame: number;
  video_time: number;
  sample: number;
  audio_samples: number;
  /** Bottom to top; empty = black. */
  layers: VideoLayer[];
  /** Samples not covered are silence. */
  audio: AudioSegment[];
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
