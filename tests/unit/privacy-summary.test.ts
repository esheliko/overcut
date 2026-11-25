// F5 (privacy summary): the Privacy dialog shows a plain summary first; the raw request table sits behind "Show details".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import en from "../../apps/web/src/i18n/en.json" with { type: "json" };

const copy = en as Record<string, string>;
const src = readFileSync(new URL("../../apps/web/src/privacy/NetworkLog.tsx", import.meta.url), "utf8");

test("the detailed request list is behind a 'Show details' control", () => {
  assert.equal(copy["net.details"], "Show details");
  assert.match(src, /<details className="net-details"[^>]*>\s*<summary>\{t\("net\.details"\)\}<\/summary>/);
  // The table must come after the summary element, so it is hidden until the control is used.
  assert.ok(src.indexOf("<summary>") < src.indexOf("<table"), "the table must sit inside the details block");
});

test("the plain summary is shown before the details control", () => {
  assert.ok(src.indexOf("network-summary") < src.indexOf("<details"), "the plain summary must come first");
});
