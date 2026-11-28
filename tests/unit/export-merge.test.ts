import assert from "node:assert/strict";
import test from "node:test";
import { PRESET_IDS, mergePresets, type Source } from "../../apps/web/src/export/model";

const HD: Source = { width: 1920, height: 1080, fps: 30, seconds: 20 };
const SMALL: Source = { width: 640, height: 360, fps: 30, seconds: 8 };

test("presets that give the same file for the project are one choice", () => {
  const groups = mergePresets(PRESET_IDS, SMALL);
  const original = groups.find((g) => g.id === "original")!;
  // A 360p project: "YouTube" and "Facebook" cannot make it bigger, so they are Original with another name.
  assert.ok(original.same.includes("youtube"));
  assert.ok(original.same.includes("facebook"));
  // Presets with their own size cap, a lower quality or a tall frame stay separate choices.
  const ids = groups.map((g) => g.id);
  for (const id of ["vertical", "x", "whatsapp", "discord", "small"] as const) assert.ok(ids.includes(id), id);
  // Every preset is shown or listed under one, exactly once.
  assert.deepEqual([...groups.flatMap((g) => [g.id, ...g.same])].sort(), [...PRESET_IDS].sort());
});

test("on a 1080p project each platform preset keeps its own tile where it differs", () => {
  const groups = mergePresets(PRESET_IDS, HD);
  const original = groups.find((g) => g.id === "original")!;
  assert.ok(original.same.includes("youtube")); // 1080p YouTube = the original file
  assert.ok(groups.some((g) => g.id === "small")); // 720p / medium differs
});
