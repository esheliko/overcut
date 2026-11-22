import test from "node:test";
import assert from "node:assert/strict";
import { codecName, MediaDecodeError, toMediaError, unsupported } from "../../packages/engine-client/src/decode/errors";
import { readPackets, type ByteSource } from "../../packages/engine-client/src/decode/blob-source";
import { assemble } from "../../packages/engine-client/src/decode/resample";

test("media errors: the engine's {kind,message} JSON becomes a typed error; anything else is io", () => {
  const e = toMediaError(JSON.stringify({ kind: "unsupported", message: "no HEVC" }));
  assert.ok(e instanceof MediaDecodeError);
  assert.equal(e.kind, "unsupported");
  assert.equal(toMediaError(JSON.stringify({ kind: "cancelled", message: "cancelled" })).kind, "cancelled");
  assert.equal(toMediaError(JSON.stringify({ kind: "weird", message: "x" })).kind, "io");
  assert.equal(toMediaError("boom").message, "boom");
  assert.equal(toMediaError(new Error("bad")).kind, "io");
});

test("an unsupported codec is named in plain words and by its string", () => {
  assert.equal(codecName("hvc1.1.6.L93.B0"), "H.265 (HEVC)");
  assert.equal(codecName("avc1.64001f"), "H.264");
  assert.equal(codecName("mp4a.40.2"), "AAC");
  assert.equal(codecName("weird"), "weird");
  const m = unsupported("video", "hvc1.1.6.L93.B0").message;
  assert.match(m, /H\.265 \(HEVC\) video \(hvc1\.1\.6\.L93\.B0\)/);
});

function source(size: number, log: [number, number][]): ByteSource {
  return {
    length: size,
    read: async (offset, len) => {
      log.push([offset, len]);
      return Uint8Array.from({ length: Math.min(len, size - offset) }, (_, i) => (offset + i) % 251);
    },
  };
}
const pk = (offset: number, size: number) => ({ offset, size, key: true, ts: 0, dur: 0 });

test("readPackets: a contiguous GOP is one range read, with every packet cut to its own bytes", async () => {
  const log: [number, number][] = [];
  const out = await readPackets(source(10_000, log), [pk(100, 50), pk(150, 30), pk(180, 20)], () => false);
  assert.deepEqual(log, [[100, 100]]);
  assert.deepEqual(out.map((b) => b.length), [50, 30, 20]);
  assert.equal(out[1]![0], 150 % 251);
});

test("readPackets: far-apart packets are read separately, never the gap between them", async () => {
  const log: [number, number][] = [];
  await readPackets(source(1_000_000, log), [pk(0, 100), pk(900_000, 100)], () => false);
  assert.deepEqual(log, [[0, 100], [900_000, 100]]);
});

test("readPackets: stops between reads when the request went stale; a short file is an error", async () => {
  let stale = false;
  const log: [number, number][] = [];
  const s = source(1_000_000, log);
  const base = s.read;
  s.read = async (o, l) => { stale = true; return base(o, l); };
  await assert.rejects(readPackets(s, [pk(0, 100), pk(900_000, 100)], () => stale), { name: "AbortError" });
  assert.equal(log.length, 1);
  await assert.rejects(readPackets(source(120, []), [pk(100, 50)], () => false), /ended in the middle/);
});

test("assemble: same rate is a bit-exact copy placed by timestamp; gaps and the tail are silence", () => {
  const ramp = (from: number, n: number) => Float32Array.from({ length: n }, (_, i) => (from + i) / 1000);
  // two 100-sample blocks at 48 kHz, the second starting 100 samples later; ask for 250 from sample 1000 (block 0 starts at 1000)
  const t = (s: number) => (s * 1e6) / 48000;
  const out = assemble([{ ts: t(1000), planes: [ramp(0, 100)] }, { ts: t(1100), planes: [ramp(100, 100)] }], 48000, 1, 1000, 250, 48000);
  assert.equal(out.length, 250);
  assert.equal(out[0], 0);
  assert.equal(out[150], Math.fround(0.15));
  assert.equal(out[199], Math.fround(0.199));
  assert.equal(out[200], 0);
});

test("assemble: the opus shift moves content later; resampling keeps pitch and length; channels interleave", () => {
  const sine = (rate: number, n: number) => Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / rate));
  const mid = assemble([{ ts: 0, planes: [Float32Array.of(1, 2, 3)] }], 48000, 1, 0, 6, 48000, 2);
  assert.deepEqual([...mid], [0, 0, 1, 2, 3, 0]);
  const y = assemble([{ ts: 0, planes: [sine(48000, 5000)] }], 48000, 1, 0, 4410, 44100);
  let c = 0;
  for (let i = 1; i < y.length; i++) if ((y[i - 1]! < 0) !== (y[i]! < 0)) c++;
  assert.ok(Math.abs(c - 88) <= 2, `crossings ${c}`);
  const st = assemble([{ ts: 0, planes: [Float32Array.of(1, 2), Float32Array.of(-1, -2)] }], 48000, 2, 0, 2, 48000);
  assert.deepEqual([...st], [1, -1, 2, -2]);
});
