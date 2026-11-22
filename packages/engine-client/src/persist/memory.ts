import { toStorageError, slotStorage, type ProjectStorage, type RawFiles } from "./storage";

/**
 * In-memory raw files, for tests and as the reference behaviour of the real backends. `crash` makes the next `overwrite` or `append` that
 * would write more than `bytes` bytes persist only that many and then throw: a process dying mid-write.
 */
export function memoryFiles(): RawFiles & { files: Map<string, Uint8Array>; crash: { bytes: number } | null; failWith: unknown } {
  const files = new Map<string, Uint8Array>();
  const self = {
    files,
    crash: null as { bytes: number } | null,
    /** When set, every write throws this (a DOMException-like quota or permission error). */
    failWith: undefined as unknown,
    async read(name: string) {
      const b = files.get(name);
      return b ? b.slice() : null;
    },
    async overwrite(name: string, bytes: Uint8Array) {
      if (self.failWith) throw self.failWith;
      if (self.crash && bytes.length > self.crash.bytes) {
        files.set(name, bytes.slice(0, self.crash.bytes));
        self.crash = null;
        throw new Error("simulated crash");
      }
      files.set(name, bytes.slice());
    },
    async append(name: string, bytes: Uint8Array) {
      if (self.failWith) throw self.failWith;
      const old = files.get(name) ?? new Uint8Array();
      const keep = self.crash && bytes.length > self.crash.bytes ? bytes.slice(0, self.crash.bytes) : bytes;
      const next = new Uint8Array(old.length + keep.length);
      next.set(old);
      next.set(keep, old.length);
      files.set(name, next);
      if (keep !== bytes) {
        self.crash = null;
        throw new Error("simulated crash");
      }
    },
    async truncate(name: string, size: number) {
      if (self.failWith) throw self.failWith;
      const b = files.get(name);
      if (b && b.length > size) files.set(name, b.slice(0, size));
    },
    async remove(name: string) {
      if (self.failWith) throw self.failWith;
      files.delete(name);
    },
  };
  return self;
}

/** A `ProjectStorage` over `memoryFiles` (two-slot atomic replace, like OPFS). Errors are mapped to `StorageError`. */
export function memoryStorage(raw = memoryFiles()): ProjectStorage & { raw: ReturnType<typeof memoryFiles> } {
  const inner = slotStorage("memory", raw);
  const wrap = <A extends unknown[], R>(f: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
    try {
      return await f(...a);
    } catch (e) {
      throw toStorageError(e);
    }
  };
  return { kind: "memory", raw, read: wrap(inner.read), writeAtomic: wrap(inner.writeAtomic), append: wrap(inner.append), truncate: wrap(inner.truncate), remove: wrap(inner.remove) };
}
