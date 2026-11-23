import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FILTER, allTags, binMeta, cleanTag, viewBin, windowRange, withTag, withoutTag } from "../../apps/web/src/media/binView";
import type { Project } from "../../packages/engine-client/src/model.generated";

type BinItem = { id: string; name: string; kind: "video" | "audio" | "image"; durationTicks: number | null; status: string };
const item = (id: string, name: string, kind: BinItem["kind"], durationTicks: number | null = null): BinItem => ({ id, name, kind, status: "ready", durationTicks });
const proj = (media: { id: string; tags?: string[] }[]) => ({ media } as unknown as Project);
const ITEMS = [item("a", "clip10.mp4", "video", 300), item("b", "clip2.mp4", "video", 900), item("c", "song.wav", "audio", 600), item("d", "photo.jpg", "image")];
const META = binMeta(proj([{ id: "a", tags: ["B-roll"] }, { id: "b", tags: ["Interview", "b-roll"] }, { id: "c" }, { id: "d", tags: ["b-roll"] }]));
const ids = (f: Partial<typeof DEFAULT_FILTER>, items = ITEMS) => viewBin(items, META, { ...DEFAULT_FILTER, ...f }).map((i) => i.id);

test("type filter, tag filter (any case) and search by name or tag", () => {
  assert.deepEqual(ids({ kind: "video" }), ["b", "a"]);
  assert.deepEqual(ids({ kind: "audio" }), ["c"]);
  assert.deepEqual(ids({ kind: "image" }), ["d"]);
  assert.deepEqual(ids({ tag: "b-roll" }), ["d", "b", "a"]);
  assert.deepEqual(ids({ tag: "interview", kind: "video" }), ["b"]);
  assert.deepEqual(ids({ query: "SONG" }), ["c"]);
  assert.deepEqual(ids({ query: "interv" }), ["b"], "search finds tags too");
  assert.deepEqual(ids({ query: "zzz" }), []);
});

test("sorts: added (newest first), name (numbers in order), duration (longest first, stills last)", () => {
  assert.deepEqual(ids({}), ["d", "c", "b", "a"]);
  assert.deepEqual(ids({ sort: "name" }), ["b", "a", "d", "c"]);
  assert.deepEqual(ids({ sort: "duration" }), ["b", "c", "a", "d"]);
});

test("items still being read or refused stay on top whatever the filter", () => {
  const probing: BinItem = { ...item("p", "new.mp4", "video"), status: "probing" };
  assert.deepEqual(ids({ kind: "audio" }, [probing, ...ITEMS]), ["p", "c"]);
});

test("tag helpers: trimmed, unique in any case, bounded; the tag list in use", () => {
  assert.equal(cleanTag("  a   b  "), "a b");
  assert.equal(cleanTag("x".repeat(60)).length, 40);
  assert.deepEqual(withTag(["Sky"], " sky "), ["Sky"]);
  assert.deepEqual(withTag(["Sky"], "sea"), ["Sky", "sea"]);
  assert.deepEqual(withTag(["Sky"], "   "), ["Sky"]);
  assert.equal(withTag(Array.from({ length: 16 }, (_, i) => `t${i}`), "more").length, 16);
  assert.deepEqual(withoutTag(["a", "b"], "a"), ["b"]);
  assert.deepEqual(allTags(META), ["B-roll", "Interview"]);
});

test("window range covers the viewport plus overscan and is clamped", () => {
  assert.deepEqual(windowRange(0, 600, 100, 72, 10_000, 0), [0, 7]);
  const [a, b] = windowRange(72_000, 600, 100, 72, 10_000, 6);
  assert.ok(a < 1000 && b > 1000 && b - a < 30);
  assert.deepEqual(windowRange(9e9, 600, 0, 72, 50), [50, 50]);
});

test("10k items: filter and sort stay far below a frame budget (container, not representative)", () => {
  const n = 10_000;
  const many = Array.from({ length: n }, (_, i) => item(`m${i}`, `clip ${n - i}.mp4`, i % 3 === 0 ? "audio" : "video", i * 7 % 5000));
  const meta = binMeta(proj(many.map((m, i) => ({ id: m.id, tags: i % 10 === 0 ? ["tagged"] : [] }))));
  const t0 = performance.now();
  let out = 0;
  for (let r = 0; r < 5; r++) out += viewBin(many, meta, { kind: "video", tag: "", sort: "name", query: "9", }).length + viewBin(many, meta, { kind: "all", tag: "tagged", sort: "duration", query: "" }).length;
  const ms = (performance.now() - t0) / 10;
  console.log(`bin view at ${n} items: ${ms.toFixed(1)} ms per filter+sort (container, not representative)`);
  assert.ok(out > 0 && ms < 100, `${ms} ms`);
});
