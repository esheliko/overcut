/**
 * Scrub strip storage: JPEG stand-ins packed in segments of a few seconds, kept in a dedicated `MediaCache` (OPFS, LRU with a byte cap), keyed by the
 * source fingerprint and the strip's shape. A manifest lists the finished segments, so a build resumes where it stopped and a reload reuses the work.
 * Everything here is derived data: losing it costs a rebuild, never correctness.
 */
import type { MediaCache } from "../../media/cache";
import type { StripSpec } from "./policy";

export const STRIP_VERSION = 1;
export const STRIP_CAP_DEFAULT = 512 * 1024 * 1024;

export interface Manifest { v: number; spec: StripSpec; frames: number; done: number[] }

export const baseKey = (fp: string, spec: StripSpec): string => `strip/${fp}/v${STRIP_VERSION}-${spec.w}x${spec.h}-s${spec.stride}-q${Math.round(spec.quality * 100)}`;
export const manifestKey = (base: string): string => `${base}/m`;
export const segmentKey = (base: string, seg: number): string => `${base}/${seg}`;
export const segmentOf = (index: number, spec: StripSpec): number => Math.floor(index / spec.segFrames);
export const segmentCount = (frames: number, spec: StripSpec): number => Math.ceil(frames / spec.segFrames);

const MAGIC = 0x53545031; // "STP1"

/** One segment: header (magic, first frame, stride, count), then count + 1 byte offsets, then the JPEGs back to back. */
export function packSegment(first: number, stride: number, jpegs: readonly Uint8Array[]): Uint8Array {
  const head = 16 + 4 * (jpegs.length + 1);
  let size = head;
  for (const j of jpegs) size += j.length;
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  v.setUint32(0, MAGIC);
  v.setUint32(4, first);
  v.setUint32(8, stride);
  v.setUint32(12, jpegs.length);
  let at = 0;
  jpegs.forEach((j, i) => { v.setUint32(16 + 4 * i, at); out.set(j, head + at); at += j.length; });
  v.setUint32(16 + 4 * jpegs.length, at);
  return out;
}

export interface Segment {
  first: number;
  stride: number;
  count: number;
  /** The JPEG of stored frame number `slot` (source frame `first + slot * stride`), a view into the segment (no copy). */
  jpeg(slot: number): Uint8Array | undefined;
}

export function unpackSegment(bytes: Uint8Array): Segment | null {
  if (bytes.length < 20) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint32(0) !== MAGIC) return null;
  const first = v.getUint32(4);
  const stride = v.getUint32(8);
  const count = v.getUint32(12);
  const head = 16 + 4 * (count + 1);
  if (stride < 1 || bytes.length < head || v.getUint32(16 + 4 * count) !== bytes.length - head) return null;
  return {
    first, stride, count,
    jpeg: (slot) => (slot >= 0 && slot < count ? bytes.subarray(head + v.getUint32(16 + 4 * slot), head + v.getUint32(16 + 4 * (slot + 1))) : undefined),
  };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function loadManifest(cache: MediaCache, base: string, spec: StripSpec, frames: number): Promise<Manifest> {
  const fresh: Manifest = { v: STRIP_VERSION, spec, frames, done: [] };
  const bytes = await cache.get(manifestKey(base));
  if (!bytes) return fresh;
  try {
    const m = JSON.parse(dec.decode(bytes)) as Manifest;
    if (m.v !== STRIP_VERSION || m.frames !== frames || !Array.isArray(m.done)) return fresh;
    // A segment the cache evicted is not done: the builder tops it up.
    const live: number[] = [];
    for (const s of m.done) if (await cache.has(segmentKey(base, s))) live.push(s);
    return { ...m, spec, done: live };
  } catch { return fresh; }
}

export async function saveManifest(cache: MediaCache, base: string, m: Manifest): Promise<void> {
  await cache.put(manifestKey(base), enc.encode(JSON.stringify(m)));
}
