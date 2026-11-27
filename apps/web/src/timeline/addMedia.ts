/** "Add media at playhead" / "Add as overlay on a new track" (T-01): which media item the command puts on the timeline. Pure.
 *  The clip you have selected wins (add it again, as an overlay or a second take); otherwise the newest ready card in the bin. */
import type { Project } from "@app/engine-client";

export interface BinCard { id: string; status: string }

/** The media id to add, or null when there is nothing to add (an empty bin). `cards` is the bin in display order, newest first. */
export function mediaToAdd(project: Project | null, selection: ReadonlySet<string>, cards: readonly BinCard[]): string | null {
  const ready = new Set(cards.filter((c) => c.status === "ready").map((c) => c.id));
  if (project && selection.size > 0) {
    for (const tr of project.sequences[0]?.tracks ?? []) for (const c of tr.clips) if (selection.has(c.id) && ready.has(c.media)) return c.media;
  }
  return cards.find((c) => c.status === "ready")?.id ?? null;
}
