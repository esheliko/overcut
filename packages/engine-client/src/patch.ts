import type { Clip, MediaRef, Project, Sequence, Track } from "./model.generated";

/** Replace `remove` clips at `start` with `insert`. */
export interface ClipSplice {
  start: number;
  remove: number;
  insert: Clip[];
}

/** One changed or new track. `shell` is the track without clips (present when another field changed, or the track is new). */
export interface TrackPatch {
  id: string;
  shell?: Track;
  splice?: ClipSplice;
}

export interface SequencePatch {
  id: string;
  /** The sequence without its tracks, when anything but the tracks changed. */
  shell?: Sequence;
  /** Every track id, bottom to top, when a track was added, removed or moved. */
  order?: string[];
  tracks: TrackPatch[];
}

/** What an edit changed (ADR 0020). Produced by the engine (`crates/timeline/src/patch.rs`); `applyEditPatch` is its reference application on this side. */
export interface EditPatch {
  media?: MediaRef[];
  sequences: SequencePatch[];
}

function patchTrack(old: Track | undefined, tp: TrackPatch): Track {
  if (!old && !tp.shell) throw new Error("patch adds a track without its shell");
  // A new shell carries no clips; a shell over an existing track keeps its clips (the splice below changes them).
  let t: Track = tp.shell ? { ...tp.shell, clips: old ? old.clips : [] } : (old as Track);
  const sp = tp.splice;
  if (sp) {
    if (sp.start < 0 || sp.remove < 0 || sp.start + sp.remove > t.clips.length) throw new Error("patch splice is out of range");
    t = { ...t, clips: t.clips.slice(0, sp.start).concat(sp.insert, t.clips.slice(sp.start + sp.remove)) };
  }
  return t;
}

/**
 * The project after `patch`, without mutating `project`: every track and clip the patch does not name keeps its object identity (so memoised
 * views, React and the canvas can skip them), and a patch that changes nothing returns `project` itself. Throws on a patch that does not fit
 * the project (the caller then re-reads the whole project).
 */
export function applyEditPatch(project: Project, patch: EditPatch): Project {
  let media = project.media;
  if (patch.media) media = patch.media;
  let sequences = project.sequences;
  for (const sp of patch.sequences) {
    const si = sequences.findIndex((s) => s.id === sp.id);
    if (si < 0) throw new Error("patch names an unknown sequence");
    const seq = sequences[si] as Sequence;
    const byId = new Map<string, Track>();
    for (const t of seq.tracks) byId.set(t.id, t);
    for (const tp of sp.tracks) byId.set(tp.id, patchTrack(byId.get(tp.id), tp));
    let tracks: Track[];
    if (sp.order) tracks = sp.order.map((id) => {
      const t = byId.get(id);
      if (!t) throw new Error("patch order names an unknown track");
      return t;
    });
    else tracks = seq.tracks.map((t) => byId.get(t.id) as Track);
    const unchanged = tracks.length === seq.tracks.length && tracks.every((t, i) => t === seq.tracks[i]);
    const next: Sequence = sp.shell ? { ...sp.shell, tracks: unchanged ? seq.tracks : tracks } : unchanged ? seq : { ...seq, tracks };
    if (next === seq) continue;
    if (sequences === project.sequences) sequences = sequences.slice();
    sequences[si] = next;
  }
  if (media === project.media && sequences === project.sequences) return project;
  return { ...project, media, sequences };
}
