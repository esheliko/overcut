/** Duplicate, copy / cut / paste and numeric timing (TL-02): pure planning on top of the existing ops, so everything is `insert_clip`, `delete`,
 *  `trim_in` and `trim_out` through `Engine.editing` (ADR 0006), in integer ticks (ADR 0010). Nothing here touches the project. */
import type { Clip, Op, Project } from "@app/engine-client";

/** A copied clip and the track it came from. A deep copy: later edits to the project never change the clipboard. */
export interface Held { readonly track: string; readonly clip: Clip }

const sequenceOf = (p: Project) => p.sequences[0];

/** The clips with these ids, earliest first, as plain copies. */
export function copyClips(p: Project, ids: ReadonlySet<string>): Held[] {
  const out: Held[] = [];
  for (const tr of sequenceOf(p)?.tracks ?? []) for (const c of tr.clips) if (ids.has(c.id)) out.push({ track: tr.id, clip: structuredClone(c) });
  return out.sort((a, b) => a.clip.start - b.clip.start || (a.track < b.track ? -1 : 1));
}

export interface Placement { readonly ops: Op[]; readonly placed: number; readonly skipped: number; readonly start: number }

/**
 * Where `held` lands when its earliest clip starts at `at` (ticks). Each clip keeps its offset from the earliest one. The destination is
 * `targetTrack` when every held clip came from ONE track and that track is unlocked and of the same kind, else each clip's own track
 * (skipped when it is gone, locked, or the kind does not fit). If anything would overlap, the whole group moves later to the next free slot
 * (never overwrites, never splits the group). `newId` supplies the 32-hex ids of the copies.
 */
export function planPlacement(p: Project, held: readonly Held[], at: number, targetTrack: string | null, newId: () => string): Placement {
  const tracks = sequenceOf(p)?.tracks ?? [];
  const byId = new Map(tracks.map((t) => [t.id, t]));
  if (held.length === 0) return { ops: [], placed: 0, skipped: 0, start: at };
  const sources = new Set(held.map((h) => h.track));
  const retarget = targetTrack !== null && sources.size === 1 ? byId.get(targetTrack) : undefined;
  const from = byId.get(held[0]!.track);
  const useTarget = retarget && !retarget.locked && (!from || from.kind === retarget.kind) ? retarget : undefined;

  const items: { track: string; clip: Clip }[] = [];
  let skipped = 0;
  for (const h of held) {
    const dest = useTarget ?? byId.get(h.track);
    const src = byId.get(h.track);
    if (!dest || dest.locked || (src && src.kind !== dest.kind)) { skipped++; continue; }
    items.push({ track: dest.id, clip: h.clip });
  }
  if (items.length === 0) return { ops: [], placed: 0, skipped, start: at };

  const anchor = Math.min(...items.map((i) => i.clip.start));
  let shift = Math.max(at, 0) - anchor;
  // Slide later until nothing overlaps: a blocker on a destination track pushes the group to just after it. Each pass passes at least one clip, so it ends.
  for (let pass = 0; pass <= tracks.reduce((n, t) => n + t.clips.length, 0) + 1; pass++) {
    let bump = shift;
    for (const it of items) {
      const s = it.clip.start + shift, e = s + it.clip.duration;
      for (const other of byId.get(it.track)!.clips) {
        if (other.start < e && other.start + other.duration > s) bump = Math.max(bump, other.start + other.duration - it.clip.start);
      }
    }
    if (bump === shift) break;
    shift = bump;
  }
  // Copies of a linked pair are linked to each other (one new link per original link); a clip whose partner was not copied stands alone.
  const uses = new Map<string, number>();
  for (const it of items) if (it.clip.link) uses.set(it.clip.link, (uses.get(it.clip.link) ?? 0) + 1);
  const links = new Map<string, string>();
  const ops: Op[] = items.map((it) => {
    const { link, ...rest } = it.clip;
    const copy: Clip = { ...rest, id: newId(), start: it.clip.start + shift };
    if (link && uses.get(link)! > 1) { if (!links.has(link)) links.set(link, newId()); copy.link = links.get(link)!; }
    return { op: "insert_clip", track: it.track, clip: copy };
  });
  return { ops, placed: items.length, skipped, start: anchor + shift };
}

/** Where a duplicate of `held` goes: right after the group's last end (the earliest start moved to there), then the next free slot. */
export const duplicateAt = (held: readonly Held[]): number => Math.max(...held.map((h) => h.clip.start + h.clip.duration));

/** Track to paste into: the track of the first selected clip, else null (the clips' own tracks). */
export function selectedTrack(p: Project, selection: ReadonlySet<string>): string | null {
  for (const tr of sequenceOf(p)?.tracks ?? []) for (const c of tr.clips) if (selection.has(c.id)) return tr.id;
  return null;
}

/** One clip's timeline span, as the numeric fields show it. */
export interface Span { readonly start: number; readonly end: number }

export type TimingField = "start" | "end" | "duration";
export type TimingResult = { ok: true; ops: Op[] } | { ok: false; reason: "invalid" | "range"; min: number; max: number };

/**
 * The trim that makes `field` read `ticks`: start = new first frame on the timeline (end stays), end = new last boundary (start stays),
 * duration = new length (start stays). `range` is the allowed span for that boundary (from `trimRange`, neighbours and source length).
 */
export function timingOps(clip: string, span: Span, field: TimingField, ticks: number, startRange: { min: number; max: number }, endRange: { min: number; max: number }): TimingResult {
  const edge = field === "start" ? "start" : "end";
  const value = field === "duration" ? span.start + ticks : ticks;
  const r = edge === "start" ? startRange : endRange;
  if (!Number.isSafeInteger(ticks) || ticks < 0) return { ok: false, reason: "invalid", min: r.min, max: r.max };
  if (value < r.min || value > r.max) return { ok: false, reason: "range", min: r.min, max: r.max };
  if (value === (edge === "start" ? span.start : span.end)) return { ok: true, ops: [] };
  return { ok: true, ops: [edge === "start" ? { op: "trim_in", clip, start: value } : { op: "trim_out", clip, end: value }] };
}
