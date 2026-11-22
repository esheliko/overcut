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
  /**
   * The files behind the project's media, by media id (`File`s the user picked; cloned to the worker without copying their bytes).
   * Media without an entry here is looked up in the registered resolvers, then fails with `media_unavailable`.
   */
  sources?: Record<string, Blob>;
  /** Sequence frames to export, `[startFrame, endFrame)`. Default: the whole sequence (to the end of its last clip). */
  range?: { startFrame: number; endFrame: number };
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

/** Every way an export fails. `message` is fit to show the user; `code` is stable. */
export class ExportError extends Error {
  constructor(readonly code: ExportErrorCode, message: string) {
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
  | { type: "error"; jobId: string; code: ExportErrorCode; message: string };
