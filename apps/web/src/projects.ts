/**
 * The projects list on this device (PM-06, `docs/features/projects.md`): the registry, plus the few things the list does to a project that is NOT
 * open (create, import, duplicate, delete). The project that is open is edited through `persistence.tsx`; none of this touches it.
 */
import {
  LEGACY_PROJECT_ID,
  PROJECT_FILE,
  ProjectRegistry,
  REGISTRY_ID,
  acquireProjectLock,
  copyName,
  deleteProjectData,
  migrateSingleProject,
  newProjectId,
  openProjectSession,
  openProjectStorage,
  summarize,
  type Engine,
  type ProjectEntry,
  type RegistryData,
} from "@app/engine-client";

let registry: Promise<ProjectRegistry> | null = null;

/** The one registry of this window (its storage stays open for the window's life: a single small file). Web Locks keep two tabs from overwriting each other. */
export function getRegistry(): Promise<ProjectRegistry> {
  registry ??= openProjectStorage(REGISTRY_ID).then((storage) => {
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
    const lock = locks ? <T,>(f: () => Promise<T>) => locks.request("overcut-registry", f) as Promise<T> : undefined;
    return new ProjectRegistry(storage, lock);
  });
  registry.catch(() => (registry = null)); // a failed open can be retried
  return registry;
}

/** Runs `f` on a project's storage that is not open in this window, then lets go of it. Refuses (`locked`) when another window has it open. */
async function withStorage<T>(id: string, f: (s: Awaited<ReturnType<typeof openProjectStorage>>) => Promise<T>): Promise<T> {
  const release = await acquireProjectLock(id);
  let storage: Awaited<ReturnType<typeof openProjectStorage>> | undefined;
  try {
    storage = await openProjectStorage(id);
    return await f(storage);
  } finally {
    storage?.terminate?.();
    release();
  }
}

/** Reads the list; the first time after an update from the one-project version it adds the old project as the first row (`migrateSingleProject`). */
export async function loadProjects(engine: Engine): Promise<RegistryData> {
  const reg = await getRegistry();
  return migrateSingleProject(reg, () =>
    withStorage(LEGACY_PROJECT_ID, async (s) => {
      const bytes = await s.read(PROJECT_FILE);
      if (!bytes) return null;
      try {
        const { project } = await engine.openProject(bytes);
        return { name: project.name, ...summarize(project) };
      } catch {
        return { name: "" }; // a file this build cannot read still belongs in the list: opening it shows the real reason
      }
    }),
  );
}

/** Adds a project to the list. With `bytes` (a `.overcut` file already checked by the caller) it starts from that file, else it starts empty on first open. */
export async function createProject(engine: Engine, name: string, bytes?: Uint8Array): Promise<ProjectEntry> {
  const reg = await getRegistry();
  const id = newProjectId();
  let extra: Partial<ProjectEntry> = {};
  if (bytes) {
    const { project } = await engine.openProject(bytes);
    extra = summarize(project);
    await withStorage(id, (s) => s.writeAtomic(PROJECT_FILE, bytes));
  }
  return reg.add({ id, name, ...extra });
}

/** A copy of a project that is not open: its latest state (a crash-left journal is replayed first, like opening it would) saved as a new project. */
export async function duplicateProject(engine: Engine, entry: ProjectEntry, defaultName: string): Promise<ProjectEntry> {
  const reg = await getRegistry();
  const bytes = await withStorage(entry.id, async (s) => {
    const { session } = await openProjectSession(engine, s, { createProject: () => { throw new Error("this project has no saved file"); } });
    try {
      return await session.exportBytes();
    } finally {
      await session.close().catch(() => undefined);
    }
  });
  const name = copyName(entry.name, (await reg.list()).map((e) => e.name), defaultName);
  const copy = await createProject(engine, name, bytes);
  return copy;
}

/** Deletes a project for good (its data and its row). The caller has asked the person first. */
export async function deleteProject(entry: ProjectEntry): Promise<void> {
  const reg = await getRegistry();
  await withStorage(entry.id, deleteProjectData);
  await reg.remove(entry.id);
}
