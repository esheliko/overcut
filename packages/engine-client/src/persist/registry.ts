import type { Project } from "../model.generated";
import { CHECKPOINT_FILE, DISCARDED_FILE, JOURNAL_FILE, PROJECT_FILE } from "./session";
import { INDEX_FILE, SnapshotStore } from "./snapshots";
import { decode, encode, type ProjectStorage } from "./storage";

/** The storage id of the list itself, and the file in it. Project ids are flat (`[A-Za-z0-9_-]`), so this cannot collide with a generated one. */
export const REGISTRY_ID = "registry";
export const REGISTRY_FILE = "projects.json";
/** The project every install had before the list existed (one project, `docs/features/persistence.md`). Its data stays where it is. */
export const LEGACY_PROJECT_ID = "default";

/** One row of the projects list. Only facts read from the project itself: nothing here is invented. */
export interface ProjectEntry {
  id: string;
  /** The name the user gave; "" = not named yet (the UI shows its localized default). */
  name: string;
  /** Milliseconds since the epoch: when the project was created here. */
  created: number;
  /** Milliseconds since the epoch: the last edit (or creation / import when nothing was edited). */
  modified: number;
  /** The canvas and the clip count as of the last time the project was left or edited; absent until known. */
  width?: number;
  height?: number;
  clips?: number;
}

export interface RegistryData {
  /** The project that was open last (the editor reopens it when there is only one). */
  current: string | null;
  items: ProjectEntry[];
}

/** Canvas size and clip count of a project, for its list row. */
export function summarize(p: Project): Pick<ProjectEntry, "width" | "height" | "clips"> {
  const seq = p.sequences[0];
  return {
    width: seq?.resolution.width,
    height: seq?.resolution.height,
    clips: p.sequences.reduce((n, s) => n + s.tracks.reduce((m, t) => m + t.clips.length, 0), 0),
  };
}

/** A fresh flat id: `p` + time + randomness. Never `default` or `registry`. */
export function newProjectId(now: number = Date.now(), rand: () => number = Math.random): string {
  return `p${now.toString(36)}${Math.floor(rand() * 36 ** 4).toString(36).padStart(4, "0")}`;
}

/** The first free name for a copy: "Film" -> "Film copy" -> "Film copy 2". */
export function copyName(name: string, taken: readonly string[], base: string): string {
  const root = (name.trim() || base).replace(/ copy( \d+)?$/, "");
  const used = new Set(taken.map((n) => n.trim()));
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? `${root} copy` : `${root} copy ${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

const isEntry = (e: unknown): e is ProjectEntry => !!e && typeof e === "object" && typeof (e as ProjectEntry).id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test((e as ProjectEntry).id) && typeof (e as ProjectEntry).modified === "number";

/**
 * The list of local projects (PM-06, `docs/features/projects.md`): a small file in its own storage (`REGISTRY_ID`), replaced atomically.
 * It only NAMES projects; each project's data stays in its own storage, so losing or damaging the list never touches a project.
 * Every change is one read-modify-write under `lock` (a Web Lock in browsers, so two tabs cannot overwrite each other).
 */
export class ProjectRegistry {
  constructor(
    private readonly storage: ProjectStorage,
    private readonly lock: <T>(f: () => Promise<T>) => Promise<T> = (f) => f(),
    private readonly now: () => number = Date.now,
  ) {}

  /** The stored list, or `null` when none was ever written (a first start, or an install from before the list). A damaged file reads as empty, never throws. */
  async read(): Promise<RegistryData | null> {
    const raw = await this.storage.read(REGISTRY_FILE);
    if (!raw) return null;
    try {
      const v = JSON.parse(decode(raw)) as { current?: unknown; items?: unknown };
      const items = (Array.isArray(v.items) ? v.items : []).filter(isEntry);
      return { current: typeof v.current === "string" ? v.current : null, items };
    } catch {
      return { current: null, items: [] };
    }
  }

  /** Newest edit first. */
  async list(): Promise<ProjectEntry[]> {
    return [...((await this.read())?.items ?? [])].sort((a, b) => b.modified - a.modified || (a.id < b.id ? -1 : 1));
  }

  private write(data: RegistryData): Promise<void> {
    return this.storage.writeAtomic(REGISTRY_FILE, encode(JSON.stringify({ v: 1, ...data })));
  }

  private change<T>(f: (data: RegistryData) => T): Promise<T> {
    return this.lock(async () => {
      const data = (await this.read()) ?? { current: null, items: [] };
      const out = f(data);
      await this.write(data);
      return out;
    });
  }

  /** Adds a project (or replaces the row with that id). */
  add(entry: Partial<ProjectEntry> & { id: string }): Promise<ProjectEntry> {
    const now = this.now();
    return this.change((d) => {
      const row: ProjectEntry = { name: "", created: now, modified: now, ...entry };
      d.items = [...d.items.filter((i) => i.id !== row.id), row];
      return row;
    });
  }

  /** Changes a row; does nothing for an id that is not listed. `modified` is only set when the patch carries it. */
  update(id: string, patch: Partial<Omit<ProjectEntry, "id" | "created">>): Promise<void> {
    return this.change((d) => {
      d.items = d.items.map((i) => (i.id === id ? { ...i, ...patch } : i));
    });
  }

  setCurrent(id: string | null): Promise<void> {
    return this.change((d) => {
      d.current = id;
    });
  }

  /** Takes a project off the list (its data is deleted separately, `deleteProjectData`). */
  remove(id: string): Promise<void> {
    return this.change((d) => {
      d.items = d.items.filter((i) => i.id !== id);
      if (d.current === id) d.current = null;
    });
  }
}

/**
 * The one-time move from a single project to a list, with no user action: when no list exists yet and the old project (`LEGACY_PROJECT_ID`) has
 * a saved file, it becomes the first row. Its data is NOT moved or rewritten (same id, same storage), so there is nothing to lose; a crash
 * before the list is written just repeats this next start. When the list exists it is never touched, so a deleted old project does not come back.
 * `describe` reads the old project's file (name, canvas, clip count) and returns `null` when there is none.
 */
export async function migrateSingleProject(
  registry: ProjectRegistry,
  describe: () => Promise<{ name: string } & Pick<ProjectEntry, "width" | "height" | "clips"> | null>,
  now: () => number = Date.now,
): Promise<RegistryData> {
  const existing = await registry.read();
  if (existing) return existing;
  const old = await describe();
  if (old) await registry.add({ id: LEGACY_PROJECT_ID, ...old, name: old.name === "Untitled project" ? "" : old.name, created: now(), modified: now() });
  else await registry.update("", {}); // writes the (empty) list so this check is done once
  await registry.setCurrent(old ? LEGACY_PROJECT_ID : null);
  return (await registry.read()) ?? { current: null, items: [] };
}

/**
 * Removes every file of one project: the saved file, the journal and checkpoint, kept-aside edits, and all version snapshots. Irreversible: the
 * UI asks first. Snapshots go before their index so a crash leaves a project that still lists what is left.
 */
export async function deleteProjectData(storage: ProjectStorage): Promise<void> {
  const snaps = new SnapshotStore(storage);
  for (const s of await snaps.list()) await snaps.remove(s.id);
  for (const f of [JOURNAL_FILE, CHECKPOINT_FILE, DISCARDED_FILE, INDEX_FILE, PROJECT_FILE]) await storage.remove(f);
}
