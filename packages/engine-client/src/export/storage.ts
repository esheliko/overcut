import type { StreamTargetChunk } from "mediabunny";
import { ExportError } from "./types";

/** An export file being written. */
export interface ExportFile {
  readonly path: string;
  /** Positioned writes, as the muxer produces them. */
  readonly writable: WritableStream<StreamTargetChunk>;
  /** Flushes and closes; returns the size in bytes. */
  close(): Promise<number>;
  /** Closes and deletes the partial file. Safe to call twice. */
  abort(): Promise<void>;
}

export interface ExportStorage {
  create(name: string): Promise<ExportFile>;
  /** Reads a finished file by the `path` that `ExportFile.path` returned. */
  open(path: string): Promise<File>;
  remove(path: string): Promise<void>;
}

const DIR = "overcut-exports";

/** `FileSystemSyncAccessHandle` is not in the DOM lib typings (worker-only API); this is the part we use. */
interface SyncHandle {
  write(data: Uint8Array, opts: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
  getSize(): number;
  close(): void;
}

/**
 * Origin-private file system storage. Writes go through a `FileSystemSyncAccessHandle` (worker only: positioned, synchronous, no copy), so a long export
 * never holds the file in a JS heap. Files live under `overcut-exports/`; leftovers from a crashed session are removed by `cleanupStaleExports`.
 */
export const opfsStorage: ExportStorage = {
  async create(name) {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(DIR, { create: true });
      const fh = await dir.getFileHandle(name, { create: true });
      const handle = await (fh as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle();
      handle.truncate(0);
      let open = true;
      const closeHandle = (): void => {
        if (open) {
          open = false;
          handle.close();
        }
      };
      return {
        path: `${DIR}/${name}`,
        writable: new WritableStream<StreamTargetChunk>({
          write: (chunk) => {
            handle.write(chunk.data, { at: chunk.position });
          },
        }),
        close: async () => {
          handle.flush();
          const size = handle.getSize();
          closeHandle();
          return size;
        },
        abort: async () => {
          closeHandle();
          await dir.removeEntry(name).catch(() => undefined);
        },
      };
    } catch (e) {
      throw new ExportError("storage_failed", `Could not create the export file: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
  async open(path) {
    const [d, name] = path.split("/");
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(d ?? DIR);
    return (await dir.getFileHandle(name ?? "")).getFile();
  },
  async remove(path) {
    const [d, name] = path.split("/");
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(d ?? DIR);
    await dir.removeEntry(name ?? "").catch(() => undefined);
  },
};

/** Deletes every file under `overcut-exports/` (call at app start: nothing is exporting yet). */
export async function cleanupStaleExports(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(DIR);
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) await dir.removeEntry(name).catch(() => undefined);
  } catch {
    /* no directory yet, or no OPFS: nothing to clean */
  }
}
