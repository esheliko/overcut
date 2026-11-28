import assert from "node:assert/strict";
import { test } from "node:test";
import { isPcm, pcmPlanes } from "../../packages/engine-client/src/decode/host";

test("pcmPlanes: 16-bit stereo is deinterleaved to full-scale f32", () => {
  const b = new Uint8Array(new Int16Array([32767, -32768, 0, 16384]).buffer);
  const [l, r] = pcmPlanes("pcm-s16", 2, b);
  assert.equal(l!.length, 2);
  assert.ok(Math.abs(l![0]! - 32767 / 32768) < 1e-9);
  assert.equal(r![0], -1);
  assert.equal(l![1], 0);
  assert.equal(r![1], 0.5);
});

test("pcmPlanes: 8-bit unsigned, 24-bit, 32-bit and float", () => {
  assert.deepEqual([...pcmPlanes("pcm-u8", 1, new Uint8Array([128, 255, 0]))[0]!], [0, 127 / 128, -1]);
  // 24-bit little endian: 0x400000 = +0.5, 0xC00000 = -0.5
  const s24 = pcmPlanes("pcm-s24", 1, new Uint8Array([0x00, 0x00, 0x40, 0x00, 0x00, 0xc0]))[0]!;
  assert.deepEqual([...s24], [0.5, -0.5]);
  assert.deepEqual([...pcmPlanes("pcm-s32", 1, new Uint8Array(new Int32Array([1 << 30]).buffer))[0]!], [0.5]);
  assert.deepEqual([...pcmPlanes("pcm-f32", 1, new Uint8Array(new Float32Array([0.25, -1]).buffer))[0]!], [0.25, -1]);
});

test("pcmPlanes: a trailing partial frame is dropped, and only pcm- codecs are PCM", () => {
  assert.equal(pcmPlanes("pcm-s16", 2, new Uint8Array(6))[0]!.length, 1);
  assert.ok(isPcm("pcm-s16"));
  assert.ok(!isPcm("mp3") && !isPcm("opus"));
});
