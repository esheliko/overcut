/** Which Details tabs a selection gets (UX r16): the set depends on what is selected, and so does the tab it opens on. Pure; `tests/unit/inspector-r16.test.ts`. */
import type { Project } from "@app/engine-client";

/** What the selection is, as far as Details cares. `audios`: several sounds and nothing else. */
export type DetailsKind = "none" | "video" | "photo" | "audio" | "audios" | "multi";
export type DetailTab = "video" | "speed" | "audio" | "duration";

export interface Picked { id: string; link: string | null; trackKind: string; image: boolean }

/** The selected clips with the facts Details needs, in track order. */
export function pickedClips(project: Project | null, selection: ReadonlySet<string>): Picked[] {
  const seq = project?.sequences[0];
  if (!project || !seq || selection.size === 0) return [];
  const kinds = new Map(project.media.map((m) => [m.id, m.kind] as const));
  return seq.tracks.flatMap((tr) => tr.clips.filter((c) => selection.has(c.id)).map((c) => ({ id: c.id, link: c.link ?? null, trackKind: tr.kind as string, image: kinds.get(c.media) === "image" })));
}

export function detailsKind(picked: readonly Picked[]): DetailsKind {
  if (picked.length === 0) return "none";
  const pictures = picked.filter((p) => p.trackKind === "video");
  if (pictures.length === 1) return pictures[0]!.image ? "photo" : "video"; // a picture with its linked sound is still that one clip
  if (picked.length === 1) return "audio";
  return picked.every((p) => p.trackKind === "audio") ? "audios" : "multi";
}

/** The tabs of a kind; the first one is where the panel opens. One tab means no tab bar. */
export function tabsOf(kind: DetailsKind): readonly DetailTab[] {
  switch (kind) {
    case "none": return ["video"];
    case "video": return ["video", "speed"];
    case "photo": return ["video", "duration"]; // a photo has no speed; its length is the thing to change
    case "audio": case "audios": return ["audio", "speed"]; // no picture to move or crop: no Video tab
    case "multi": return ["video", "speed"];
  }
}

/** The tab a toolbar request or the person's last pick lands on: it must exist for this kind, else the kind's first. */
export const tabFor = (kind: DetailsKind, wanted: DetailTab | null): DetailTab => (wanted && tabsOf(kind).includes(wanted) ? wanted : tabsOf(kind)[0]!);

/** The text of a tab ("Video" is "Photo" on a photo, "Selection" on several clips). */
export function tabLabelKey(kind: DetailsKind, tab: DetailTab): string {
  if (tab === "video") return kind === "photo" ? "details.tab.photo" : kind === "multi" ? "details.tab.multi" : "details.tab.video";
  return tab === "speed" ? "details.tab.speed" : tab === "audio" ? "details.tab.audio" : "details.tab.duration";
}

/** How many clips a selection is, as a person counts them: a picture and its linked sound are one clip. `withLinked` says a sound came along. */
export function selectionCount(picked: readonly { link: string | null }[]): { clips: number; withLinked: boolean } {
  const seen = new Set<string>();
  let clips = 0;
  for (const p of picked) {
    if (p.link) {
      if (seen.has(p.link)) continue;
      seen.add(p.link);
    }
    clips += 1;
  }
  return { clips, withLinked: picked.length > clips };
}

/** The one sentence for "what is selected": the toolbar chip and the Details header both use it, so they never disagree. */
export function selectionText(t: (key: string, values?: Record<string, string | number>) => string, sel: { clips: number; withLinked: boolean }): string {
  return t(sel.withLinked ? "timeline.selected.linked" : "timeline.selected", { count: sel.clips });
}
