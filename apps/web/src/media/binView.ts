import type { MediaKind, Project } from "@app/engine-client";
/** What the view needs of a card (`BinItem` in `useMediaBin.ts` has more). */
export interface BinViewItem { id: string; name: string; kind: MediaKind; durationTicks?: number | null }

/** What the bin shows (PM-03): a type filter, a tag filter, a sort and the search box. Pure, so it is unit tested and cheap at 10k items. */
export type BinSort = "added" | "name" | "duration";
export interface BinFilter { kind: MediaKind | "all"; tag: string; sort: BinSort; query: string }
export const DEFAULT_FILTER: BinFilter = { kind: "all", tag: "", sort: "added", query: "" };

/** Per media id: the user's tags and the position in the project's media list (= the order it was added in). */
export type BinMeta = ReadonlyMap<string, { tags: readonly string[]; order: number }>;

export const MAX_TAGS = 16;
export const MAX_TAG_LEN = 40;

export function binMeta(p: Project | null): BinMeta {
  const m = new Map<string, { tags: readonly string[]; order: number }>();
  p?.media.forEach((x, order) => m.set(x.id, { tags: x.tags ?? [], order }));
  return m;
}

/** Every tag in use, sorted case-insensitively; the first spelling met wins ("Interview" vs "interview"). */
export function allTags(meta: BinMeta): string[] {
  const seen = new Map<string, string>();
  for (const { tags } of meta.values()) for (const t of tags) if (!seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/** A tag as the engine accepts it (trimmed, no longer than the limit), or "" when nothing is left. */
export const cleanTag = (s: string): string => s.trim().replace(/\s+/g, " ").slice(0, MAX_TAG_LEN).trim();

/** The tag list after adding `tag` (ignored when empty, a duplicate in any case, or the list is full). Returns the same array when nothing changes. */
export function withTag(tags: readonly string[], raw: string): readonly string[] {
  const tag = cleanTag(raw);
  if (!tag || tags.length >= MAX_TAGS || tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return tags;
  return [...tags, tag];
}

export const withoutTag = (tags: readonly string[], tag: string): readonly string[] => tags.filter((t) => t !== tag);

const byName = (a: BinViewItem, b: BinViewItem) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

/**
 * The cards to show. Items that are not in the project yet (still being read, or refused) stay on top, always visible: they carry the
 * progress and the errors. The rest are filtered by type, tag and search (name or tag) and sorted: `added` newest first, `name` A to Z
 * (numbers in order), `duration` longest first with stills and unknown lengths last.
 */
export function viewBin<T extends BinViewItem>(items: readonly T[], meta: BinMeta, f: BinFilter): T[] {
  const q = f.query.trim().toLowerCase();
  const tag = f.tag.toLowerCase();
  const pending: T[] = [];
  const rest: T[] = [];
  for (const i of items) {
    const m = meta.get(i.id);
    if (!m) { pending.push(i); continue; }
    if (f.kind !== "all" && i.kind !== f.kind) continue;
    if (tag && !m.tags.some((t) => t.toLowerCase() === tag)) continue;
    if (q && !i.name.toLowerCase().includes(q) && !m.tags.some((t) => t.toLowerCase().includes(q))) continue;
    rest.push(i);
  }
  const order = (i: T) => meta.get(i.id)!.order;
  if (f.sort === "name") rest.sort((a, b) => byName(a, b) || order(b) - order(a));
  else if (f.sort === "duration") rest.sort((a, b) => (b.durationTicks ?? -1) - (a.durationTicks ?? -1) || byName(a, b));
  else rest.sort((a, b) => order(b) - order(a));
  return [...pending, ...rest];
}

/** Row window of a long list: which rows to render for a scroll position. `top` is where the list starts inside the scroller. */
export function windowRange(scrollTop: number, viewport: number, top: number, rowHeight: number, count: number, overscan = 6): [number, number] {
  const first = Math.floor((scrollTop - top) / rowHeight) - overscan;
  const last = Math.ceil((scrollTop - top + viewport) / rowHeight) + overscan;
  return [Math.max(0, Math.min(count, first)), Math.max(0, Math.min(count, last))];
}
