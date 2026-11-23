import { slotStorage, toStorageError, StorageError, type ProjectStorage, type RawFiles } from "./storage";

/** True where OPFS synchronous access handles exist (Worker only; missing in Safari before 15.2 and some embedded webviews). */
export function hasOpfsSync(): boolean {
  return typeof navigator !== "undefined" && !!navigator.storage?.getDirectory && typeof FileSystemFileHandle !== "undefined" && "createSyncAccessHandle" in FileSystemFileHandle.prototype;
}

const isMissing = (e: unknown) => !!e && typeof e === "object" && (e as { name?: string }).name === "NotFoundError";

/** OPFS raw files for one project folder. MUST run in a Worker (sync access handles): flush() per write is what makes an append durable. */
async function opfsRaw(project: string): Promise<RawFiles> {
  const root = await navigator.storage.getDirectory();
  const dir = await (await root.getDirectoryHandle("projects", { create: true })).getDirectoryHandle(project, { create: true });
  const withHandle = async <T>(name: string, f: (h: FileSystemSyncAccessHandle) => T): Promise<T> => {
    const fh = await dir.getFileHandle(name, { create: true });
    const h = await fh.createSyncAccessHandle();
    try {
      return f(h);
    } finally {
      h.close();
    }
  };
  return {
    async read(name) {
      try {
        const fh = await dir.getFileHandle(name);
        return new Uint8Array(await (await fh.getFile()).arrayBuffer());
      } catch (e) {
        if (isMissing(e)) return null;
        throw e;
      }
    },
    overwrite: (name, bytes) =>
      withHandle(name, (h) => {
        h.truncate(0);
        h.write(bytes, { at: 0 });
        h.flush();
      }),
    append: (name, bytes) =>
      withHandle(name, (h) => {
        h.write(bytes, { at: h.getSize() });
        h.flush();
      }),
    async truncate(name, size) {
      try {
        await withHandle(name, (h) => {
          if (h.getSize() > size) {
            h.truncate(size);
            h.flush();
          }
        });
      } catch (e) {
        if (!isMissing(e)) throw e;
      }
    },
    async remove(name) {
      try {
        await dir.removeEntry(name);
      } catch (e) {
        if (!isMissing(e)) throw e;
      }
    },
  };
}

const DB = "overcut-projects";
const STORE = "files";
const reqP = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => ((r.onsuccess = () => res(r.result)), (r.onerror = () => rej(r.error))));
const txDone = (t: IDBTransaction) => new Promise<void>((res, rej) => ((t.oncomplete = () => res()), (t.onerror = () => rej(t.error)), (t.onabort = () => rej(t.error))));

/** IndexedDB raw files (browsers without OPFS sync access). An append is its own record, so it never rewrites the log. */
async function idbRaw(project: string): Promise<RawFiles> {
  const db = await new Promise<IDBDatabase>((res, rej) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onsuccess = () => res(open.result);
    open.onerror = () => rej(open.error);
  });
  const key = (name: string) => `${project}/${name}`;
  const chunkKey = (name: string, i: number) => `${key(name)}#${String(i).padStart(10, "0")}`;
  const range = (name: string) => IDBKeyRange.bound(`${key(name)}#`, `${key(name)}#￿`);
  const counts = new Map<string, number>();
  const read = async (name: string): Promise<Uint8Array | null> => {
      const tx = db.transaction(STORE, "readonly");
      const s = tx.objectStore(STORE);
      const [whole, chunks] = await Promise.all([reqP(s.get(key(name)) as IDBRequest<Uint8Array | undefined>), reqP(s.getAll(range(name)) as IDBRequest<Uint8Array[]>)]);
      if (!whole && chunks.length === 0) return null;
      const parts = whole ? [whole, ...chunks] : chunks;
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.length;
      }
      return out;
  };
  return {
    read,
    async overwrite(name, bytes) {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(bytes, key(name));
      await txDone(tx);
    },
    async append(name, bytes) {
      const tx = db.transaction(STORE, "readwrite");
      const s = tx.objectStore(STORE);
      let n = counts.get(name);
      if (n === undefined) n = await reqP(s.count(range(name)));
      s.put(bytes, chunkKey(name, n));
      counts.set(name, n + 1);
      await txDone(tx);
    },
    async truncate(name, size) {
      // IndexedDB appends are whole records, so a failed one leaves nothing torn: this only matters if the file is longer than `size`.
      const cur = await read(name);
      if (!cur || cur.length <= size) return;
      const tx = db.transaction(STORE, "readwrite");
      const s = tx.objectStore(STORE);
      s.delete(range(name));
      s.put(cur.slice(0, size), key(name));
      counts.delete(name);
      await txDone(tx);
    },
    async remove(name) {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key(name));
      tx.objectStore(STORE).delete(range(name));
      counts.delete(name);
      await txDone(tx);
    },
  };
}

/** The best browser storage available, with errors mapped to `StorageError`: OPFS where sync access exists, else IndexedDB. Call from the persistence Worker. */
export async function openWebStorage(project: string): Promise<ProjectStorage> {
  let raw: RawFiles;
  let kind: ProjectStorage["kind"];
  try {
    if (hasOpfsSync()) {
      raw = await opfsRaw(project);
      kind = "opfs";
    } else if (typeof indexedDB !== "undefined") {
      raw = await idbRaw(project);
      kind = "idb";
    } else {
      throw new StorageError("unavailable", "no browser storage");
    }
  } catch (e) {
    throw toStorageError(e);
  }
  const inner = slotStorage(kind, raw);
  const wrap = <A extends unknown[], R>(f: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
    try {
      return await f(...a);
    } catch (e) {
      throw toStorageError(e);
    }
  };
  return { kind, read: wrap(inner.read), writeAtomic: wrap(inner.writeAtomic), append: wrap(inner.append), truncate: wrap(inner.truncate), remove: wrap(inner.remove) };
}
