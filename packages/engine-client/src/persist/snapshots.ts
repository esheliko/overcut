import type { ProjectStorage } from "./storage";

/** Why a snapshot exists. Only `manual` ones are kept for good; the rest are pruned to the newest `MAX_AUTO`. */
export type SnapshotKind = "manual" | "auto" | "before-open" | "before-new" | "before-restore";

export interface SnapshotInfo {
  id: string;
  /** Milliseconds since the epoch. */
  at: number;
  kind: SnapshotKind;
  /** The user's name for a manual snapshot; empty for the automatic ones (the UI words those by `kind`). */
  label: string;
  bytes: number;
  /** FNV-1a of the payload: an automatic snapshot of a project that has not changed since the newest one is skipped. */
  sig: string;
}

/** How many automatic snapshots (auto, before open / new / restore) are kept. Manual snapshots are never pruned. */
export const MAX_AUTO = 20;
export const INDEX_FILE = "snapshots.json";
export const snapshotFile = (id: string) => `snap-${id}.overcut`;

/** Which snapshots stay: every manual one plus the newest `maxAuto` of the others. Pure; `items` in any order, results newest first. */
export function retain(items: readonly SnapshotInfo[], maxAuto = MAX_AUTO): { keep: SnapshotInfo[]; drop: SnapshotInfo[] } {
  const newest = [...items].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
  let autos = 0;
  const keep: SnapshotInfo[] = [];
  const drop: SnapshotInfo[] = [];
  for (const s of newest) {
    if (s.kind === "manual" || ++autos <= maxAuto) keep.push(s);
    else drop.push(s);
  }
  return { keep, drop };
}

export function signature(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193) >>> 0;
  return `${bytes.length.toString(16)}-${h.toString(16)}`;
}

/**
 * Version snapshots of one project (PM-06): full `.overcut` files (written by the same engine writer as Save) kept beside the journal in the
 * project's storage (OPFS, IndexedDB or the project folder), plus a small index. The index is replaced atomically AFTER the payload is written
 * and BEFORE a pruned payload is removed, so a crash leaves at worst an orphan file, never an index entry without its file.
 */
export class SnapshotStore {
  constructor(private readonly storage: ProjectStorage, private readonly now: () => number = Date.now) {}

  async list(): Promise<SnapshotInfo[]> {
    const raw = await this.storage.read(INDEX_FILE);
    if (!raw) return [];
    try {
      const v = JSON.parse(new TextDecoder().decode(raw)) as { items?: SnapshotInfo[] };
      return (Array.isArray(v.items) ? v.items : []).filter((s) => typeof s?.id === "string" && typeof s.at === "number").sort((a, b) => b.at - a.at);
    } catch {
      return []; // a damaged index loses the list, never the project
    }
  }

  /** Stores `bytes` as a snapshot. An automatic one identical to the newest snapshot is skipped (returns null). */
  async add(kind: SnapshotKind, label: string, bytes: Uint8Array): Promise<SnapshotInfo | null> {
    const items = await this.list();
    const sig = signature(bytes);
    if (kind !== "manual" && items[0]?.sig === sig) return null;
    let at = this.now();
    if (items[0] && at <= items[0].at) at = items[0].at + 1; // strictly increasing: order and ids stay unambiguous
    const info: SnapshotInfo = { id: at.toString(36), at, kind, label: label.trim().slice(0, 80), bytes: bytes.length, sig };
    await this.storage.writeAtomic(snapshotFile(info.id), bytes);
    const { keep, drop } = retain([info, ...items]);
    await this.writeIndex(keep);
    await Promise.all(drop.map((d) => this.storage.remove(snapshotFile(d.id)).catch(() => undefined)));
    return info;
  }

  async read(id: string): Promise<Uint8Array | null> {
    return this.storage.read(snapshotFile(id));
  }

  async remove(id: string): Promise<void> {
    await this.writeIndex((await this.list()).filter((s) => s.id !== id));
    await this.storage.remove(snapshotFile(id)).catch(() => undefined);
  }

  private writeIndex(items: SnapshotInfo[]): Promise<void> {
    return this.storage.writeAtomic(INDEX_FILE, new TextEncoder().encode(JSON.stringify({ v: 1, items })));
  }
}
