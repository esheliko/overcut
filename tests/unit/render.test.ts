import assert from "node:assert/strict";
import { test } from "node:test";
import { layerOf, wrapRenderer, type GpuLayer, type RawGpuRenderer } from "../../packages/engine-client/src/render";

/** Records what the wrapper sends to the generated class. */
function fakeRaw() {
  const calls: unknown[][] = [];
  const raw: RawGpuRenderer = {
    info: () => JSON.stringify({ backend: "webgl2", accum: "float16", adapter: "fake" }),
    alloc_stats: () => JSON.stringify({ textures: 1, buffers: 2, bind_groups: 3 }),
    resize: (w, h) => calls.push(["resize", w, h]),
    begin: () => calls.push(["begin"]),
    add_rgba: (rgba, w, h, p) => calls.push(["rgba", rgba.length, w, h, [...p]]),
    add_external: (_s, w, h, p) => calls.push(["external", w, h, [...p]]),
    render: (...a) => calls.push(["render", ...a]),
    read_rgba8: async (sw, sh, ow, oh, dest) => { calls.push(["read", sw, sh, ow, oh, dest.length]); dest.fill(7); },
    free: () => calls.push(["free"]),
  };
  return { raw, calls };
}

const layer = (over: Partial<GpuLayer> = {}): GpuLayer => ({ source: { rgba: new Uint8Array(16) }, width: 2, height: 2, rotation: 90, center: [10, 20], scale: [1.5, 2], angle: 0.5, opacity: 2, ...over });

test("present: layers are packed in order with clamped opacity and drawn at the canvas size", () => {
  const { raw, calls } = fakeRaw();
  const r = wrapRenderer(raw, { width: 1, height: 1 });
  r.resize(320.4, 180);
  r.present([layer(), layer({ source: {} as unknown as VideoFrame, opacity: -1 })], { width: 1920, height: 1080 });
  assert.deepEqual(calls, [
    ["resize", 320, 180],
    ["begin"],
    ["rgba", 16, 2, 2, [10, 20, 1.5, 2, 0.5, 1, 90]],
    ["external", 2, 2, [10, 20, 1.5, 2, 0.5, 0, 90]],
    ["render", 1920, 1080, 320, 180, true],
  ]);
  assert.equal(r.info.backend, "webgl2");
  assert.deepEqual(r.allocStats(), { textures: 1, buffers: 2, bind_groups: 3 });
});

test("readback reuses one buffer per output size and does not touch the canvas", async () => {
  const { raw, calls } = fakeRaw();
  const r = wrapRenderer(raw, { width: 64, height: 64 });
  const a = await r.readback([layer()], { width: 100, height: 50 }, { width: 8, height: 4 });
  const b = await r.readback([layer()], { width: 100, height: 50 }, { width: 8, height: 4 });
  assert.equal(a.length, 8 * 4 * 4);
  assert.equal(a, b, "same buffer");
  assert.equal(a[0], 7);
  assert.deepEqual(calls.filter((c) => c[0] === "read")[0], ["read", 100, 50, 8, 4, 128]);
  assert.ok(!calls.some((c) => c[0] === "resize"));
  const c = await r.readback([], { width: 100, height: 50 }, { width: 2, height: 2 });
  assert.equal(c.length, 16);
});

test("layerOf maps an evaluated layer and a decoded picture to one compositor layer", () => {
  const l = layerOf({ transform: { center: [960, 540], scale: [0.5, 0.5], rotation: 0.25 }, opacity: 0.8 }, { source: { rgba: new Uint8Array(4) }, width: 1, height: 1, rotation: 270 });
  assert.deepEqual({ ...l, source: undefined }, { source: undefined, width: 1, height: 1, rotation: 270, center: [960, 540], scale: [0.5, 0.5], angle: 0.25, opacity: 0.8 });
  assert.equal(layerOf({ transform: { center: [0, 0], scale: [1, 1], rotation: 0 }, opacity: 1 }, { source: { rgba: new Uint8Array(4) }, width: 1, height: 1 }).rotation, 0);
});

test("containScale fits a picture inside the canvas without cropping; layerOf applies it only when given a canvas", async () => {
  const { containScale } = await import("../../packages/engine-client/src/render");
  assert.equal(containScale({ width: 1920, height: 1080 }, { width: 1920, height: 1080 }), 1, "same size: untouched");
  assert.equal(containScale({ width: 1920, height: 1080 }, { width: 1080, height: 1920 }), 1080 / 1920, "landscape clip on a vertical canvas: pillar width fits");
  assert.equal(containScale({ width: 1080, height: 1920 }, { width: 1920, height: 1080 }), 1080 / 1920, "vertical clip on a landscape canvas: height fits");
  assert.equal(containScale({ width: 1080, height: 1920, rotation: 90 }, { width: 1920, height: 1080 }), 1, "a sideways-stored phone clip is judged by its upright size");
  assert.equal(containScale({ width: 960, height: 540 }, { width: 1920, height: 1080 }), 2, "a smaller clip is enlarged to fit");
  const t = { transform: { center: [540, 960] as [number, number], scale: [1, 1] as [number, number], rotation: 0 }, opacity: 1 };
  const pic = { source: { rgba: new Uint8Array(4) }, width: 1920, height: 1080 };
  assert.deepEqual(layerOf(t, pic).scale, [1, 1]);
  assert.deepEqual(layerOf(t, pic, { width: 1080, height: 1920 }).scale, [1080 / 1920, 1080 / 1920]);
});
