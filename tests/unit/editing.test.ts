import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createEditing, parseEditOutcome, type RawEditing } from "../../packages/engine-client/src/editing";
import type { Op } from "../../packages/engine-client/src/types";
import type { Project } from "../../packages/engine-client/src/model.generated";

const contract = JSON.parse(readFileSync(new URL("../../packages/engine-client/schema/edit-contract.json", import.meta.url), "utf8")) as {
  ops: Op[];
  outcome: unknown;
};
const first = contract.ops[0] as Op;
const argsOf = (calls: Array<[string, unknown[]]>, i: number): unknown[] => calls[i]?.[1] ?? [];

/** A recording stand-in for an engine backend: what it receives is what the real wasm/Tauri backends would receive. */
function fake(over: Partial<RawEditing> = {}) {
  const calls: Array<[string, unknown[]]> = [];
  const outcome = JSON.stringify(contract.outcome);
  const raw: RawEditing = {
    open: (...a) => void calls.push(["open", a]),
    apply: (...a) => (calls.push(["apply", a]), outcome),
    undo: () => (calls.push(["undo", []]), outcome),
    redo: () => (calls.push(["redo", []]), outcome),
    project: () => '{"schema_version":1}',
    journal: () => '{"op":"delete"}\n',
    evaluate: () => "{}",
    takeLog: () => '{"n":1,"r":"undo"}\n',
    checkpoint: () => '{"seq":0,"project":{}}',
    recover: () => '{"replayed":1,"dropped":0,"full_history":true,"valid_log":"x"}',
    ...over,
  };
  return { editing: createEditing(raw), calls };
}

test("the contract holds one example of every op the Op type allows", () => {
  assert.deepEqual(contract.ops.map((o) => o.op).sort(), ["add_media", "delete", "insert_clip", "move", "remove_media", "set_canvas", "set_clip", "set_media", "set_sequence_format", "split", "trim_in", "trim_out"]);
});

test("a single op and a list go over as JSON (a list is one undo step); the coalesce key rides along", async () => {
  const { editing, calls } = fake();
  const out = await editing.apply(first, 7);
  assert.deepEqual(out, contract.outcome);
  await editing.apply(contract.ops);
  assert.deepEqual(JSON.parse(argsOf(calls, 0)[0] as string), first);
  assert.equal(argsOf(calls, 0)[1], 7);
  assert.deepEqual(JSON.parse(argsOf(calls, 1)[0] as string), contract.ops);
  assert.equal(argsOf(calls, 1)[1], undefined);
});

test("undo, redo, project and journal reach the engine and parse what comes back", async () => {
  const { editing, calls } = fake();
  assert.equal((await editing.undo()).can_undo, true);
  assert.equal((await editing.redo()).changed, true);
  assert.equal(((await editing.project()) as Project).schema_version, 1);
  assert.equal(await editing.journal(), '{"op":"delete"}\n');
  assert.deepEqual(calls.map((c) => c[0]), ["undo", "redo"]);
});

test("open sends the project as JSON", async () => {
  const { editing, calls } = fake();
  await editing.open({ schema_version: 1 } as Project);
  assert.equal(argsOf(calls, 0)[0], '{"schema_version":1}');
});

test("engine failures (thrown strings from wasm, rejections from Tauri) surface as Errors", async () => {
  const boom = { apply: () => { throw "Overlap { with: 1 }"; }, undo: () => Promise.reject("nothing"), open: () => { throw new Error("bad project"); } };
  const { editing } = fake(boom);
  await assert.rejects(editing.apply(first), (e: unknown) => e instanceof Error && /Overlap/.test(e.message));
  await assert.rejects(editing.undo(), (e: unknown) => e instanceof Error && e.message === "nothing");
  await assert.rejects(editing.open({} as Project), /bad project/);
});

test("a coalesce key outside u32 is refused before it reaches the engine", async () => {
  const { editing, calls } = fake();
  for (const bad of [-1, 1.5, 2 ** 32]) await assert.rejects(editing.apply(first, bad), /coalesce key/);
  assert.equal(calls.length, 0);
});

test("parseEditOutcome rejects the wrong shape", () => {
  assert.deepEqual(parseEditOutcome(JSON.stringify(contract.outcome)), contract.outcome);
  assert.throws(() => parseEditOutcome("null"), /not an object/);
  assert.throws(() => parseEditOutcome('{"revision":1}'), /wrong shape/);
});

test("evaluate sends the sequence, an exact tick count (bigint) and the audio window, and parses the frame description", async () => {
  const desc = { time: 5, frame: 0, video_time: 0, sample: 0, audio_samples: 8, layers: [], audio: [] };
  const { editing, calls } = fake({ evaluate: (...a) => (calls.push(["evaluate", a]), JSON.stringify(desc)) });
  assert.deepEqual(await editing.evaluate("seq", 5, 8), desc);
  assert.deepEqual(argsOf(calls, 0), ["seq", 5n, 8]);
  await editing.evaluate("seq", 9);
  assert.equal(argsOf(calls, 1)[2], 0);
});

test("evaluate refuses ticks that are not exact integers and bad window sizes", async () => {
  const { editing, calls } = fake();
  await assert.rejects(editing.evaluate("s", 1.5), /safe integer/);
  await assert.rejects(editing.evaluate("s", 2 ** 60), /safe integer/);
  await assert.rejects(editing.evaluate("s", 0, -1), /audioSamples/);
  assert.equal(calls.length, 0);
});
