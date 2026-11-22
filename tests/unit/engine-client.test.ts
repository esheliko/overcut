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

import { parseCapabilities } from "../../packages/engine-client/src/capabilities";
import { probeHost } from "../../packages/engine-client/src/probe";

test("probeHost never throws: missing browser APIs become 'no' or unavailable, and the output is valid JSON for the engine", async () => {
  const probe = JSON.parse(await probeHost()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(probe.codecs.length, 4);
  for (const c of probe.codecs) assert.deepEqual([c.decode, c.encode], ["no", "no"]); // plain Node has no WebCodecs
  assert.equal(probe.webgpu.available, false);
  assert.equal(probe.webgl2.available, false);
  assert.equal(typeof probe.platform.user_agent, "string");
});

test("parseCapabilities accepts the engine's shape and rejects junk", () => {
  const ok = { host: "web", platform: {}, codecs: [], webgpu: { available: false }, issues: [] };
  assert.equal(parseCapabilities(JSON.stringify(ok)).host, "web");
  assert.throws(() => parseCapabilities("null"), /not an object/);
  assert.throws(() => parseCapabilities("{}"), /wrong shape/);
});
