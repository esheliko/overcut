// F2 (destructive confirm): New project says what really happens (a snapshot is kept in Versions) and its button looks destructive.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
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
  assert.match(read("apps/web/src/App.tsx"), /what === "new" && !persistence\.session \? "project\.new\.bodyUnsaved" : `project\.\$\{what\}\.body`/);
});

test("the New project confirm button uses the danger style; other confirms keep the safe one", () => {
  const app = read("apps/web/src/App.tsx");
  assert.match(app, /danger: what === "new"/);
  assert.match(read("apps/web/src/ProjectDialogs.tsx"), /danger \? "export-go confirm-danger" : "export-go"/);
  assert.match(read("apps/web/src/styles.css"), /\.export-go\.confirm-danger \{ background: var\(--danger\); color: var\(--bg\); \}/);
});
