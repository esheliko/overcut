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
