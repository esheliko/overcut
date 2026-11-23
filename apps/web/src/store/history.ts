import type { Op, Project } from "@app/engine-client";

/** A readable name for one undo step: a catalog key plus its values, so the panel can show it in any language (`t(key, params)`). */
export interface HistoryLabel {
  key: string;
  params: Record<string, string | number>;
}

export interface HistoryEntry {
  label: HistoryLabel;
  /** The coalesce key of the edit (a drag), so repeated edits of one gesture show once. */
  coalesce: number | undefined;
}

const nameOfClip = (p: Project | null, clipId: string): string => {
  if (!p) return "";
  for (const s of p.sequences) for (const t of s.tracks) for (const c of t.clips) if (c.id === clipId) return p.media.find((m) => m.id === c.media)?.name ?? "";
  return "";
};
const nameOfMedia = (p: Project | null, id: string): string => p?.media.find((m) => m.id === id)?.name ?? "";

/**
 * Names the step `ops` makes in `before` (the project just before the edit). The first op decides (an import is add_media + inserts: "Import X").
 * Unknown shapes fall back to a generic "Edit".
 */
export function describeOps(ops: readonly Op[], before: Project | null): HistoryLabel {
  const first = ops[0];
  if (!first) return { key: "history.edit", params: {} };
  const clip = (id: string) => ({ name: nameOfClip(before, id) });
  switch (first.op) {
    case "add_media": {
      const withFormat = ops.some((o) => o.op === "set_sequence_format");
      return { key: ops.some((o) => o.op === "insert_clip") || withFormat ? "history.import" : "history.addMedia", params: { name: first.media.name } };
    }
    case "insert_clip": {
      const name = nameOfMedia(before, first.clip.media);
      return { key: "history.add", params: { name } };
    }
    case "split": return { key: "history.split", params: {} };
    case "trim_in": return { key: "history.trimStart", params: clip(first.clip) };
    case "trim_out": return { key: "history.trimEnd", params: clip(first.clip) };
    case "move": return { key: "history.move", params: clip(first.clip) };
    case "delete": return ops.length > 1 && ops.some((o) => o.op === "insert_clip") ? { key: "history.restore", params: {} } : { key: "history.delete", params: clip(first.clip) };
    case "set_clip": return { key: "history.adjust", params: clip(first.clip) };
    case "set_media": return { key: "history.relink", params: { name: nameOfMedia(before, first.media) } };
    case "remove_media": return { key: "history.removeMedia", params: { name: nameOfMedia(before, first.media) } };
    case "set_sequence_format": return { key: "history.canvas", params: { size: `${first.resolution.width}×${first.resolution.height}` } };
    default: return { key: "history.edit", params: {} };
  }
}

/** The undo/redo steps the store has seen. `past` oldest first; `future` the next redo first. `earlier`: the engine can undo further than this list knows (a recovered session). */
export interface HistoryState {
  past: readonly HistoryEntry[];
  future: readonly HistoryEntry[];
  earlier: boolean;
}

export const EMPTY_HISTORY: HistoryState = { past: [], future: [], earlier: false };

export function afterApply(h: HistoryState, entry: HistoryEntry): HistoryState {
  const last = h.past[h.past.length - 1];
  if (entry.coalesce !== undefined && last && last.coalesce === entry.coalesce && h.future.length === 0) {
    // the engine merges the same gesture into one step: keep the first name
    return h;
  }
  return { ...h, past: [...h.past, entry], future: [] };
}

export function afterUndo(h: HistoryState): HistoryState {
  const e = h.past[h.past.length - 1];
  return e ? { ...h, past: h.past.slice(0, -1), future: [e, ...h.future] } : h;
}

export function afterRedo(h: HistoryState): HistoryState {
  const e = h.future[0];
  return e ? { ...h, past: [...h.past, { ...e, coalesce: undefined }], future: h.future.slice(1) } : h;
}
