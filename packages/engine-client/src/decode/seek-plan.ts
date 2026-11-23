import type { PacketJson } from "./blob-source";

/**
 * Pure helpers for the paused-seek decode (`WebCodecsHost.decodeVideo`): which packets of the keyframe-to-target run can be left
 * undecoded, and how the run is split so decoding starts before the whole GOP has been read.
 */

/** Length of the NAL size prefix of an AVCC (`avcC`) sample, from the decoder description; 4 when it is not AVC or unreadable. */
export function avcLengthSize(codec: string, description: Uint8Array): number {
  if (!/^avc[13]\./i.test(codec) || description.length < 5 || description[0] !== 1) return 0;
  return (description[4]! & 3) + 1;
}

/**
 * True when an AVC (length-prefixed) packet is a non-reference picture: its first slice NAL (type 1, non-IDR) has `nal_ref_idc` 0, so
 * no other picture predicts from it and skipping it cannot change any other decoded frame. Anything unclear (other NAL types such as
 * SVC/MVC extensions, truncated data, a bad length) answers false: decode it.
 */
export function isNonReferenceAvc(data: Uint8Array, lengthSize: number): boolean {
  if (lengthSize < 1 || lengthSize > 4) return false;
  let pos = 0;
  while (pos + lengthSize < data.length) {
    let len = 0;
    for (let i = 0; i < lengthSize; i++) len = len * 256 + data[pos + i]!;
    const header = data[pos + lengthSize]!;
    if (len < 1 || pos + lengthSize + len > data.length || (header & 0x80) !== 0) return false;
    const type = header & 0x1f;
    if (type === 1) return ((header >> 5) & 3) === 0;
    if (type !== 6 && type !== 9 && type !== 12) return false; // only SEI, AUD and filler may precede the slice
    pos += lengthSize + len;
  }
  return false;
}

/**
 * Indices of `packets` (one batch of the run) to decode: every packet except non-reference pictures. Keyframes are always kept, and
 * so is the last packet when `protectLast` (the run's target, which must be output). `lengthSize` 0 (not AVC) keeps everything.
 */
export function packetsToDecode(packets: readonly PacketJson[], bytes: readonly Uint8Array[], lengthSize: number, protectLast: boolean): number[] {
  const keep: number[] = [];
  const last = packets.length - 1;
  for (let i = 0; i <= last; i++) {
    const p = packets[i]!;
    if (p.key || lengthSize === 0 || (protectLast && i === last) || !isNonReferenceAvc(bytes[i]!, lengthSize)) keep.push(i);
  }
  return keep;
}

/**
 * Sizes of the consecutive read batches for a run of `count` packets: a small first batch (the keyframe plus a few), so the decoder
 * starts early, then growing ones, so one range read is never tiny. Sizes add up to `count`.
 */
export function readBatches(count: number): number[] {
  const out: number[] = [];
  let left = count;
  let size = 6;
  while (left > 0) {
    const n = Math.min(left, size);
    out.push(n);
    left -= n;
    size *= 3;
  }
  return out;
}
