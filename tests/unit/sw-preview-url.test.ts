import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
// @ts-expect-error plain .mjs helpers
import { extractDeploymentUrl } from "../../scripts/vercel-url.mjs";
// @ts-expect-error plain .mjs helpers
import { buildHash, stampSw } from "../../scripts/stamp-sw.mjs";

test("deployment URL is found in Vercel CLI output, last match wins, none -> null", () => {
  assert.equal(extractDeploymentUrl("https://overcut-abc123-team.vercel.app\n"), "https://overcut-abc123-team.vercel.app");
  const noisy = "Vercel CLI 66\nInspect: https://vercel.com/team/overcut/AbC [2s]\nPreview: https://overcut-xyz-team.vercel.app [5s]\nDeploying...\nhttps://overcut-xyz-team.vercel.app\n";
  assert.equal(extractDeploymentUrl(noisy), "https://overcut-xyz-team.vercel.app");
  assert.equal(extractDeploymentUrl("Error: api-deployments-free-per-day https://vercel.com/docs"), null);
  assert.equal(extractDeploymentUrl(""), null);
});

test("the service worker is stamped with the build hash, differently per build", () => {
  const sw = readFileSync("apps/web/public/sw.js", "utf8");
  const a = buildHash(["assets/a-1.js"], sw), b = buildHash(["assets/a-2.js"], sw);
  assert.notEqual(a, b);
  const out = stampSw(sw, a);
  assert.ok(out.includes(`overcut-${a}`) && !out.includes("__BUILD__"));
  assert.throws(() => stampSw("const VERSION='x'", a));
});

test("sw.js times navigations out and deletes old caches on activate", () => {
  const sw = readFileSync("apps/web/public/sw.js", "utf8");
  assert.match(sw, /NAV_TIMEOUT_MS = 3000/);
  assert.match(sw, /caches\.delete/);
});
