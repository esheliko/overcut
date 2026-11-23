import { PROJECT_FILE } from "./session";
import { decode, encode, type ProjectStorage } from "./storage";

/** The version list of one project (`docs/features/persistence.md`, "Versions"). */
export const VERSIONS_FILE = "versions.json";
const versionFile = (id: string) => `v-${id}.overcut`;

export interface VersionMeta {
  id: string;
  /** What the user called it; null for an automatic snapshot. */
  name: string | null;
  auto: boolean;
  /** Epoch milliseconds. */
  at: number;
  /** Bytes of the snapshot file. */
  size: number;
}

export const AUTO_KEEP = 20;
/** Together the snapshots of one project stay under this; the oldest automatic ones go first, then the oldest named. */
export const VERSION_CAP_BYTES = 64 * 1024 * 1024;
export const AUTO_INTERVAL_MS = 10 * 60 * 1000;

/** Snapshots are whole `.overcut` files next to the project, listed in one small JSON file; every write is atomic. */
export class VersionStore {
  constructor(private readonly storage: ProjectStorage, private readonly limits = { autoKeep: AUTO_KEEP, capBytes: VERSION_CAP_BYTES }) {}

  /** Newest first. A damaged list reads as empty. */
  async list(): Promise<VersionMeta[]> {
    const raw = await this.storage.read(VERSIONS_FILE);
    if (!raw) return [];
    try {
      const v: unknown = JSON.parse(decode(raw));
      if (!Array.isArray(v)) return [];
      return (v as VersionMeta[]).filter((m) => typeof m?.id === "string" && typeof m.at === "number").sort((a, b) => b.at - a.at);
    } catch {
      return [];
    }
  }

  private writeList(list: VersionMeta[]) {
    return this.storage.writeAtomic(VERSIONS_FILE, encode(JSON.stringify(list)));
  }

  /**
   * Stores a snapshot and prunes. An automatic snapshot identical to the newest one is skipped (returns null).
   * Order is crash-safe: the file first, then the list that names it, then the files that fell out of the list.
   */
  async save(bytes: Uint8Array, name: string | null, now = Date.now()): Promise<VersionMeta | null> {
    const list = await this.list();
    const auto = name === null;
    if (auto && list[0] && list[0].size === bytes.length) {
      const last = await this.storage.read(versionFile(list[0].id));
      if (last && last.length === bytes.length && last.every((b, i) => b === bytes[i])) return null;
    }
    const id = `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await this.storage.writeAtomic(versionFile(id), bytes);
    const meta: VersionMeta = { id, name: name?.trim().slice(0, 60) || null, auto: auto || !name?.trim(), at: now, size: bytes.length };
    const kept = this.prune([meta, ...list]);
    await this.writeList(kept.keep);
    await Promise.all(kept.drop.map((m) => this.storage.remove(versionFile(m.id)).catch(() => undefined)));
    return meta;
  }

  /** Keeps the newest `autoKeep` automatic snapshots and every named one, then trims to the size cap (oldest automatic first, then oldest named; the newest always stays). */
  prune(all: VersionMeta[]): { keep: VersionMeta[]; drop: VersionMeta[] } {
    const sorted = [...all].sort((a, b) => b.at - a.at);
    const drop: VersionMeta[] = [];
    let seenAuto = 0;
    let keep = sorted.filter((m) => {
      if (m.auto && ++seenAuto > this.limits.autoKeep) {
        drop.push(m);
        return false;
      }
      return true;
    });
    let total = keep.reduce((n, m) => n + m.size, 0);
    while (total > this.limits.capBytes && keep.length > 1) {
      const victim = [...keep].reverse().find((m) => m.auto) ?? keep[keep.length - 1]!;
      if (victim === keep[0]) break;
      keep = keep.filter((m) => m !== victim);
      drop.push(victim);
      total -= victim.size;
    }
    return { keep, drop };
  }

  async read(id: string): Promise<Uint8Array | null> {
    return this.storage.read(versionFile(id));
  }

  async rename(id: string, name: string): Promise<void> {
    const list = await this.list();
    const m = list.find((v) => v.id === id);
    if (!m || !name.trim()) return;
    m.name = name.trim().slice(0, 60);
    m.auto = false; // naming a snapshot keeps it
    await this.writeList(list);
  }

  async remove(id: string): Promise<void> {
    await this.writeList((await this.list()).filter((m) => m.id !== id));
    await this.storage.remove(versionFile(id)).catch(() => undefined);
  }

  /** Deletes every file of a project (used when the project is deleted). */
  static async eraseAll(storage: ProjectStorage): Promise<void> {
    const store = new VersionStore(storage);
    const ids = (await store.list()).map((m) => versionFile(m.id));
    for (const f of [...ids, VERSIONS_FILE, PROJECT_FILE, "journal.jsonl", "checkpoint.json", "discarded.jsonl"]) await storage.remove(f).catch(() => undefined);
  }
}
