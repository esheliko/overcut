/** Pure logic of clip volume and fades (`docs/features/clip-audio.md`): which clip a volume edit lands on, the ops, and the limits the UI keeps.
 *  Shared by the Details Audio tab, the timeline's volume line and fade handles, and the clip menu's Mute. */
import type { Clip, ClipAudio, Op, Project } from "@app/engine-client";

export const TICKS = 705_600_000;
/** Loudest a clip can be set to: 200%. */
export const MAX_VOLUME = 2;
/** What "Mute clip" brings back when the clip had no level of its own to remember (a muted clip that was loaded that way). */
export const DEFAULT_VOLUME = 1;
/** Fades move in steps of 10 ms: a value the field shows exactly and a tick count that is a whole number. */
export const FADE_STEP_TICKS = TICKS / 100;
/** Snap radius of the volume line around 100% (volume units): the line "clicks" onto the original level. */
export const SNAP_VOLUME = 0.03;

export interface AudioValues { volume: number; fadeIn: number; fadeOut: number }

export const audioOf = (c: Pick<Clip, "audio">): AudioValues => ({ volume: c.audio?.volume ?? 1, fadeIn: c.audio?.fade_in ?? 0, fadeOut: c.audio?.fade_out ?? 0 });

/** The most a fade may be: half the clip, in ticks, on the 10 ms grid. Both fades at the maximum meet in the middle and never overlap. */
export const maxFadeTicks = (duration: number): number => Math.floor(duration / 2 / FADE_STEP_TICKS) * FADE_STEP_TICKS;

/** Clamp and round to what the engine takes: volume 0..2 to whole percent, fades 0..half the clip on the 10 ms grid. */
export function clampAudio(v: AudioValues, duration: number): AudioValues {
  const max = maxFadeTicks(duration);
  const fade = (x: number) => Math.min(max, Math.max(0, Math.round(x / FADE_STEP_TICKS) * FADE_STEP_TICKS));
  return { volume: Math.min(MAX_VOLUME, Math.max(0, Math.round(v.volume * 100) / 100)), fadeIn: fade(v.fadeIn), fadeOut: fade(v.fadeOut) };
}

/** The wire form of a value set (the engine does not write defaults, so a plain clip stays plain in the file). */
export const toAudio = (v: AudioValues): ClipAudio => ({ volume: v.volume, fade_in: v.fadeIn, fade_out: v.fadeOut });

/** One `set_clip_audio`. Edits that share a coalescing key are one undo step (a slider drag, a field session). */
export const audioOp = (clip: Clip, next: AudioValues): Op => ({ op: "set_clip_audio", clip: clip.id, audio: toAudio(clampAudio(next, clip.duration)) });

export const isSame = (a: AudioValues, b: AudioValues): boolean => a.volume === b.volume && a.fadeIn === b.fadeIn && a.fadeOut === b.fadeOut;

/** The clip that carries the sound of the selection: the selected audio clip, or the audio clip linked to the selected picture. Null when the
 *  selection is not exactly one such clip (or one picture-and-sound pair), or a picture has no sound. */
export function soundTarget(project: Project | null, selection: ReadonlySet<string>): { clip: Clip; track: string; picture: Clip | null } | null {
  const seq = project?.sequences[0];
  if (!seq || selection.size === 0) return null;
  const picked: { clip: Clip; kind: string; track: string }[] = [];
  for (const tr of seq.tracks) for (const c of tr.clips) if (selection.has(c.id)) picked.push({ clip: c, kind: tr.kind, track: tr.id });
  const sounds = picked.filter((p) => p.kind === "audio");
  const pictures = picked.filter((p) => p.kind !== "audio");
  if (sounds.length === 1 && (pictures.length === 0 || (pictures.length === 1 && pictures[0]!.clip.link && pictures[0]!.clip.link === sounds[0]!.clip.link))) return { clip: sounds[0]!.clip, track: sounds[0]!.track, picture: pictures[0]?.clip ?? null };
  if (sounds.length === 0 && pictures.length === 1) {
    const pic = pictures[0]!.clip;
    if (!pic.link) return null;
    for (const tr of seq.tracks) {
      if (tr.kind !== "audio") continue;
      const s = tr.clips.find((c) => c.link === pic.link && c.id !== pic.id);
      if (s) return { clip: s, track: tr.id, picture: pic };
    }
  }
  return null;
}

/** Every clip in the selection that has sound of its own to mute: audio clips, and a picture's linked sound (the picture itself has none). */
export function mutableSounds(project: Project | null, selection: ReadonlySet<string>): Clip[] {
  const seq = project?.sequences[0];
  if (!seq || selection.size === 0) return [];
  const links = new Set<string>();
  for (const tr of seq.tracks) if (tr.kind !== "audio") for (const c of tr.clips) if (selection.has(c.id) && c.link) links.add(c.link);
  const out: Clip[] = [];
  for (const tr of seq.tracks) if (tr.kind === "audio") for (const c of tr.clips) if (selection.has(c.id) || (c.link && links.has(c.link))) out.push(c);
  return out;
}

/** The memory of "Mute clip": the level a muted clip had before (per clip, for this session), so Unmute brings it back. */
const before = new Map<string, number>();
export const rememberLevel = (id: string, v: number): void => { if (v > 0) before.set(id, v); };
export const levelBeforeMute = (id: string): number => before.get(id) ?? DEFAULT_VOLUME;

/** Mute (volume 0, remembering the old level) or unmute (back to the remembered level) every sound in `sounds`: muted only when all of them already are. One op per clip. */
export function muteOps(sounds: readonly Clip[]): { ops: Op[]; muting: boolean } {
  const muting = sounds.some((c) => audioOf(c).volume > 0);
  const ops: Op[] = [];
  for (const c of sounds) {
    const a = audioOf(c);
    if (muting) { if (a.volume === 0) continue; rememberLevel(c.id, a.volume); ops.push(audioOp(c, { ...a, volume: 0 })); }
    else ops.push(audioOp(c, { ...a, volume: levelBeforeMute(c.id) }));
  }
  return { ops, muting };
}

/** "60%" for a volume, "1.25" for seconds: no trailing zeros. */
export const percent = (volume: number): number => Math.round(volume * 100);
export const seconds = (ticks: number): number => Math.round((ticks / TICKS) * 100) / 100;
