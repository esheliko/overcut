/** Where the SOUND of a video goes when its picture is placed (drop from the bin, paste): the preferred audio track if it is free over the range, else the first
 *  unlocked audio track that is, else a NEW audio track (A2, A3 ...) at the bottom. The picture never moves because its sound clashes. Pure; the caller applies the ops
 *  together with the inserts, so it is one undo step. */
import { addTrackOp, newTrack, type Clip, type Op, type Project } from "@app/engine-client";

export interface SoundSpan { readonly start: number; readonly end: number; readonly prefer?: string }

const overlaps = (a: { start: number; end: number }, s: number, e: number): boolean => a.start < e && a.end > s;

/** For each span, the audio track to use, plus the `add_track` ops for any track that had to be created (they come first in the batch). */
export function planSound(p: Project, spans: readonly SoundSpan[], newId: () => string): { tracks: string[]; ops: Op[] } {
  const seq = p.sequences[0];
  const ops: Op[] = [];
  if (!seq) return { tracks: spans.map(() => ""), ops };
  const audio = seq.tracks.filter((t) => t.kind === "audio");
  const lanes: { id: string; locked: boolean; held: { start: number; end: number }[] }[] = audio.map((t) => ({
    id: t.id, locked: !!t.locked, held: t.clips.map((c: Clip) => ({ start: c.start, end: c.start + c.duration })),
  }));
  let made = 0;
  const tracks = spans.map((sp) => {
    const free = (l: (typeof lanes)[number]) => !l.locked && !l.held.some((h) => overlaps(h, sp.start, sp.end));
    const pick = (sp.prefer ? lanes.find((l) => l.id === sp.prefer && free(l)) : undefined) ?? lanes.find(free);
    if (pick) { pick.held.push({ start: sp.start, end: sp.end }); return pick.id; }
    const id = newId();
    ops.push(addTrackOp(seq.id, newTrack(id, "audio", `A${audio.length + made + 1}`), seq.tracks.length + made));
    made++;
    lanes.push({ id, locked: false, held: [{ start: sp.start, end: sp.end }] });
    return id;
  });
  return { tracks, ops };
}
