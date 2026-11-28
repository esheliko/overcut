import test from "node:test";
import assert from "node:assert/strict";
import { memoryStorage } from "../../packages/engine-client/src/persist/memory";
import { CHECKPOINT_FILE, JOURNAL_FILE, PROJECT_FILE } from "../../packages/engine-client/src/persist/session";
import { SnapshotStore } from "../../packages/engine-client/src/persist/snapshots";
import { LEGACY_PROJECT_ID, ProjectRegistry, REGISTRY_FILE, copyName, deleteProjectData, migrateSingleProject, newProjectId, summarize, summarizeExtra } from "../../packages/engine-client/src/persist/registry";
import { autoProjectName, isArchived, libraryView, shapeBox, startScreen, whenLabel } from "../../apps/web/src/projectsView";
import type { Project } from "../../packages/engine-client/src/model.generated";

const bytes = (s: string) => new TextEncoder().encode(s);
const clock = (start = 1000) => { let t = start; return () => (t += 10); };

test("the list stores rows, sorts newest edit first, renames, updates and removes", async () => {
  const reg = new ProjectRegistry(memoryStorage(), undefined, clock());
  assert.equal(await reg.read(), null, "nothing written yet");
  await reg.add({ id: "a", name: "First" });
  await reg.add({ id: "b", name: "Second" });
  assert.deepEqual((await reg.list()).map((e) => e.id), ["b", "a"]);
  await reg.update("a", { modified: 99_999, name: "Renamed", width: 1080, height: 1920, clips: 3 });
  const [top] = await reg.list();
  assert.deepEqual([top!.id, top!.name, top!.width, top!.clips], ["a", "Renamed", 1080, 3]);
  await reg.update("missing", { name: "x" }); // an unknown id changes nothing
  assert.equal((await reg.list()).length, 2);
  await reg.setCurrent("a");
  await reg.remove("a");
  const data = await reg.read();
  assert.deepEqual(data?.items.map((e) => e.id), ["b"]);
  assert.equal(data?.current, null, "the removed project is no longer 'current'");
});

test("a damaged list file reads as empty instead of throwing, and project data is never touched by it", async () => {
  const storage = memoryStorage();
  await storage.writeAtomic(REGISTRY_FILE, bytes("{not json"));
  const reg = new ProjectRegistry(storage);
  assert.deepEqual(await reg.read(), { current: null, items: [] });
  await storage.writeAtomic(REGISTRY_FILE, bytes(JSON.stringify({ v: 1, current: 7, items: [{ id: "ok", modified: 1, name: "" }, { id: "../evil", modified: 1 }, { nope: 1 }] })));
  const data = await reg.read();
  assert.deepEqual(data?.items.map((e) => e.id), ["ok"], "rows with an unsafe id or no id are ignored");
  assert.equal(data?.current, null);
});

test("migration: a single project from before the list becomes the first row, byte for byte untouched", async () => {
  const legacy = memoryStorage();
  const file = bytes("the saved .overcut of the one project");
  await legacy.writeAtomic(PROJECT_FILE, file);
  await legacy.append(JOURNAL_FILE, bytes("journal"));
  const reg = new ProjectRegistry(memoryStorage(), undefined, clock());
  let described = 0;
  const describe = async () => (described++, (await legacy.read(PROJECT_FILE)) ? { name: "My film", width: 1920, height: 1080, clips: 4 } : null);
  const data = await migrateSingleProject(reg, describe, clock());
  assert.deepEqual(data.items.map((e) => [e.id, e.name, e.width, e.clips]), [[LEGACY_PROJECT_ID, "My film", 1920, 4]]);
  assert.equal(data.current, LEGACY_PROJECT_ID);
  assert.deepEqual(await legacy.read(PROJECT_FILE), file, "the project file is the same bytes");
  assert.deepEqual(await legacy.read(JOURNAL_FILE), bytes("journal"), "a crash-left journal is still there for recovery");
  // Idempotent: a second start neither re-reads the old project nor duplicates the row.
  const again = await migrateSingleProject(reg, describe, clock());
  assert.equal(described, 1);
  assert.equal(again.items.length, 1);
});

test("migration: the default name is shown as unnamed; a fresh install gets an empty list; a deleted old project does not come back", async () => {
  const reg = new ProjectRegistry(memoryStorage(), undefined, clock());
  const first = await migrateSingleProject(reg, async () => ({ name: "Untitled project" }), clock());
  assert.equal(first.items[0]!.name, "", "the localized default name is used by the UI");
  await reg.remove(LEGACY_PROJECT_ID);
  const after = await migrateSingleProject(reg, async () => ({ name: "Untitled project" }), clock());
  assert.equal(after.items.length, 0, "once a list exists the old project is never re-added");

  const fresh = new ProjectRegistry(memoryStorage(), undefined, clock());
  const none = await migrateSingleProject(fresh, async () => null, clock());
  assert.deepEqual(none, { current: null, items: [] });
  assert.notEqual(await fresh.read(), null, "the empty list is written so the check runs once");
});

test("concurrent changes are serialised through the lock", async () => {
  let chain: Promise<unknown> = Promise.resolve();
  const lock = <T,>(f: () => Promise<T>): Promise<T> => { const next = chain.then(f, f); chain = next.catch(() => undefined); return next; };
  const reg = new ProjectRegistry(memoryStorage(), lock, clock());
  await Promise.all(Array.from({ length: 12 }, (_, i) => reg.add({ id: `p${i}`, name: String(i) })));
  assert.equal((await reg.list()).length, 12, "no write overwrote another");
});

test("deleting a project removes its file, journal, checkpoint and every version", async () => {
  const s = memoryStorage();
  await s.writeAtomic(PROJECT_FILE, bytes("p"));
  await s.append(JOURNAL_FILE, bytes("j"));
  await s.writeAtomic(CHECKPOINT_FILE, bytes("c"));
  const snaps = new SnapshotStore(s, clock());
  const a = await snaps.add("manual", "keep", bytes("one"));
  const b = await snaps.add("auto", "", bytes("two"));
  await deleteProjectData(s);
  for (const f of [PROJECT_FILE, JOURNAL_FILE, CHECKPOINT_FILE, "snapshots.json", `snap-${a!.id}.overcut`, `snap-${b!.id}.overcut`]) assert.equal(await s.read(f), null, f);
});

test("ids are flat and unique; copies get the first free name", () => {
  const ids = new Set(Array.from({ length: 200 }, (_, i) => newProjectId(1_700_000_000_000 + i, () => (i * 7919) / 1e6)));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(copyName("Film", ["Film"], "Untitled"), "Film copy");
  assert.equal(copyName("Film", ["Film", "Film copy"], "Untitled"), "Film copy 2");
  assert.equal(copyName("Film copy", ["Film copy"], "Untitled"), "Film copy 2", "copying a copy does not stack 'copy copy'");
  assert.equal(copyName("", [], "Untitled project"), "Untitled project copy");
});

test("a project's row facts are counted from the project itself", () => {
  const project = { sequences: [{ resolution: { width: 1080, height: 1920 }, tracks: [{ clips: [1, 2] }, { clips: [3] }] }] } as unknown as Project;
  assert.deepEqual(summarize(project), { width: 1080, height: 1920, clips: 3 });
  assert.deepEqual(summarize({ sequences: [] } as unknown as Project), { width: undefined, height: undefined, clips: 0 });
});

test("a project's length and tint for its card come from the project", () => {
  const project = { sequences: [{ tracks: [{ colour: null, clips: [{ start: 0, duration: 100 }] }, { colour: "#ff8800", clips: [{ start: 50, duration: 400 }] }] }] } as unknown as Project;
  assert.deepEqual(summarizeExtra(project), { ticks: 450, colour: "#ff8800" });
  assert.deepEqual(summarizeExtra({ sequences: [] } as unknown as Project), { ticks: 0, colour: undefined });
});

test("list view helpers: first screen, real canvas shape, relative times", () => {
  assert.deepEqual([0, 1, 2, 9].map((n) => startScreen(n)), ["new", "editor", "home", "home"]);
  assert.equal(startScreen(0, 2), "home", "only archived projects left: show the library, never create a project behind the person's back");
  assert.equal(startScreen(1, 3), "editor");
  assert.deepEqual(shapeBox(1920, 1080, 44), { w: 44, h: 25 });
  assert.deepEqual(shapeBox(1080, 1920, 44), { w: 25, h: 44 });
  assert.deepEqual(shapeBox(undefined, undefined, 44), { w: 44, h: 25 }, "unknown canvas draws the default shape, not a made-up one");
  const now = Date.UTC(2026, 10, 24, 12, 0, 0);
  assert.equal(whenLabel(now - 5_000, now, "en", "just now"), "just now");
  assert.equal(whenLabel(now - 5 * 60_000, now, "en", "just now"), "5 minutes ago");
  assert.equal(whenLabel(now - 3 * 3_600_000, now, "en", "just now"), "3 hours ago");
  assert.equal(whenLabel(now - 86_400_000, now, "en", "just now"), "yesterday");
  assert.match(whenLabel(now - 30 * 86_400_000, now, "en", "just now"), /Oct/);
});

test("archive: a row is tucked away and restored without touching anything else; a bad archived value reads as active", async () => {
  const storage = memoryStorage();
  const reg = new ProjectRegistry(storage, undefined, clock());
  await reg.add({ id: "a", name: "Keep", width: 1920, height: 1080, clips: 2 });
  await reg.add({ id: "b", name: "Old" });
  await reg.update("b", { archived: 5000 });
  let rows = await reg.list();
  assert.equal(rows.find((e) => e.id === "b")!.archived, 5000);
  assert.deepEqual(rows.find((e) => e.id === "a"), { id: "a", name: "Keep", created: rows.find((e) => e.id === "a")!.created, modified: rows.find((e) => e.id === "a")!.modified, width: 1920, height: 1080, clips: 2 });
  const view = libraryView(rows, "archived");
  assert.deepEqual([view.shown.map((e) => e.id), view.active, view.archived], [["b"], 1, 1]);
  assert.deepEqual(libraryView(rows, "active").shown.map((e) => e.id), ["a"]);
  await reg.update("b", { archived: undefined }); // restore
  rows = await reg.list();
  assert.equal("archived" in rows.find((e) => e.id === "b")!, false);
  assert.equal(libraryView(rows, "archived").shown.length, 0);
  // A hand-edited or damaged value is not an archive.
  await storage.writeAtomic(REGISTRY_FILE, bytes(JSON.stringify({ v: 1, current: null, items: [{ id: "x", modified: 1, name: "", archived: "yes" }, { id: "y", modified: 1, name: "", archived: 7 }] })));
  const damaged = (await reg.read())!.items;
  assert.deepEqual(damaged.map((e) => [e.id, isArchived(e)]), [["x", false], ["y", true]]);
});

test("autoProjectName: dated, then numbered when the day's name is taken", () => {
  const d = new Date(2026, 10, 28);
  const first = autoProjectName([], d, "en-GB");
  assert.equal(first, "Project 28 Nov");
  assert.equal(autoProjectName([first], d, "en-GB"), "Project 28 Nov 2");
  assert.equal(autoProjectName([first, "Project 28 Nov 2"], d, "en-GB"), "Project 28 Nov 3");
  assert.equal(autoProjectName([], d, "en-GB", "Projet {date}"), "Projet 28 Nov");
});
