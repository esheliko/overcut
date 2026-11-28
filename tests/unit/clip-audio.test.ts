import assert from "node:assert/strict";
import { test } from "node:test";
import type { Clip, Project } from "@app/engine-client";
import { audioOf, audioOp, clampAudio, levelBeforeMute, maxFadeTicks, muteOps, mutableSounds, soundTarget, TICKS } from "../../apps/web/src/inspector/audioModel";
import { audioDragOps, audioHit, dragAudio, levelY, startAudioDrag, LINE_BOT, LINE_TOP } from "../../apps/web/src/timeline/audioEdit";
import { pointerDown, pointerMove, pointerUp, SLOP, type Ctx, type PEvent } from "../../apps/web/src/timeline/interact";
import { buildScene } from "../../apps/web/src/timeline/scene";
import { fixtureProject } from "../../apps/web/src/timeline/fixture";
import { flagsOf, indicesOf } from "../../apps/web/src/timeline/edit";
import { GUTTER_WIDE, LANE, RULER, type View } from "../../apps/web/src/timeline/view";

const clip = (id: string, over: Partial<Clip> = {}): Clip => ({ id, media: "m", start: 0, source_in: 0, duration: 10 * TICKS, ...over });
const project = (clips: Clip[], link?: Clip): Project => ({
  id: "p", name: "p", schema_version: 6, media: [{ id: "m", kind: "audio", name: "song.mp3", uri: "u" }],
  sequences: [{ id: "s", name: "s", frame_rate: { num: 30, den: 1 }, resolution: { width: 1280, height: 720 }, sample_rate: 48000,
    tracks: [{ id: "tv", kind: "video", name: "V1", clips: link ? [link] : [], locked: false, muted: false }, { id: "ta", kind: "audio", name: "A1", clips, locked: false, muted: false }] }],
});

test("values read from a clip: a plain clip is full volume with no fades", () => {
  assert.deepEqual(audioOf(clip("a")), { volume: 1, fadeIn: 0, fadeOut: 0 });
  assert.deepEqual(audioOf(clip("a", { audio: { volume: 0.5, fade_out: 2 * TICKS } })), { volume: 0.5, fadeIn: 0, fadeOut: 2 * TICKS });
});

test("clamping: volume 0 to 200 percent in whole percent, fades 0 to half the clip on a 10 ms grid", () => {
  const d = 10 * TICKS;
  assert.deepEqual(clampAudio({ volume: 3, fadeIn: -5, fadeOut: 99 * TICKS }, d), { volume: 2, fadeIn: 0, fadeOut: 5 * TICKS });
  assert.equal(clampAudio({ volume: 0.3333, fadeIn: 0, fadeOut: 0 }, d).volume, 0.33);
  assert.equal(clampAudio({ volume: -1, fadeIn: 0, fadeOut: 0 }, d).volume, 0);
  assert.equal(maxFadeTicks(d), 5 * TICKS);
  assert.equal(clampAudio({ volume: 1, fadeIn: 0.123 * TICKS, fadeOut: 0 }, d).fadeIn, 0.12 * TICKS);
  // a short clip: both fades at their maximum never overlap
  const m = maxFadeTicks(1 * TICKS);
  assert.ok(m * 2 <= TICKS);
});

test("the op carries the clamped values in the engine's names", () => {
  const op = audioOp(clip("a"), { volume: 0.5, fadeIn: TICKS, fadeOut: 0 });
  assert.deepEqual(op, { op: "set_clip_audio", clip: "a", audio: { volume: 0.5, fade_in: TICKS, fade_out: 0 } });
});

test("Mute clip: volume 0 remembering the old level, Unmute brings it back; one op per sound", () => {
  const a = clip("a", { audio: { volume: 0.7 } });
  const muted = muteOps([a]);
  assert.equal(muted.muting, true);
  assert.deepEqual(muted.ops.map((o) => (o as { audio: { volume: number } }).audio.volume), [0]);
  assert.equal(levelBeforeMute("a"), 0.7);
  const back = muteOps([clip("a", { audio: { volume: 0 } })]);
  assert.equal(back.muting, false);
  assert.equal((back.ops[0] as { audio: { volume: number } }).audio.volume, 0.7);
  assert.equal(levelBeforeMute("never-muted"), 1);
  // two sounds, one already silent: muting mutes the loud one only
  assert.equal(muteOps([clip("b", { audio: { volume: 0 } }), clip("c")]).ops.length, 1);
});

test("which clip a volume edit lands on: the sound, or a picture's linked sound", () => {
  const sound = clip("s1", { link: "L" });
  const pic = clip("v1", { link: "L" });
  const p = project([sound], pic);
  assert.equal(soundTarget(p, new Set(["s1"]))?.clip.id, "s1");
  assert.equal(soundTarget(p, new Set(["v1"]))?.clip.id, "s1", "the picture's sound");
  assert.equal(soundTarget(p, new Set(["v1", "s1"]))?.clip.id, "s1");
  assert.ok(soundTarget(p, new Set(["v1"]))?.picture, "knows there is a picture");
  assert.equal(soundTarget(project([clip("lone")]), new Set(["lone"]))?.picture, null, "a music clip alone");
  assert.equal(soundTarget(project([clip("x")], clip("nolink")), new Set(["nolink"])), null, "a picture without sound");
  assert.equal(soundTarget(project([clip("x"), clip("y", { start: 11 * TICKS })]), new Set(["x", "y"])), null, "two sounds: no single target");
  assert.deepEqual(mutableSounds(p, new Set(["v1"])).map((c) => c.id), ["s1"]);
});

const view: View = { pps: 40, scrollX: 0, scrollY: 0, width: 900, height: 400, gutter: GUTTER_WIDE };
const AUDIO_ROW = 1; // the fixture lists video, then audio
const laneY = RULER + AUDIO_ROW * LANE;

function setup(audio?: Clip["audio"]) {
  const p = fixtureProject({ tracks: 2, clipsPerTrack: 2, clipSec: 8 });
  if (audio) p.sequences[0]!.tracks[1]!.clips[0]!.audio = audio;
  const scene = buildScene(p);
  const first = scene.trackFirst[AUDIO_ROW]!;
  const sel = new Set([scene.id[first]!]);
  const c: Ctx = { scene, view, selected: sel, selFlags: flagsOf(scene, indicesOf(scene, sel)) };
  return { scene, first, c, x0: GUTTER_WIDE + scene.start[first]! * view.pps + 1, w: (scene.end[first]! - scene.start[first]!) * view.pps - 2 };
}
const ev = (x: number, y: number): PEvent => ({ x, y, kind: "mouse", shift: false, additive: false });

test("the volume line sits at its level: 100% in the middle, 200% at the top, silence at the bottom", () => {
  assert.equal(levelY(0, 2), LINE_TOP);
  assert.equal(levelY(0, 0), LINE_BOT);
  assert.equal(levelY(0, 1), (LINE_TOP + LINE_BOT) / 2);
  assert.equal(levelY(0, 9), LINE_TOP, "clamped");
});

test("only a selected sound has a line and handles to grab; a drag on the line becomes one set_clip_audio", () => {
  const { scene, first, c, x0, w } = setup({ volume: 0.5 });
  const mid = x0 + w / 2;
  const onLine = levelY(laneY, 0.5);
  const hit = audioHit(scene, view, c.selFlags, mid, onLine, false);
  assert.deepEqual(hit, { clip: first, part: "vol" });
  assert.equal(audioHit(scene, view, new Uint8Array(scene.clipCount), mid, onLine, false), null, "an unselected clip is moved, not volume-dragged");
  assert.equal(audioHit(scene, view, c.selFlags, mid, onLine - 20, false), null, "off the line: the body");
  assert.deepEqual(audioHit(scene, view, c.selFlags, mid, onLine + 12, true), { clip: first, part: "vol" }, "a finger has a wider band");

  const down = pointerDown(c, ev(mid, onLine));
  assert.equal(down.g.k, "audio");
  // 19 px up = 1/2 of the 38 px travel = +100%: from 50% to 150%
  const up19 = pointerMove(c, down.g, ev(mid, onLine - 19));
  assert.equal(up19.g.k === "audio" && up19.g.to.volume, 1.5);
  const done = pointerUp(c, up19.g, ev(mid, onLine - 19));
  assert.deepEqual(done.fx.ops, [{ op: "set_clip_audio", clip: scene.id[first], audio: { volume: 1.5, fade_in: 0, fade_out: 0 } }]);
  assert.equal(done.fx.say?.key, "timeline.say.volume");
  assert.equal(done.fx.say?.values?.percent, 150);
});

test("a press on the line that does not move changes nothing; the line clicks onto 100%", () => {
  const { scene, first, c, x0, w } = setup({ volume: 0.5 });
  const mid = x0 + w / 2, y = levelY(laneY, 0.5);
  const down = pointerDown(c, ev(mid, y));
  const still = pointerMove(c, down.g, ev(mid, y - SLOP));
  assert.equal(pointerUp(c, still.g, ev(mid, y - SLOP)).fx.ops, undefined, "inside the slop: nothing");
  // 0.5 -> about 0.99: snaps to exactly 1
  const d = startAudioDrag(scene, { clip: first, part: "vol" }, mid, y);
  const near = dragAudio(scene, d, view, mid, y - (0.49 / 2) * (LINE_BOT - LINE_TOP), SLOP);
  assert.equal(near.to.volume, 1);
});

test("fade handles: dragging the left dot right sets the fade in, the right dot left sets the fade out, at most half the clip", () => {
  const { scene, first, c, x0, w } = setup();
  const top = laneY + 3;
  const inHit = audioHit(scene, view, c.selFlags, x0, top, false);
  assert.deepEqual(inHit, { clip: first, part: "in" });
  assert.deepEqual(audioHit(scene, view, c.selFlags, x0 + w, top, false), { clip: first, part: "out" });
  const down = pointerDown(c, ev(x0, top));
  assert.equal(down.g.k === "audio" && down.g.part, "in");
  const moved = pointerMove(c, down.g, ev(x0 + 80, top)); // 80 px at 40 px/s = 2 s
  const ops = pointerUp(c, moved.g, ev(x0 + 80, top)).fx.ops as { audio: { fade_in: number } }[];
  assert.equal(ops[0]!.audio.fade_in, 2 * TICKS);
  // far past the middle: limited to half the clip
  const way = dragAudio(scene, startAudioDrag(scene, { clip: first, part: "in" }, x0, top), view, x0 + 5000, top, SLOP);
  assert.equal(way.to.fadeIn, maxFadeTicks(scene.tDur[first]!));
  const out = dragAudio(scene, startAudioDrag(scene, { clip: first, part: "out" }, x0 + w, top), view, x0 + w - 40, top, SLOP);
  assert.equal(out.to.fadeOut, 1 * TICKS, "dragging the right dot left grows the fade out");
  assert.equal(audioDragOps(scene, startAudioDrag(scene, { clip: first, part: "out" }, x0, top)), null, "no change, no op");
});

test("a locked track has no line to grab; a clip too narrow shows none", () => {
  const { scene, c, x0, w } = setup({ volume: 0.5 });
  scene.trackLocked[AUDIO_ROW] = 1;
  assert.equal(audioHit(scene, view, c.selFlags, x0 + w / 2, levelY(laneY, 0.5), false), null);
  scene.trackLocked[AUDIO_ROW] = 0;
  const narrow: View = { ...view, pps: 3 };
  assert.equal(audioHit(scene, narrow, c.selFlags, GUTTER_WIDE + 5, levelY(laneY, 0.5), false), null);
});

test("the scene carries volume and fades per clip", () => {
  const { scene, first } = setup({ volume: 0.25, fade_in: TICKS, fade_out: 2 * TICKS });
  assert.deepEqual([scene.volume[first], scene.tFadeIn[first], scene.tFadeOut[first]], [0.25, TICKS, 2 * TICKS]);
  assert.equal(scene.volume[scene.trackFirst[0]!], 1, "a clip without audio is at full volume");
});
