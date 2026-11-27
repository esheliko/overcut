// r13 #243: a project file that fails to open is explained in plain words; the parser text only lives behind "Show details".
import assert from "node:assert/strict";
import { test } from "node:test";
import { errorText, openFailureKind } from "../../apps/web/src/openError";
import en from "../../apps/web/src/i18n/en.json" with { type: "json" };

const copy = en as Record<string, string>;

test("the raw zip error is classified as damaged, and the headline copy never contains parser text", () => {
  const raw = "the file is damaged or not an .overcut project: invalid Zip archive: Could not find EOCD";
  assert.equal(openFailureKind(raw, copy["project.open.newer"]!), "damaged");
  assert.doesNotMatch(copy["project.open.failed.damaged"]!, /zip|EOCD|archive|\{why\}/i);
});

test("a project from a newer version keeps its own plain sentence", () => {
  assert.equal(openFailureKind(copy["project.open.newer"]!, copy["project.open.newer"]!), "newer");
});

test("errorText reads Error, engine objects and strings", () => {
  assert.equal(errorText(new Error("a")), "a");
  assert.equal(errorText({ message: "b" }), "b");
  assert.equal(errorText("c"), "c");
});
