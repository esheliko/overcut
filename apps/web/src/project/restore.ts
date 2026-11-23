import type { Clip, Op, Project } from "@app/engine-client";

/**
 * The edit that turns `current` into `target` (restoring a version). One array = one undo step, so a restore never destroys the state it
 * replaced: Undo brings it back. Only existing ops are used (`docs/features/persistence.md`): media added/removed/relinked, the sequence
 * format, and every clip that differs is deleted and, where the target has it, inserted again (so no half-moved clip overlaps another).
 * Returns null when the two projects do not share their sequences and tracks (the ops cannot create those).
 */
export function restoreOps(current: Project, target: Project): Op[] | null {
  const ops: Op[] = [];
  const curMedia = new Map(current.media.map((m) => [m.id, m]));
  const tgtMedia = new Map(target.media.map((m) => [m.id, m]));
  const seqs = new Map(current.sequences.map((s) => [s.id, s]));
  if (target.sequences.length !== current.sequences.length) return null;

  for (const m of target.media) {
    const have = curMedia.get(m.id);
    if (!have) ops.push({ op: "add_media", media: m });
    else if (have.uri !== m.uri || (have.hash ?? null) !== (m.hash ?? null)) ops.push({ op: "set_media", media: m.id, uri: m.uri, hash: m.hash ?? null });
  }
  const inserts: Op[] = [];
  for (const ts of target.sequences) {
    const cs = seqs.get(ts.id);
    if (!cs || cs.tracks.length !== ts.tracks.length) return null;
    if (cs.frame_rate.num !== ts.frame_rate.num || cs.frame_rate.den !== ts.frame_rate.den || cs.resolution.width !== ts.resolution.width || cs.resolution.height !== ts.resolution.height) {
      ops.push({ op: "set_sequence_format", sequence: ts.id, frame_rate: ts.frame_rate, resolution: ts.resolution });
    }
    const here = new Map<string, { clip: Clip; track: string }>();
    for (const t of cs.tracks) for (const c of t.clips) here.set(c.id, { clip: c, track: t.id });
    const want = new Map<string, { clip: Clip; track: string }>();
    for (const t of ts.tracks) {
      if (!cs.tracks.some((x) => x.id === t.id)) return null;
      for (const c of t.clips) want.set(c.id, { clip: c, track: t.id });
    }
    for (const [id, h] of here) {
      const w = want.get(id);
      if (!w || w.track !== h.track || JSON.stringify(w.clip) !== JSON.stringify(h.clip)) ops.push({ op: "delete", clip: id });
    }
    for (const [id, w] of want) {
      const h = here.get(id);
      if (!h || h.track !== w.track || JSON.stringify(w.clip) !== JSON.stringify(h.clip)) inserts.push({ op: "insert_clip", track: w.track, clip: w.clip });
    }
  }
  ops.push(...inserts);
  for (const m of current.media) if (!tgtMedia.has(m.id)) ops.push({ op: "remove_media", media: m.id });
  return ops;
}
