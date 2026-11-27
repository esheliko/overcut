import type { Clip, MediaRef, Project, Sequence, Track } from "@app/engine-client";

/**
 * The project as the JSON the preview Worker opens (`openEvaluator`), built from cached pieces. An edit keeps every unchanged track and
 * clip object (`applyEditPatch`, ADR 0020), so only what the edit touched is stringified again: a split on a 2300-clip project stringifies two
 * clips and joins the rest, instead of walking the whole document. The result is plain JSON of the same document (key order differs from the engine's, which nothing reads).
 */
/** `head` is an unfinished object (no closing brace); append the other fields. */
const finish = (head: string, rest: object): string => {
  const r = JSON.stringify(rest);
  return r === "{}" ? `${head}}` : `${head},${r.slice(1)}`;
};
const clipJson = new WeakMap<Clip, string>();
const trackJson = new WeakMap<Track, string>();
const mediaJson = new WeakMap<MediaRef[], string>();

const clipOf = (c: Clip): string => {
  let s = clipJson.get(c);
  if (s === undefined) { s = JSON.stringify(c); clipJson.set(c, s); }
  return s;
};

/** The track's own fields are stringified without its clips, which come from the clip cache. */
const trackOf = (t: Track): string => {
  let s = trackJson.get(t);
  if (s === undefined) {
    const { clips, ...rest } = t;
    const parts = new Array<string>(clips.length);
    for (let i = 0; i < clips.length; i++) parts[i] = clipOf(clips[i]!);
    s = finish(`{"clips":[${parts.join(",")}]`, rest);
    trackJson.set(t, s);
  }
  return s;
};

const sequenceOf = (q: Sequence): string => {
  const { tracks, ...rest } = q;
  return finish(`{"tracks":[${tracks.map(trackOf).join(",")}]`, rest);
};

const mediaOf = (m: MediaRef[]): string => {
  let s = mediaJson.get(m);
  if (s === undefined) { s = JSON.stringify(m); mediaJson.set(m, s); }
  return s;
};

export function projectToJson(p: Project): string {
  const { sequences, media, ...rest } = p;
  return finish(`{"sequences":[${sequences.map(sequenceOf).join(",")}],"media":${mediaOf(media)}`, rest);
}
