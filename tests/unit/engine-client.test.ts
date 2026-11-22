import test from "node:test";
import assert from "node:assert/strict";
import { EXPECTED_ABI, parseEngineInfo } from "../../packages/engine-client/src/types";

test("parseEngineInfo accepts what the engine sends", () => {
  const info = parseEngineInfo(JSON.stringify({ name: "x", version: "0.1.0", abi: EXPECTED_ABI }));
  assert.deepEqual(info, { name: "x", version: "0.1.0", abi: EXPECTED_ABI });
});

test("parseEngineInfo rejects a wrong shape and a mismatched ABI (a stale engine build must be loud)", () => {
  assert.throws(() => parseEngineInfo("null"), /not an object/);
  assert.throws(() => parseEngineInfo(JSON.stringify({ name: "x" })), /wrong shape/);
  assert.throws(() => parseEngineInfo(JSON.stringify({ name: "x", version: "1", abi: EXPECTED_ABI + 1 })), /rebuild the engine/);
});

import { ProjectFileError, parseOpenedProject, toProjectFileError } from "../../packages/engine-client/src/types";

test("parseOpenedProject maps the engine's snake_case envelope", () => {
  const o = parseOpenedProject(JSON.stringify({ project: { name: "p" }, read_only: true, found_version: 3, migrated: false, entries: ["peaks/a"] }));
  assert.equal(o.readOnly, true);
  assert.equal(o.foundVersion, 3);
  assert.deepEqual(o.entries, ["peaks/a"]);
  assert.throws(() => parseOpenedProject(JSON.stringify({ project: {} })), /wrong shape/);
  assert.throws(() => parseOpenedProject("null"), /not an object/);
});

test("both backends throw engine errors as JSON {code,message}; toProjectFileError turns them into typed errors", () => {
  // wasm throws the string, Tauri rejects with the string, tests may wrap it in an Error: all three must work.
  const raw = JSON.stringify({ code: "newer_version", message: "made by a newer version" });
  for (const thrown of [raw, new Error(raw)]) {
    const e = toProjectFileError(thrown);
    assert.ok(e instanceof ProjectFileError);
    assert.equal(e.code, "newer_version");
    assert.equal(e.message, "made by a newer version");
  }
  assert.equal(toProjectFileError(JSON.stringify({ code: "from_the_future", message: "x" })).code, "unknown");
  assert.equal(toProjectFileError("boom").code, "unknown");
  assert.equal(toProjectFileError("boom").message, "boom");
});
