import type { Project } from "../model.generated";

/** Container choices. `auto` picks the best the browser can encode (docs/features/export.md, presets). */
export type ExportContainer = "auto" | "mp4" | "webm";
export type ExportVideoCodec = "auto" | "h264" | "vp9" | "av1";
export type ExportAudioCodec = "auto" | "aac" | "opus";

/** What to export. Everything but `sequence` has a sensible default. The export dialog (M1-035) builds this from a preset. */
export interface ExportSettings {
  /** Sequence id in the open project. The project is snapshotted when `start` is called: later edits do not change a running export. */
  sequence: string;
  container?: ExportContainer;
  videoCodec?: ExportVideoCodec;
  audioCodec?: ExportAudioCodec;
  /** Output size in pixels (default: the sequence resolution). Rounded down to even numbers (4:2:0 video). */
  width?: number;
  height?: number;
  /** Output frame rate (default: the sequence's). Frames are evaluated from the project at this rate; the export dialog offers only rates at or below the project's. */
  frameRate?: { num: number; den: number };
  /** Bits per second. Defaults scale with pixels and frame rate. */
  videoBitrate?: number;
  audioBitrate?: number;
  /** Seconds between keyframes (default 2). */
  keyframeIntervalSeconds?: number;
  hardware?: "no-preference" | "prefer-hardware" | "prefer-software";
  /**
   * Creation time written into the file, in ms since the Unix epoch (default: now). Pin it for a reproducible file: with the same project,
   * settings and a deterministic encoder (software VP9), two exports are byte-identical.
   */
  creationTime?: number;
  /** How the composited frame reaches the encoder: from a GPU readback (default) or straight from the canvas. For measuring and tests; both give the same pixels. */
  capture?: "readback" | "canvas";
  /**
   * The files behind the project's media, by media id (`File`s the user picked; cloned to the worker without copying their bytes).
   * Media without an entry here is looked up in the registered resolvers, then fails with `media_unavailable`.
   */
  sources?: Record<string, Blob>;
  /** Sequence frames to export, `[startFrame, endFrame)`. Default: the whole sequence (to the end of its last clip). */
  range?: { startFrame: number; endFrame: number };
  /**
   * Compatibility level (0 = the normal preset). The host raises it by itself when a worker crashes or an encoder fails, then starts over with
   * more conservative encoder settings: 1 = Main profile H.264, constant bitrate, realtime latency; 2 = Baseline H.264, software encoder;
   * 3 = no H.264 (VP9 + Opus in WebM). See `presets.ts`. Normally left unset.
   */
  safeLevel?: 0 | 1 | 2 | 3;
}

/** Emitted at least four times a second while a job runs, and once when the last frame is encoded. */
export interface ExportProgress {
  framesDone: number;
  totalFrames: number;
  /** 0..1 */
  fraction: number;
  elapsedMs: number;
  /** Milliseconds left, from the recent encode rate; null until there is enough data (about one second). */
  etaMs: number | null;
  /** Encode speed in output frames per second (recent). */
  fps: number;
  /** `finalizing` once the last frame is in: flushing the encoders and writing the index. */
  phase: "encoding" | "finalizing";
}

export type ExportErrorCode =
  | "cancelled"
  | "invalid_settings"
  | "empty_sequence"
  | "unsupported"
  | "media_unavailable"
  | "encode_failed"
  | "storage_failed"
  | "not_yet";

/** What was known when an export attempt failed: enough for a device report to show the cause (diagnostics, M2 W7). All fields best effort. */
export interface ExportFailureDetail {
  /** Last step the worker announced: `loading-engine`, `preset`, `media`, `renderer`, `file`, `encoders`, `encoding`, `finishing`, or `starting` / `none` when it never spoke. */
  stage?: string;
  /** Frames encoded when it failed. */
  frames?: number;
  /** Compatibility level of the attempt (`ExportSettings.safeLevel`). */
  level?: number;
  name?: string;
  message?: string;
  stack?: string;
  /** From the worker's error event (`ErrorEvent.filename/lineno/colno`). */
  filename?: string;
  lineno?: number;
  colno?: number;
  /** The encoder configs of the attempt, e.g. `avc1.640028 1920x1080 4000000bps variable hw:no-preference`. */
  video?: string;
  audio?: string;
  /** Earlier attempts of the same export (each failed), oldest first. */
  attempts?: ExportFailureDetail[];
}

/** Every way an export fails. `message` is fit to show the user; `code` is stable. */
export class ExportError extends Error {
  constructor(readonly code: ExportErrorCode, message: string, readonly detail?: ExportFailureDetail) {
    super(message);
    this.name = "ExportError";
  }
}

/** What the finished file is and how it was made. */
export interface ExportStats {
  frames: number;
  durationSeconds: number;
  fileBytes: number;
  encodeMs: number;
  /** Seconds of video produced per second of work (>= 1 means faster than realtime). */
  speedVsRealtime: number;
  /** Most frames ever waiting inside the video encoder (back-pressure holds it at a handful, so memory stays flat whatever the length). */
  peakEncodeQueue: number;
  /** Codec strings actually used, e.g. "avc1.640028 + mp4a.40.2". */
  codecs: string;
  /** Compatibility level that finally worked (0 = the normal preset; see `ExportSettings.safeLevel`). */
  safeLevel?: number;
  /** Attempts that failed before this one worked (empty or absent when the first one did). */
  failedAttempts?: ExportFailureDetail[];
}

export interface ExportResult {
  /** `video/mp4` or `video/webm` with codecs. */
  mime: string;
  fileName: string;
  fileBytes: number;
  stats: ExportStats;
  /** Anything the user should know, e.g. "MP4 with Opus audio has limited player support". */
  warnings: string[];
  /** The finished file, read lazily from storage (an OPFS file): hand it to a download link, `navigator.share`, or `File.stream()`. */
  file(): Promise<File>;
  /** Frees the storage. Call after the file has been saved or shared. */
  remove(): Promise<void>;
}

export interface ExportJob {
  readonly id: string;
  /** Listens for progress. Returns the unsubscribe function. */
  onProgress(listener: (p: ExportProgress) => void): () => void;
  /** Stops the job and deletes any partial file. `result` then rejects with `ExportError` code `cancelled`. */
  cancel(): void;
  /** Resolves when the file is complete; rejects with `ExportError`. */
  readonly result: Promise<ExportResult>;
}

export interface ExportApi {
  /**
   * Starts exporting the sequence of the open project. Runs in a Worker; the UI thread only receives progress.
   * Rejects with `ExportError` when the settings are invalid or the platform cannot export yet (Tauri: `not_yet`).
   */
  start(settings: ExportSettings): Promise<ExportJob>;
}

/** Message protocol between the host (`job.ts`) and the export worker (`worker.ts`). */
export type ToWorker =
  | { type: "start"; jobId: string; project: Project; settings: ExportSettings }
  | { type: "cancel"; jobId: string };

export type FromWorker =
  | { type: "progress"; jobId: string; progress: ExportProgress }
  | { type: "done"; jobId: string; mime: string; path: string; fileName: string; fileBytes: number; stats: ExportStats; warnings: string[] }
  /** The step the worker is on now (`ExportFailureDetail.stage`): the host keeps the last one to say where a crash happened. */
  | { type: "stage"; jobId: string; stage: string; video?: string; audio?: string }
  | { type: "error"; jobId: string; code: ExportErrorCode; message: string; detail?: ExportFailureDetail };
