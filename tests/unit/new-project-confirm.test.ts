// F2 (destructive confirm): New project says what really happens (a snapshot is kept in Versions) and its button looks destructive.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { confirmBodyKey, toastDuration } from "../../apps/web/src/projectConfirm";
import en from "../../apps/web/src/i18n/en.json" with { type: "json" };

const copy = en as Record<string, string>;
const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("New project copy matches the code: a snapshot is kept in Versions before the project is replaced", () => {
  const body = copy["project.new.body"] ?? "";
  assert.doesNotMatch(body, /are lost/, "the copy must not say the work is lost: a snapshot is taken first");
  assert.match(body, /Versions/);
  // The code takes the snapshot for New project (App.tsx onNew -> replaceWith(..., "before-new")).
  assert.match(read("apps/web/src/App.tsx"), /replaceWith\(await core\.saveProject\(newProject\(t\("app\.untitled"\)\)\), "before-new"\)/);
});

test("without a persistence session there is no Versions snapshot, so the copy must not promise one", () => {
  // Storage unavailable: App.tsx replaceWith skips the snapshot (no session), so the unsaved copy is the true one.
  const fallback = copy["project.new.bodyUnsaved"] ?? "";
  assert.match(fallback, /are lost/);
  assert.doesNotMatch(fallback, /Versions/);
  // (The dialog now picks its copy with confirmBodyKey, covered below, for New and for Open.)
  assert.match(read("apps/web/src/App.tsx"), /confirmBodyKey\(what, !!persistence\.session\)/);
});

test("Open project says the same as New: a copy is kept in Versions with a session, the unsaved copy without storage", () => {
  assert.equal(confirmBodyKey("open", true), "project.open.body");
  assert.equal(confirmBodyKey("open", false), "project.open.bodyUnsaved");
  assert.equal(confirmBodyKey("new", true), "project.new.body");
  assert.equal(confirmBodyKey("new", false), "project.new.bodyUnsaved");
  assert.match(copy["project.open.body"] ?? "", /kept in Versions/);
  assert.doesNotMatch(copy["project.open.body"] ?? "", /are lost/);
  assert.match(copy["project.open.bodyUnsaved"] ?? "", /are lost/);
  assert.doesNotMatch(copy["project.open.bodyUnsaved"] ?? "", /Versions/);
  // The code takes the snapshot for Open too (App.tsx openFromFile -> replaceWith(..., "before-open")).
  assert.match(read("apps/web/src/App.tsx"), /replaceWith\(file\.bytes, "before-open"\)/);
});

test("info toasts are short (about 3 s, at most 5 s)", () => {
  assert.equal(toastDuration("Saved."), 3000);
  assert.ok(toastDuration("x".repeat(400)) <= 5000);
});

test("the New project confirm button uses the danger style; other confirms keep the safe one", () => {
  const app = read("apps/web/src/App.tsx");
  assert.match(app, /danger: what === "new"/);
  assert.match(read("apps/web/src/ProjectDialogs.tsx"), /danger \? "export-go confirm-danger" : "export-go"/);
  assert.match(read("apps/web/src/styles.css"), /\.export-go\.confirm-danger \{ background: var\(--danger\); color: var\(--bg\); \}/);
});
