import type { Invoke } from "./native-media";

/** What the desktop app can encode on this computer (`desktop_codecs`). Drives the export dialog's MP4 / WebM choice (docs/features/desktop.md). */
export interface DesktopCodecs {
  /** `hardware`: an OS or GPU H.264 encoder opens. `software`: the Cisco OpenH264 library is installed. `none`: no H.264 encoder (MP4 export needs the opt-in download). */
  h264: "hardware" | "software" | "none";
  /** True when the desktop can write WebM (VP9 + Opus) without a network. */
  webm: boolean;
  /** True when the opt-in OpenH264 download is built into this app. */
  canEnableH264: boolean;
}

/** Desktop-only abilities (native dialogs, paths, projects folder, "Show in folder"). Absent on the web: `Engine.desktop` is undefined there. */
export interface DesktopApi {
  /** The system "open files" dialog. Files are read in place (paths, never copies); empty when cancelled. */
  pickMedia(): Promise<File[]>;
  /** The file at `path` (a stored `path:` uri), or null when it is gone. */
  fileAt(path: string): Promise<File | null>;
  /** Files dropped from the OS onto the window; `onHover` says whether a drag is over the window. Resolves to the unsubscribe function. */
  onDrop(handler: (files: File[]) => void, onHover?: (over: boolean) => void): Promise<() => void>;
  projectsFolder(): Promise<string>;
  /** Lets the person choose where projects are kept; null when cancelled. */
  chooseProjectsFolder(): Promise<string | null>;
  /** The system Save dialog for a finished export; writes straight to disk and returns the path, or null when cancelled. */
  saveExport(fileName: string, suggested: string): Promise<string | null>;
  /** The system "Open project" dialog: the `.overcut` file's name and bytes, or null when cancelled. */
  openProject(): Promise<{ name: string; bytes: Uint8Array } | null>;
  /** The system "Save project as" dialog: writes the bytes to the chosen `.overcut` file and returns its path, or null when cancelled. */
  saveProject(bytes: Uint8Array, suggested: string): Promise<string | null>;
  /** Shows the file in the system file manager. */
  reveal(path: string): Promise<void>;
  codecs(): Promise<DesktopCodecs>;
  /**
   * The opt-in OpenH264 download (issue #57): only ever called from the person's click. `onProgress` gets bytes so far and the total when known.
   * Rejects with an `H264Error` whose `code` says why (`offline`, `checksum`, `cancelled`, `unsupported`, `io`, `busy`).
   */
  enableH264(onProgress?: (p: H264Progress) => void): Promise<void>;
  /** Stops a running `enableH264` (it then rejects with code `cancelled`). */
  cancelH264(): Promise<void>;
}

export interface H264Progress {
  done: number;
  total: number | null;
}

export type H264FailureCode = "offline" | "checksum" | "cancelled" | "unsupported" | "io" | "busy" | "unknown";

/** Why the OpenH264 download did not finish. The message is plain language from the shell. */
export class H264Error extends Error {
  constructor(readonly code: H264FailureCode, message: string) {
    super(message);
    this.name = "H264Error";
  }
}

const H264_CODES: readonly string[] = ["offline", "checksum", "cancelled", "unsupported", "io", "busy"];

/** The shell rejects with `{"code": ..., "message": ...}` as a string; anything else becomes code `unknown`. */
export function parseH264Failure(e: unknown): H264Error {
  const raw = e instanceof Error ? e.message : String(e);
  try {
    const o = JSON.parse(raw) as { code?: unknown; message?: unknown };
    if (typeof o.code === "string") return new H264Error((H264_CODES.includes(o.code) ? o.code : "unknown") as H264FailureCode, typeof o.message === "string" ? o.message : raw);
  } catch {
    /* not JSON: a bare error such as "Command not found" */
  }
  return new H264Error("unknown", raw);
}

/** Percent done (0-100) of the download, or null while the size is not known. */
export function h264Percent(p: H264Progress): number | null {
  return p.total && p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : null;
}

/** `listen` from `@tauri-apps/api/event`, passed in by `tauri.ts` (the only file allowed to import `@tauri-apps/*`). */
export type Listen = <T>(event: string, handler: (e: { payload: T }) => void) => Promise<() => void>;

const MIME: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska", webm: "video/webm", avi: "video/x-msvideo", mpg: "video/mpeg", mpeg: "video/mpeg",
  ts: "video/mp2t", mts: "video/mp2t", m2ts: "video/mp2t", "3gp": "video/3gpp", wmv: "video/x-ms-wmv", flv: "video/x-flv", ogv: "video/ogg",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/opus", aif: "audio/aiff", aiff: "audio/aiff",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", heic: "image/heic", avif: "image/avif",
};

export const baseName = (path: string): string => path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
export const mimeOfPath = (path: string): string => MIME[baseName(path).split(".").pop()?.toLowerCase() ?? ""] ?? "";

/** A slice of a file on disk: only `arrayBuffer()` (and `size` / `type`) are real, which is all the fingerprint needs. */
class RangeBlob {
  constructor(private readonly read: (offset: number, len: number) => Promise<ArrayBuffer>, readonly size: number, readonly type: string, private readonly start: number) {}
  arrayBuffer(): Promise<ArrayBuffer> {
    return this.read(this.start, this.size);
  }
  slice(start = 0, end = this.size): RangeBlob {
    const s = Math.min(Math.max(0, start), this.size);
    return new RangeBlob(this.read, Math.max(0, Math.min(end, this.size) - s), this.type, this.start + s);
  }
}

const CHUNK = 8 * 1024 * 1024;

/**
 * A media file that stays on disk. It is a `File` as far as the UI is concerned (name, size, type, `slice(...).arrayBuffer()`), carries its `path` so the
 * native decoder opens it in place (`native-media.ts`), and reads bytes only on request through `desktop_read_range`. It is NOT a real `Blob`: it cannot be
 * structured-cloned to a Worker (that would lose it), which is why the desktop decodes natively instead.
 */
export class PathFile extends File {
  readonly path: string;
  readonly #size: number;
  readonly #read: (offset: number, len: number) => Promise<ArrayBuffer>;

  constructor(path: string, size: number, read: (offset: number, len: number) => Promise<ArrayBuffer>, lastModified = 0) {
    super([], baseName(path), { type: mimeOfPath(path), lastModified });
    this.path = path;
    this.#size = size;
    this.#read = read;
  }

  override get size(): number {
    return this.#size;
  }

  override slice(start = 0, end = this.#size, type = this.type): Blob {
    const s = Math.min(Math.max(0, start < 0 ? this.#size + start : start), this.#size);
    const e = Math.min(Math.max(0, end < 0 ? this.#size + end : end), this.#size);
    return new RangeBlob(this.#read, Math.max(0, e - s), type, s) as unknown as Blob;
  }

  override async arrayBuffer(): Promise<ArrayBuffer> {
    const out = new Uint8Array(this.#size);
    for (let off = 0; off < this.#size; off += CHUNK) out.set(new Uint8Array(await this.#read(off, Math.min(CHUNK, this.#size - off))), off);
    return out.buffer;
  }
}

/** `Engine.desktop` over the `desktop_*` commands and the `overcut://drop` / `overcut://drag` events the shell emits for OS file drops. */
export function createDesktopApi(invoke: Invoke, listen: Listen): DesktopApi {
  const fileAt = async (path: string): Promise<File | null> => {
    try {
      const size = await invoke<number>("desktop_file_size", { path });
      return new PathFile(path, size, async (offset, len) => (len === 0 ? new ArrayBuffer(0) : invoke<ArrayBuffer>("desktop_read_range", { path, offset, len })));
    } catch {
      return null;
    }
  };
  const many = async (paths: readonly string[]): Promise<File[]> => (await Promise.all(paths.map(fileAt))).filter((f): f is File => f !== null);
  return {
    pickMedia: async () => many(await invoke<string[]>("desktop_pick_media")),
    fileAt,
    onDrop: async (handler, onHover) => {
      const off = await Promise.all([
        listen<string[]>("overcut://drop", (e) => void many(e.payload).then((files) => files.length > 0 && handler(files))),
        listen<boolean>("overcut://drag", (e) => onHover?.(e.payload)),
      ]);
      return () => off.forEach((f) => f());
    },
    projectsFolder: () => invoke<string>("desktop_projects_folder"),
    chooseProjectsFolder: () => invoke<string | null>("desktop_choose_projects_folder"),
    saveExport: (fileName, suggested) => invoke<string | null>("desktop_save_export", { fileName, suggested }),
    openProject: async () => {
      const f = await invoke<[string, number[]] | null>("desktop_open_project");
      return f ? { name: f[0], bytes: Uint8Array.from(f[1]) } : null;
    },
    saveProject: (bytes, suggested) => invoke<string | null>("desktop_save_project", { bytes: Array.from(bytes), suggested }),
    reveal: (path) => invoke<void>("desktop_reveal", { path }),
    codecs: async () => JSON.parse(await invoke<string>("desktop_codecs")) as DesktopCodecs,
    enableH264: async (onProgress) => {
      const off = onProgress ? await listen<H264Progress>("overcut://h264-progress", (e) => onProgress(e.payload)) : undefined;
      try {
        await invoke<void>("desktop_enable_h264");
      } catch (e) {
        throw parseH264Failure(e);
      } finally {
        off?.();
      }
    },
    cancelH264: () => invoke<void>("desktop_cancel_h264"),
  };
}
