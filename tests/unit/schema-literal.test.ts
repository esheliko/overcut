import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * `engine.editing.open(project)` validates without migrating, so a project built in code must carry the CURRENT schema version. The device
 * check's export project once hardcoded `schema_version: 4` and failed with `UnsupportedVersion(4)` after the schema went to 5. Saved files go
 * through `openProject`, which migrates (crates/model fixtures v1..v5).
 */
test("no app code hardcodes a numeric schema_version (use PROJECT_SCHEMA_VERSION)", () => {
  const bad: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name) && !/fixture\.ts$/.test(name) && /schema_version:\s*\d/.test(readFileSync(p, "utf8"))) bad.push(p);
    }
  };
  walk("apps/web/src");
  assert.deepEqual(bad, []);
});
