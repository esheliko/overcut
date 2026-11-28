import test from "node:test";
import assert from "node:assert/strict";
import { colourSpaceInit } from "../../packages/engine-client/src/decode/colour";

test("colourSpaceInit: carries a full-range bt709 description, as our own exports declare it", () => {
  assert.deepEqual(colourSpaceInit({ primaries: 1, transfer: 13, matrix: 1, fullRange: true }), { primaries: "bt709", transfer: "iec61966-2-1", matrix: "bt709", fullRange: true });
});
test("colourSpaceInit: says limited range when the container says so, and nothing about a range it does not give", () => {
  assert.equal(colourSpaceInit({ primaries: 1, transfer: 1, matrix: 1, fullRange: false })?.fullRange, false);
  assert.deepEqual(colourSpaceInit({ primaries: 1, transfer: 1, matrix: 1, fullRange: null }), { primaries: "bt709", transfer: "bt709", matrix: "bt709" });
});
test("colourSpaceInit: leaves unknown or unspecified code points to the decoder", () => {
  assert.equal(colourSpaceInit({ primaries: 2, transfer: 2, matrix: 2, fullRange: null }), undefined);
  assert.deepEqual(colourSpaceInit({ primaries: 0, transfer: 0, matrix: 0, fullRange: true }), { fullRange: true });
  assert.equal(colourSpaceInit(null), undefined);
  assert.equal(colourSpaceInit(undefined), undefined);
});
