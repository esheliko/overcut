import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CSP } from "../../apps/web/csp";

type Rule = { source: string; headers: { key: string; value: string }[] };
const rules = (JSON.parse(readFileSync("vercel.json", "utf8")) as { headers: Rule[] }).headers;

test("vercel.json sends the app CSP as a response header, plus frame-ancestors 'none' (covers /sw.js too)", () => {
  const all = rules.find((r) => r.source === "/(.*)");
  const value = all?.headers.find((h) => h.key === "Content-Security-Policy")?.value;
  assert.equal(value, `${CSP}; frame-ancestors 'none'`);
  // the /sw.js rule adds Cache-Control only; the catch-all header still applies to it (Vercel merges matching rules)
  assert.ok(!rules.find((r) => r.source === "/sw.js")?.headers.some((h) => h.key === "Content-Security-Policy"));
});
