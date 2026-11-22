import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * M1-016: the production web decoder in headless Chromium, in a Worker, on the demux fixtures (H.264/AAC MP4, MOV, fragmented MP4,
 * VFR MP4, VP9/Opus WebM): frame identity against an independent linear decode, random-order seeks, scrubbing cancellation, no leaked frames,
 * GPU-handle lifetime, audio length/frequency/resampling, and error messages. Needs `npm run build:wasm`.
 * Headless has software decode and no GPU: the latency numbers are reported, not asserted.
 */
const FIX = resolve("crates/media/tests/fixtures");
const NAMES = ["h264_aac.mp4", "h264_aac.mov", "frag.mp4", "vfr.mp4", "vp9_opus.webm"];
const TICKS = 705_600_000;

test("decodes the fixtures frame-accurately in a Worker, without leaking frames", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "decoder behaviour does not depend on the viewport");
  test.setTimeout(180_000);
  const bundle = await build({
    entryPoints: [resolve("tests/smoke/decode-harness.ts")],
    bundle: true, write: false, format: "esm", target: "es2022", platform: "browser",
    alias: { "@app/wasm-pkg": resolve("packages/engine-client/wasm-pkg/app_wasm.js") },
    logLevel: "silent",
  });
  const code = bundle.outputFiles[0]!.text;
  const b64 = (p: string) => readFileSync(p).toString("base64");
  const fixtures = Object.fromEntries(NAMES.map((n) => [n, b64(`${FIX}/${n}`)]));
  await page.goto("/");
  const res = await page.evaluate(async ({ code, wasm, fixtures }) => {
    const bin = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;
    const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    const w = new Worker(url, { type: "module" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const done = new Promise<{ ok: boolean; out?: Record<string, any>; error?: string }>((ok, bad) => { w.onmessage = (e) => ok(e.data); w.onerror = (e) => bad(new Error(e.message)); });
    w.postMessage({ wasm: bin(wasm), fixtures: Object.fromEntries(Object.entries(fixtures).map(([k, v]) => [k, bin(v)])) });
    return await done;
  }, { code, wasm: b64(resolve("packages/engine-client/wasm-pkg/app_wasm_bg.wasm")), fixtures });
  expect(res.error, res.error).toBeUndefined();
  const out = res.out!;
  console.log("decode numbers (headless, software decode, no GPU):", JSON.stringify(Object.fromEntries(NAMES.map((n) => [n, { frames: out[n].seeks.length, seekMs: out[n].seekMs }]))));

  for (const name of NAMES) {
    const r = out[name];
    const n = r.info.video.packets as number;
    expect(n, name).toBeGreaterThan(10);
    expect(r.seeks).toHaveLength(n);
    // Frame identity: index and pts are what was asked for, pts strictly increases with index, pixels match ffmpeg's frame i.
    const byIndex = [...r.seeks].sort((a: { i: number }, b: { i: number }) => a.i - b.i);
    byIndex.forEach((s: { i: number; index: number; pts: number; hash: string }, k: number) => {
      expect(s.index, `${name} #${k}`).toBe(s.i);
      if (k > 0) expect(s.pts, `${name} pts order #${k}`).toBeGreaterThan(byIndex[k - 1].pts);
      expect(s.hash, `${name}: seeked frame ${s.i} differs from the linear decode`).toBe(r.ref[s.i]);
    });
    expect(new Set(r.ref).size, `${name}: frames must be distinct for the identity check to mean something`).toBe(n);
    expect(r.ref, name).toHaveLength(n);
    if (name !== "vfr.mp4") expect(byIndex[1].pts - byIndex[0].pts, name).toBeGreaterThan(TICKS / 31 - 2); // ~30 fps steps
    // No leaks: every frame the decoder produced is closed once the results are released, also after cancelled work.
    expect(r.afterSeeks.open, `${name} open after seeks`).toBe(0);
    expect(r.afterSeeks.received, name).toBeGreaterThanOrEqual(n);
    expect(r.afterScrub.open, `${name} open after scrub`).toBe(0);
    // Scrubbing: last request wins, superseded ones are cancelled (not errors).
    expect(r.scrub.lastOk, name).toBe(true);
    expect(r.scrub.other, name).toEqual([]);
    expect(r.scrub.cancelled, `${name} cancelled seeks`).toBeGreaterThan(0);
    // GPU handles (VideoFrame) live until released.
    expect(r.gpuKind).toBe("gpu");
    expect(r.gpuHeld.instance, name).toBe(true);
    expect(r.gpuHeld.open, name).toBe(3);
    expect(r.gpuAfter.open, name).toBe(0);
    expect(r.gpuHeld.size[0][0], name).toBeGreaterThanOrEqual(160);
    if (r.audio) {
      const a = r.audio;
      expect(a.len48).toBe(4_800 * a.channels);
      expect(a.len44).toBe(4_410 * a.channels);
      expect(a.peak48).toBeGreaterThan(0.05);
      expect(a.peak44).toBeGreaterThan(0.05);
      // 440 Hz over 0.1 s = 44 cycles = about 88 zero crossings.
      expect(Math.abs(a.cross48 - 88), `${name} 48k crossings`).toBeLessThanOrEqual(4);
      expect(Math.abs(a.cross44 - 88), `${name} 44.1k crossings`).toBeLessThanOrEqual(4);
    }
  }
  // Range reads: a 64 MB file opens and seeks by reading a sliver of it.
  expect(out.big.size).toBeGreaterThan(64 * 1024 * 1024);
  expect(out.big.read, "bytes read from the big file").toBeLessThan(1024 * 1024);
  expect(out.big.h0 && out.big.h1).toBe(true);
  expect(out.errors.unsupported.kind).toBe("unsupported");
  expect(out.errors.unsupported.message).toContain("H.264");
  expect(out.errors.unsupported.message).toContain("avc1.ffffff");
  expect(out.errors.garbage.kind).toMatch(/unsupported|invalid/);
});
