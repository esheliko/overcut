import { StorageError, type ProjectStorage, type StorageErrorCode } from "./storage";

export interface WorkerStorage extends ProjectStorage {
  /** Kills the Worker at once, as a crashed tab would (tests; also frees it on close). Pending requests reject. */
  terminate(): void;
}

/** A `ProjectStorage` backed by the persistence Worker (`persist/worker.ts`): OPFS where the browser has sync access, IndexedDB otherwise. */
export async function createWorkerStorage(project: string): Promise<WorkerStorage> {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  let next = 1;
  const pending = new Map<number, { ok(v: unknown): void; err(e: unknown): void }>();
  worker.onmessage = (e: MessageEvent<{ id: number; ok?: unknown; err?: { code: StorageErrorCode; message: string } }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.err) p.err(new StorageError(e.data.err.code, e.data.err.message));
    else p.ok(e.data.ok);
  };
  const fail = (message: string) => {
    for (const p of pending.values()) p.err(new StorageError("io", message));
    pending.clear();
  };
  worker.onerror = () => fail("The saving process stopped unexpectedly.");
  const call = <T>(msg: Record<string, unknown>): Promise<T> =>
    new Promise<T>((ok, err) => {
      const id = next++;
      pending.set(id, { ok: ok as (v: unknown) => void, err });
      worker.postMessage({ id, ...msg });
    });
  const kind = await call<ProjectStorage["kind"]>({ cmd: "open", project });
  return {
    kind,
    read: (name) => call({ cmd: "read", name }),
    writeAtomic: (name, bytes) => call({ cmd: "writeAtomic", name, bytes }),
    append: (name, bytes) => call({ cmd: "append", name, bytes }),
    truncate: (name, size) => call({ cmd: "truncate", name, size }),
    remove: (name) => call({ cmd: "remove", name }),
    terminate() {
      worker.terminate();
      fail("The saving process was stopped.");
    },
  };
}
