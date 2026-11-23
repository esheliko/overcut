import test from "node:test";
import assert from "node:assert/strict";
import { avcLengthSize, isNonReferenceAvc, packetsToDecode, readBatches } from "../../packages/engine-client/src/decode/seek-plan";
import type { PacketJson } from "../../packages/engine-client/src/decode/blob-source";

/** One AVCC sample: each NAL as [header byte, ...payload] behind a 4-byte big-endian length. */
function sample(...nals: number[][]): Uint8Array {
  const out: number[] = [];
  for (const n of nals) out.push(0, 0, (n.length >> 8) & 255, n.length & 255, ...n);
  return Uint8Array.from(out);
}
const slice = (refIdc: number, type = 1) => [(refIdc << 5) | type, 0x88, 1, 2, 3];
const pkt = (key = false): PacketJson => ({ offset: 0, size: 0, key, ts: 0, dur: 0 });

test("avcLengthSize reads the NAL prefix size from avcC, and is 0 for anything else", () => {
  assert.equal(avcLengthSize("avc1.64001f", Uint8Array.from([1, 100, 0, 31, 0xff, 0xe1])), 4);
  assert.equal(avcLengthSize("avc1.64001f", Uint8Array.from([1, 100, 0, 31, 0xfd, 0xe1])), 2);
  assert.equal(avcLengthSize("hvc1.1.6.L93.B0", Uint8Array.from([1, 0, 0, 0, 0xff])), 0);
  assert.equal(avcLengthSize("avc1.64001f", new Uint8Array(0)), 0);
  assert.equal(avcLengthSize("avc1.64001f", Uint8Array.from([2, 0, 0, 0, 0xff])), 0);
});

test("a non-IDR slice with nal_ref_idc 0 is a non-reference picture; a referenced one is not", () => {
  assert.equal(isNonReferenceAvc(sample(slice(0)), 4), true);
  assert.equal(isNonReferenceAvc(sample(slice(2)), 4), false);
  assert.equal(isNonReferenceAvc(sample(slice(3, 5)), 4), false); // IDR
});

test("SEI, AUD and filler before the slice are skipped; other NAL types, truncation and bad lengths decode the packet", () => {
  assert.equal(isNonReferenceAvc(sample([6, 1, 2], [9, 0xf0], slice(0)), 4), true);
  assert.equal(isNonReferenceAvc(sample([20, 1, 2], slice(0)), 4), false); // SVC/MVC extension NAL
  assert.equal(isNonReferenceAvc(sample(slice(0)).subarray(0, 6), 4), false); // truncated
  assert.equal(isNonReferenceAvc(Uint8Array.from([0, 0, 0, 0, 1]), 4), false); // zero length
  assert.equal(isNonReferenceAvc(Uint8Array.from([0, 0, 0, 5, 0x80 | 1, 1]), 4), false); // forbidden_zero_bit set
  assert.equal(isNonReferenceAvc(new Uint8Array(0), 4), false);
  assert.equal(isNonReferenceAvc(sample(slice(0)), 0), false);
  assert.equal(isNonReferenceAvc(Uint8Array.from([0, 3, 0x01, 1, 2]), 2), true); // 2-byte prefix
});

test("packetsToDecode drops non-reference pictures but never a keyframe or the target", () => {
  const packets = [pkt(true), pkt(), pkt(), pkt(), pkt()];
  const bytes = [sample(slice(3, 5)), sample(slice(2)), sample(slice(0)), sample(slice(0)), sample(slice(0))];
  assert.deepEqual(packetsToDecode(packets, bytes, 4, true), [0, 1, 4]); // the last (target) stays although unreferenced
  assert.deepEqual(packetsToDecode(packets, bytes, 4, false), [0, 1]); // an earlier batch: nothing is protected but keyframes
  assert.deepEqual(packetsToDecode(packets, bytes, 0, true), [0, 1, 2, 3, 4]); // not AVC: decode everything
});

test("readBatches covers the run exactly, starting small and growing", () => {
  for (const n of [0, 1, 5, 6, 7, 24, 25, 78, 151, 400]) {
    const b = readBatches(n);
    assert.equal(b.reduce((a, x) => a + x, 0), n);
    assert.ok(b.every((x) => x > 0));
  }
  assert.deepEqual(readBatches(78), [6, 18, 54]);
  assert.deepEqual(readBatches(3), [3]);
  assert.deepEqual(readBatches(0), []);
});
