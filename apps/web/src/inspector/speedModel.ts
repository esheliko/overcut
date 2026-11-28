/** Pure logic of the Speed section (`docs/features/speed.md`): which clips a speed edit covers, and the ops that carry it. */
import type { Clip, Op, Project, Rational } from "@app/engine-client";

export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;
export const SPEED_PRESETS = [0.5, 1, 1.5, 2] as const;

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** Playback speed as a number (1 = normal). */
export const speedOf = (c: Pick<Clip, "speed">): number => (c.speed ? c.speed.num / c.speed.den : 1);

/** A typed speed as the exact ratio the engine takes: rounded to two decimals, reduced; null when it is not a number in 0.25 to 4. */
export function toRational(x: number): Rational | null {
  if (!Number.isFinite(x)) return null;
  const num = Math.round(x * 100);
  if (num < MIN_SPEED * 100 || num > MAX_SPEED * 100) return null;
  const g = gcd(num, 100);
  return { num: num / g, den: 100 / g };
}

/** "1.5×", "0.25×": at most two decimals, no trailing zeros. */
export const formatSpeed = (x: number): string => `${Number(x.toFixed(2))}×`;

/** The selected clip with the clips linked to it (its picture and its sound), or null when the selection is not exactly one clip or one link. */
export function speedTarget(project: Project | null, selection: ReadonlySet<string>): { clip: Clip; group: Clip[]; still: boolean } | null {
  const seq = project?.sequences[0];
  if (!project || !seq || selection.size === 0) return null;
  const picked: Clip[] = [];
  for (const tr of seq.tracks) for (const c of tr.clips) if (selection.has(c.id)) picked.push(c);
  const first = picked[0];
  if (!first) return null;
  const link = first.link ?? null;
  if (picked.length > 1 && !(link && picked.every((c) => c.link === link))) return null;
  const group = link ? seq.tracks.flatMap((t) => t.clips).filter((c) => c.link === link) : [first];
  const still = project.media.find((m) => m.id === first.media)?.kind === "image";
  return { clip: first, group, still };
}

/** One `set_clip_speed` per clip of the group, in one undo step (the caller sends the array). */
export const speedOps = (group: readonly Clip[], speed: Rational, ripple: boolean): Op[] => group.map((c) => ({ op: "set_clip_speed", clip: c.id, speed, ripple }));

const TICKS = 705_600_000;
const tcOf = (ticks: number): string => { const sec = ticks / TICKS; return `${Math.floor(sec / 60)}:${(sec % 60).toFixed(2).padStart(5, "0")}`; };

/** The clip as the status line should read it after an edit: same fields as the timeline's own "name, track, from to" announcement, read from the project so the new span (after a speed change) is what is spoken. Null when the clip is gone. */
export function clipSpan(project: Project | null, clipId: string): { name: string; track: string; from: string; to: string } | null {
  const seq = project?.sequences[0];
  if (!project || !seq) return null;
  for (const tr of seq.tracks) {
    const c = tr.clips.find((x) => x.id === clipId);
    if (c) return { name: project.media.find((m) => m.id === c.media)?.name ?? c.media, track: tr.name, from: tcOf(c.start), to: tcOf(c.start + c.duration) };
  }
  return null;
}
