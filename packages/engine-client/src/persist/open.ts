import { isTauriRuntime } from "./runtime";
import { StorageError, type ProjectStorage } from "./storage";

/**
 * The right storage for this platform: the project folder in a Tauri shell, else the persistence Worker (OPFS, falling back to IndexedDB).
 * `project` is a flat id (letters, digits, `-`, `_`). The returned object has `terminate()` when a Worker backs it.
 */
export async function openProjectStorage(project: string): Promise<ProjectStorage & { terminate?: () => void }> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(project)) throw new StorageError("io", "Invalid project id.");
  if (isTauriRuntime()) return (await import("../tauri")).createTauriStorage(project);
  if (typeof Worker === "undefined") throw new StorageError("unavailable", "This browser cannot run the saving process, so your changes will not be saved.");
  return (await import("./worker-client")).createWorkerStorage(project);
}

/**
 * One window edits a project at a time (two writers would interleave the commit log). Uses Web Locks where available; resolves to a
 * `release` function, or throws `StorageError("locked")`. Native apps open one window per project already.
 */
export async function acquireProjectLock(project: string, waitMs = 2000): Promise<() => void> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) return () => undefined;
  const once = () =>
    new Promise<(() => void) | null>((resolve, reject) => {
      void locks
        .request(`overcut-project:${project}`, { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(null);
            return undefined;
          }
          return new Promise<void>((release) => resolve(() => release()));
        })
        .catch(reject);
    });
  // A window that is closing (or React re-mounting in dev) may still hold the lock for a moment: wait briefly before giving up.
  for (const start = Date.now(); ; ) {
    const release = await once();
    if (release) return release;
    if (Date.now() - start >= waitMs) throw new StorageError("locked", "This project is open in another tab or window. Close it there first.");
    await new Promise((r) => setTimeout(r, 100));
  }
}
