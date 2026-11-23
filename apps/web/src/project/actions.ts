import { acquireProjectLock, copyName, openProjectSession, openProjectStorage, ProjectLibrary, VersionStore, type Engine, type ProjectMeta } from "@app/engine-client";
import { getDesktop } from "../media/sources";

/** Whole-project actions of the Projects home (`docs/features/projects-home.md`). Each runs with no project open (the engine has one editor). */

/** Stamps the library's name into the file, so the name travels with an exported project. */
async function named(engine: Engine, bytes: Uint8Array, name: string): Promise<Uint8Array> {
  const { project, readOnly } = await engine.openProject(bytes);
  if (readOnly || project.name === name) return bytes;
  return engine.saveProject({ ...project, name }, bytes);
}

/** The project's current state as `.overcut` bytes, recovering and folding any unsaved journal first. */
export async function projectBytes(engine: Engine, id: string, name: string): Promise<Uint8Array> {
  const release = await acquireProjectLock(id);
  const storage = await openProjectStorage(id);
  try {
    const { session } = await openProjectSession(engine, storage, { createProject: () => { throw new Error("This project's files are missing."); } });
    try {
      return await named(engine, await session.snapshot(), name);
    } finally {
      await session.close().catch(() => undefined);
    }
  } finally {
    storage.terminate?.();
    release();
  }
}

/** Makes a new project from `.overcut` bytes (opening a file, duplicating). Throws the engine's `ProjectFileError` for a damaged or unreadable file. */
export async function importProject(engine: Engine, library: ProjectLibrary, bytes: Uint8Array, name: string | null): Promise<ProjectMeta> {
  const { project } = await engine.openProject(bytes); // validates before anything is stored
  const id = ProjectLibrary.newId();
  const finalName = (name ?? project.name).trim().slice(0, 60) || "Untitled project";
  const stamped = await named(engine, bytes, finalName);
  const storage = await openProjectStorage(id);
  try {
    await storage.writeAtomic("project.overcut", stamped);
  } finally {
    storage.terminate?.();
  }
  const seq = project.sequences[0];
  const end = Math.max(0, ...(seq?.tracks ?? []).flatMap((t) => t.clips.map((c) => c.start + c.duration)));
  return library.upsert(id, {
    name: finalName,
    seconds: end / 705_600_000,
    width: seq?.resolution.width ?? 0,
    height: seq?.resolution.height ?? 0,
    fps: seq ? seq.frame_rate.num / seq.frame_rate.den : 0,
    fixSize: true,
    fixRate: true,
  });
}

export async function duplicateProject(engine: Engine, library: ProjectLibrary, id: string): Promise<ProjectMeta> {
  const meta = library.get(id);
  const name = copyName(meta?.name ?? "Untitled project", library.list().map((m) => m.name));
  const made = await importProject(engine, library, await projectBytes(engine, id, meta?.name ?? name), name);
  if (meta) library.upsert(made.id, { thumb: meta.thumb, fixSize: meta.fixSize, fixRate: meta.fixRate });
  return made;
}

export async function deleteProject(library: ProjectLibrary, id: string): Promise<void> {
  const storage = await openProjectStorage(id);
  try {
    await VersionStore.eraseAll(storage);
  } finally {
    storage.terminate?.();
  }
  library.remove(id);
}

const safeFileName = (name: string) => `${[...name].map((ch) => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? "_" : ch)).join("").trim() || "project"}.overcut`;

/** Hands the user a `.overcut` file: the system Save dialog in the desktop app, a download in the browser. Returns false when cancelled. */
export async function deliverProjectFile(bytes: Uint8Array, name: string): Promise<boolean> {
  const fileName = safeFileName(name);
  const desktop = getDesktop();
  if (desktop) return (await desktop.saveProjectFile(bytes, fileName)) !== null;
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/zip" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

/** Asks for a `.overcut` file: the system Open dialog in the desktop app, a file chooser in the browser. Null when cancelled. */
export async function pickProjectFile(): Promise<Uint8Array | null> {
  const desktop = getDesktop();
  if (desktop) return desktop.openProjectFile();
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".overcut,application/zip";
    input.hidden = true;
    input.setAttribute("data-testid", "project-file-input");
    const done = (v: Uint8Array | null) => { input.remove(); resolve(v); };
    input.onchange = () => {
      const f = input.files?.[0];
      void (f ? f.arrayBuffer().then((b) => done(new Uint8Array(b)), () => done(null)) : Promise.resolve(done(null)));
    };
    input.oncancel = () => done(null);
    document.body.append(input);
    input.click();
  });
}
