/** Pure rules for the on-device copies of imported media (`docs/adr/0015-media-copies.md`): what fits, and what "Remove unused media copies" may remove. */

/** At most this much is kept as copies, whatever the device offers. */
export const KEEP_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;
/** And never more than this share of what the browser says it may store, so projects, posters and the autosave log keep room. */
export const KEEP_QUOTA_SHARE = 0.5;

export interface KeepRoom { used: number; quota: number | null }

/** The most copies may take on this device. */
export const keepLimit = (quota: number | null): number => (quota && quota > 0 ? Math.min(KEEP_BUDGET_BYTES, Math.floor(quota * KEEP_QUOTA_SHARE)) : KEEP_BUDGET_BYTES);

/** True when a file of `size` bytes fits next to the `used` bytes of copies already kept. */
export const fitsBudget = (size: number, room: KeepRoom): boolean => size > 0 && room.used + size <= keepLimit(room.quota);

/** What is stored next to each copy: who imported it and how big it must be to count as complete. */
export interface KeptMeta { name: string; size: number; owner: string }

export interface KeptEntry { key: string; size: number; meta: KeptMeta }

/**
 * Copies nobody needs: those whose project is gone, and those the open project no longer lists. A copy of another project that still exists is never
 * touched (its media list is not open here). `inUse` holds the keys the open project references.
 */
export function unusedKeys(entries: readonly KeptEntry[], inUse: ReadonlySet<string>, projects: ReadonlySet<string>, current: string | null): string[] {
  return entries
    .filter((e) => !inUse.has(e.key) && (!projects.has(e.meta.owner) || e.meta.owner === current))
    .map((e) => e.key);
}

/** The key inside a `kept:` uri, or null for any other kind of uri. */
export const keptKey = (uri: string): string | null => (uri.startsWith("kept:") ? uri.slice(5) : null);
