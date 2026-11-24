import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SHARE_ACTION, SHARE_CACHE, isProjectFile, routeIncoming, sharedIdFromSearch, takeShared, type CachesLike } from "../../apps/web/src/incoming";

const src = (name: string) => ({ file: new File(["x"], name) });

test("a project file wins and the media that came with it are not imported into the project being replaced", () => {
  const a = src("clip.mp4"), b = src("film.OverCut"), c = src("song.mp3");
  assert.deepEqual(routeIncoming([a, b, c]), { project: b, media: [] });
  assert.deepEqual(routeIncoming([a, c]), { project: null, media: [a, c] });
  assert.deepEqual(routeIncoming([]), { project: null, media: [] });
  assert.ok(isProjectFile({ name: "My Film.OVERCUT" }) && !isProjectFile({ name: "overcut.mp4" }));
});

test("only the service worker's own ids are accepted from the address", () => {
  assert.equal(sharedIdFromSearch("?shared=3f2b1c9e-0a4d-4e1b-9c55-1d2e3f4a5b6c"), "3f2b1c9e-0a4d-4e1b-9c55-1d2e3f4a5b6c");
  for (const bad of ["", "?shared=", "?shared=../../x", "?shared=a b", "?shared=short", "?other=1"]) assert.equal(sharedIdFromSearch(bad), null);
});

/** A tiny Cache API: URL -> Response. */
function fakeCaches(): { caches: CachesLike; store: Map<string, Response> } {
  const store = new Map<string, Response>();
  const cache = {
    keys: async () => [...store.keys()].map((u) => new Request(`https://x.test${u}`)),
    match: async (r: Request) => store.get(new URL(r.url).pathname)?.clone(),
    delete: async (r: Request) => store.delete(new URL(r.url).pathname),
  };
  return { caches: { open: async (n: string) => { assert.equal(n, SHARE_CACHE); return cache as never; } }, store };
}
const park = (store: Map<string, Response>, id: string, i: number, name: string, body: string, type: string) =>
  store.set(`/__shared/${id}/${i}`, new Response(body, { headers: { "content-type": type, "x-name": encodeURIComponent(name) } }));

test("shared files come back in order with their names and types, and are forgotten after being taken", async () => {
  const { caches, store } = fakeCaches();
  const id = "abcdef12-3456";
  park(store, id, 10, "ten é.mp4", "ten", "video/mp4");
  park(store, id, 2, "two.png", "two", "image/png");
  park(store, "otherid-1234", 0, "other.mp3", "o", "audio/mpeg");
  const got = await takeShared(id, caches);
  assert.deepEqual(got.map((s) => [s.file.name, s.file.type]), [["two.png", "image/png"], ["ten é.mp4", "video/mp4"]]);
  assert.equal(await got[1]!.file.text(), "ten");
  assert.deepEqual([...store.keys()], ["/__shared/otherid-1234/0"]); // only this share was taken
  assert.deepEqual(await takeShared(id, caches), []);
  assert.deepEqual(await takeShared("../bad", caches), []);
  assert.deepEqual(await takeShared(id, undefined), []);
});

test("the manifest declares file handling and the share target, and the service worker answers the same path", () => {
  const m = JSON.parse(readFileSync("apps/web/public/manifest.webmanifest", "utf8"));
  const accept = m.file_handlers[0].accept as Record<string, string[]>;
  const has = (k: string, ext: string) => accept[k]?.includes(ext);
  assert.ok(has("video/*", ".mp4") && has("audio/*", ".wav") && has("image/*", ".png"));
  assert.deepEqual(accept["application/x-overcut"], [".overcut"]);
  assert.equal(m.share_target.action, SHARE_ACTION);
  assert.equal(m.share_target.method, "POST");
  assert.equal(m.share_target.enctype, "multipart/form-data");
  assert.equal(m.share_target.params.files[0].name, "files");
  const sw = readFileSync("apps/web/public/sw.js", "utf8");
  assert.ok(sw.includes(`SHARE_ACTION = "${SHARE_ACTION}"`) && sw.includes(`SHARE_CACHE = "${SHARE_CACHE}"`) && sw.includes("/__shared/"));
});
