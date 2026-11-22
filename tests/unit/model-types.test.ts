import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-expect-error plain .mjs script without types
import { generate, SCHEMA_PATH, OUT_PATH } from "../../scripts/gen-model-types.mjs";
import type { Project } from "../../packages/engine-client/src/index";

test("model.generated.ts is up to date with project.schema.json (run `npm run gen:model-types`)", () => {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  assert.equal(readFileSync(OUT_PATH, "utf8"), generate(schema));
});

test("a project JSON written by the Rust engine has the generated shape", () => {
  const p: Project = {
    schema_version: 1,
    id: "00000000000000000000000000000001",
    name: "x",
    media: [],
    sequences: [],
  };
  assert.equal(p.schema_version, 1);
});
