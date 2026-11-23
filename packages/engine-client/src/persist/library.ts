/**
 * The list of projects on this device (`docs/features/projects-home.md`). The projects themselves live in their own storage folders
 * (`openProjectStorage(id)`); this index only holds what the Projects home shows (name, thumbnail, length, last edited) so listing never
 * opens a project. It is a small JSON document in `localStorage` (the Tauri webview has one too). Everything here fails soft: when
 * storage is blocked the library works for this session in memory and the editor still opens its project.
 */
export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Length of the timeline in seconds. */
  seconds: number;
  width: number;
  height: number;
  /** Frames per second as a number (display only). */
  fps: number;
  /** True once the user chose a canvas size: the first import then keeps it instead of adopting the clip's. */
  fixSize: boolean;
  /** Same for the frame rate. */
  fixRate: boolean;
  /** A small JPEG data URL of the first picture, or null. */
  thumb: string | null;
}

export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const INDEX_KEY = "overcut.projects.v1";
const CURRENT_KEY = "overcut.project.current";
/** The project every install had before there was a list. */
export const LEGACY_PROJECT_ID = "default";
const MAX_THUMB = 40_000;

function browserKV(): KeyValue {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.getItem(INDEX_KEY); // throws when blocked
      return localStorage;
    }
  } catch {
    /* fall through */
  }
  const mem = new Map<string, string>();
  return { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) };
}

const isMeta = (v: unknown): v is ProjectMeta => {
  const o = v as Partial<ProjectMeta> | null;
  return !!o && typeof o === "object" && typeof o.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(o.id) && typeof o.name === "string" && typeof o.updatedAt === "number";
};

const blank = (id: string, now: number): ProjectMeta => ({ id, name: "", createdAt: now, updatedAt: now, seconds: 0, width: 0, height: 0, fps: 0, fixSize: false, fixRate: false, thumb: null });

export class ProjectLibrary {
  private readonly kv: KeyValue;
  constructor(kv?: KeyValue) {
    this.kv = kv ?? browserKV();
  }

  /** Newest edit first. A damaged index reads as empty (the projects themselves are untouched). */
  list(): ProjectMeta[] {
    try {
      const v: unknown = JSON.parse(this.kv.getItem(INDEX_KEY) ?? "[]");
      if (!Array.isArray(v)) return [];
      return v.filter(isMeta).map((m): ProjectMeta => ({ ...blank(m.id, m.updatedAt), ...m })).sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  }

  get(id: string): ProjectMeta | undefined {
    return this.list().find((m) => m.id === id);
  }

  private write(all: ProjectMeta[]) {
    try {
      this.kv.setItem(INDEX_KEY, JSON.stringify(all));
    } catch {
      /* quota or blocked: the index is a convenience, never fatal */
    }
  }

  /** Adds the project or merges `patch` into it. `updatedAt` defaults to now when the patch gives none. */
  upsert(id: string, patch: Partial<Omit<ProjectMeta, "id">>, now = Date.now()): ProjectMeta {
    const all = this.list().filter((m) => m.id !== id);
    const old = this.get(id);
    const merged: ProjectMeta = { ...blank(id, now), ...old, updatedAt: now, ...patch };
    if (merged.thumb && merged.thumb.length > MAX_THUMB) merged.thumb = old?.thumb ?? null;
    this.write([merged, ...all]);
    return merged;
  }

  rename(id: string, name: string): void {
    const clean = name.trim().slice(0, 60);
    const m = this.get(id);
    if (clean && m) this.upsert(id, { name: clean, updatedAt: m.updatedAt });
  }

  remove(id: string): void {
    this.write(this.list().filter((m) => m.id !== id));
    if (this.currentId() === id) this.setCurrent(null);
  }

  /** The project to open at start: the one last open, else the legacy single project; null = show the Projects home. */
  currentId(): string | null {
    try {
      const v = this.kv.getItem(CURRENT_KEY);
      if (v === null) return LEGACY_PROJECT_ID;
      return v === "" ? null : v;
    } catch {
      return LEGACY_PROJECT_ID;
    }
  }

  setCurrent(id: string | null): void {
    try {
      this.kv.setItem(CURRENT_KEY, id ?? "");
    } catch {
      /* ignore */
    }
  }

  /** A fresh project id: letters, digits and `-` only (it names a storage folder). */
  static newId(): string {
    const r = new Uint8Array(8);
    crypto.getRandomValues(r);
    return `p-${Array.from(r, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 14)}`;
  }
}

/** "Name copy", "Name copy 2"... not already taken. */
export function copyName(name: string, taken: readonly string[]): string {
  const base = name.replace(/ copy( \d+)?$/, "");
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${base} copy` : `${base} copy ${n}`;
    if (!taken.includes(candidate)) return candidate.slice(0, 60);
  }
}
