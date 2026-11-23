import type { PacketJson } from "./blob-source";

/** Ticks per microsecond is 705.6; kept as an integer ratio so conversions never touch floats beyond the final floor (ADR 0010). */
const TICKS_PER_SECOND = 705_600_000;

/** Microseconds (the host's unique presentation timestamps) to ticks, rounded to nearest. */
export const usToTicks = (us: number): number => Math.round((us * 7056) / 10);

/** Ticks to microseconds, floored. */
export const ticksToUs = (ticks: number): number => Math.floor((ticks * 10) / 7056);

/**
 * The video track as the playback layer needs it: presentation timestamps in order (frame `i` of the media is `pts[i]`), the packet
 * table in decode order, and the decode position of every frame's first needed keyframe.
 */
export interface FrameTable {
  /** Presentation timestamps (microseconds), ascending: index = the frame number `videoFrame(index)` takes. */
  pts: Float64Array;
  /** Packets in decode order. */
  packets: readonly PacketJson[];
  /** Decode-order position of each keyframe. */
  keys: Int32Array;
}

export function buildFrameTable(packets: readonly PacketJson[]): FrameTable {
  const pts = Float64Array.from(packets, (p) => p.ts).sort();
  const keys: number[] = [];
  packets.forEach((p, i) => { if (p.key) keys.push(i); });
  return { pts, packets, keys: Int32Array.from(keys) };
}

/**
 * The frame to show at source time `ticks`: the last frame whose timestamp is not after it (so a VFR clip holds each frame for its
 * real duration instead of assuming a constant rate), clamped to the stream. 0 before the first frame; the last frame at and past the end.
 */
export function frameIndexAt(table: FrameTable, ticks: number): number {
  const n = table.pts.length;
  if (n === 0) return 0;
  const us = ticksToUs(ticks);
  let lo = 0;
  let hi = n; // first index with pts > us
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (table.pts[mid]! <= us) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo - 1);
}

/** Decode-order position to start from so frame `index` can be decoded: the latest keyframe not after it by timestamp (open-GOP safe). */
export function startPacket(table: FrameTable, index: number): number {
  const target = table.pts[Math.min(Math.max(index, 0), table.pts.length - 1)] ?? 0;
  let start = 0;
  for (let k = 0; k < table.keys.length; k++) {
    const i = table.keys[k]!;
    if (table.packets[i]!.ts <= target) start = i;
    else break;
  }
  return start;
}

/** True when frame timestamps are not a constant step (a phone clip): the player then selects frames by timestamp, never by index arithmetic. */
export function isVariable(table: FrameTable): boolean {
  const n = table.pts.length;
  if (n < 3) return false;
  const first = table.pts[1]! - table.pts[0]!;
  for (let i = 2; i < n; i++) if (Math.abs(table.pts[i]! - table.pts[i - 1]! - first) > Math.max(2, first * 0.02)) return true;
  return false;
}

export const SECOND_TICKS = TICKS_PER_SECOND;
