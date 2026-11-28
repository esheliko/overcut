/** UX r16 lane A: where media lands (one rule), the magnetic main track keeps no gaps, edit-point and marker jumps, range selection, Alt+Up on the top lane. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { TICKS, STILL_SECONDS, insertOps, landingStart, mediaRef, pictureEnd, type Probed } from "../../apps/web/src/media/plan";
import { buildKeymap, resolveKey, findConflicts, PRESETS, type KeyLike } from "../../apps/web/src/commands/registry";
import { lanePlan, laneChanger, laneOps, flagsOf } from "../../apps/web/src/timeline/edit";
import { rangeSelect, pointerDown, type Ctx, type PEvent } from "../../apps/web/src/timeline/interact";
import { jumpTarget } from "../../apps/web/src/timeline/markers";
import { laneStep, leavesHole, liftCloseOps, newLaneKind } from "../../apps/web/src/timeline/ripple";
import { buildScene } from "../../apps/web/src/timeline/scene";
import { gut, LANE, RULER, type View } from "../../apps/web/src/timeline/view";
import { addTrackOp, newTrack, type Project } from "@app/engine-client";
import { newProject } from "../../packages/engine-client/src/project";

const sec = (s: number) => s * TICKS;
const video: Probed = { kind: "video", durationTicks: sec(10), width: 1920, height: 1080, fps: { num: 30, den: 1 }, hasAudio: true, hasVideo: true };
const photo: Probed = { kind: "image", durationTicks: null, width: 1000, height: 1000, hasAudio: false, hasVideo: true };
const music: Probed = { kind: "audio", durationTicks: sec(30), hasAudio: true, hasVideo: false };
const counter = () => { let n = 0; return () => `${++n}`.padStart(32, "0"); };
const id = (s: string) => s.padStart(32, "0");

const clip = (name: string, start: number, dur: number, extra: object = {}) => ({ id: id(name), media: "m1", start: sec(start), source_in: 0, duration: sec(dur), ...extra });

/** V1: 0-12 (v1) | A1: 0-12 (its sound) | music 0-30 on A2. */
function withMusic(): Project {
  const p = structuredClone(newProject("x"));
  p.media.push(mediaRef("m1", "v.mp4", "u", video, null), mediaRef("mu", "m.mp3", "u", music, null));
  const [v, a] = p.sequences[0]!.tracks;
  v!.clips.push(clip("v1", 0, 12));
  a!.clips.push(clip("s1", 0, 12));
  p.sequences[0]!.tracks.push({ ...newTrack(id("a2"), "audio", "A2"), clips: [{ id: id("mu1"), media: "mu", start: 0, source_in: 0, duration: sec(30) }] });
  return p;
}
const ref = (kind: Probed, name = "n") => mediaRef(`new-${name}`, `${name}.x`, "u", kind, null);

// ---- 1. where media lands ----

test("a picture lands right after the last picture on V1, not after the music (DESK-1, FIRST-2)", () => {
  const p = withMusic();
  assert.equal(pictureEnd(p), sec(12));
  assert.equal(landingStart(p, ref(video), { playhead: 0 }), sec(12)); // the project is 30 s long because of the music: still 12
  assert.equal(landingStart(p, ref(photo), { playhead: sec(3) }), sec(12)); // the playhead does not move a picture
});

test("three clicks on + butt together on V1 (DESK-1)", () => {
  let p = withMusic();
  const ends: number[] = [];
  for (let n = 0; n < 3; n++) {
    const r = mediaRef(`m${n}`, `c${n}.mp4`, "u", video, null);
    const withRef: Project = { ...p, media: [...p.media, r] };
    const start = landingStart(withRef, r, { playhead: 0 });
    const ops = insertOps(withRef, r, video, start, counter())!;
    const put = ops.find((o) => o.op === "insert_clip")!;
    assert.ok(put.op === "insert_clip" && put.track === p.sequences[0]!.tracks[0]!.id);
    if (put.op === "insert_clip") { p = structuredClone({ ...withRef }); p.sequences[0]!.tracks[0]!.clips.push({ ...put.clip, id: id(`n${n}`) }); ends.push(put.clip.start + put.clip.duration); }
  }
  assert.deepEqual(ends, [sec(22), sec(32), sec(42)]);
});

test("an empty project: the first picture is at 0, and audio-only items never push the picture point", () => {
  const p = structuredClone(newProject("x"));
  assert.equal(pictureEnd(p), 0);
  const q = structuredClone(p);
  q.sequences[0]!.tracks.push({ ...newTrack(id("a2"), "audio", "A2"), clips: [{ id: id("mu1"), media: "mu", start: 0, source_in: 0, duration: sec(30) }] });
  assert.equal(landingStart(q, ref(photo), { playhead: 0 }), 0);
});

test("audio-only media goes to the playhead (or the drop time) on a free audio track, never after the video (FIRST-2, PHONE-4)", () => {
  const p = withMusic();
  const m = ref(music, "song");
  assert.equal(landingStart(p, m, { playhead: sec(4) }), sec(4));
  assert.equal(landingStart(p, m, { start: sec(7), playhead: sec(4) }), sec(7));
  const withRef: Project = { ...p, media: [...p.media, m] };
  const ops = insertOps(withRef, m, music, sec(4), counter())!;
  const tracks = p.sequences[0]!.tracks.map((t) => t.id);
  const add = ops.find((o) => o.op === "add_track");
  assert.ok(add, "A1 and A2 are busy at 4 s: a new audio track is made");
  const ins = ops.find((o) => o.op === "insert_clip")!;
  assert.ok(ins.op === "insert_clip" && !tracks.includes(ins.track) && ins.clip.start === sec(4));
});

test("a free audio track is reused when there is one at the playhead", () => {
  const p = withMusic();
  p.sequences[0]!.tracks[2]!.clips = []; // A2 empty
  const m = ref(music, "song");
  const ops = insertOps({ ...p, media: [...p.media, m] }, m, music, sec(0), counter())!;
  assert.equal(ops.some((o) => o.op === "add_track"), false);
  const ins = ops.find((o) => o.op === "insert_clip")!;
  assert.ok(ins.op === "insert_clip" && ins.track === id("a2"));
});

test("a batch: pictures follow each other on V1 whatever the music is (FIRST-3)", () => {
  // The import loop calls landingStart per file with the project as it is after the previous file; the photo after beach, city and 30 s of music lands at 20 s.
  let p = structuredClone(newProject("x"));
  p.media.push(mediaRef("m1", "v.mp4", "u", video, null));
  const starts: number[] = [];
  for (const [r, probed] of [[ref(video, "beach"), video], [ref(video, "city"), video], [ref(music, "song"), music], [ref(photo, "photo"), photo]] as const) {
    const withRef: Project = { ...p, media: [...p.media, r] };
    const at = r.kind === "audio" ? 0 : landingStart(withRef, r, { playhead: 0 });
    const ops = insertOps(withRef, r, probed, at, counter())!;
    p = structuredClone(withRef);
    let n = 0;
    for (const o of ops) {
      if (o.op === "add_track") p.sequences[0]!.tracks.push({ ...o.track, clips: [] });
      if (o.op === "insert_clip") { p.sequences[0]!.tracks.find((t) => t.id === o.track)!.clips.push({ ...o.clip, id: `${r.id}-${n++}`.padStart(32, "0") }); if (r.kind !== "audio") starts.push(o.clip.start); }
    }
  }
  // beach 0 (+ its sound), city 10 (+ sound), photo 20: no hole although the music is 30 s
  assert.deepEqual(starts.filter((_, i) => i % 2 === 0 || true).slice(0, 1), [0]);
  const v1 = p.sequences[0]!.tracks[0]!.clips.map((c) => [c.start, c.start + c.duration]);
  assert.deepEqual(v1, [[0, sec(10)], [sec(10), sec(20)], [sec(20), sec(20) + sec(STILL_SECONDS)]]);
});

test("a drop on another video lane (picture in picture) lands at the dropped time when free, else after that lane's last clip", () => {
  const p = withMusic();
  p.sequences[0]!.tracks.push({ ...newTrack(id("v2"), "video", "V2"), clips: [{ ...clip("p1", 2, 4) }] });
  assert.equal(landingStart(p, ref(video), { start: sec(8), playhead: 0, track: id("v2") }), sec(8));
  assert.equal(landingStart(p, ref(video), { start: sec(3), playhead: 0, track: id("v2") }), sec(6)); // 3 s is taken: after the last clip of V2
  assert.equal(landingStart(p, ref(video), { start: sec(3), playhead: 0, track: p.sequences[0]!.tracks[0]!.id }), sec(12)); // dropped on V1: appended
});

// ---- 2. magnetic main track ----

function lifted(): Project {
  // V1: a 0-4 | b 4-8 | c 8-12, each with its sound on A1.
  const p = structuredClone(newProject("x"));
  p.media.push(mediaRef("m1", "v.mp4", "u", video, null));
  const [v, a] = p.sequences[0]!.tracks;
  for (const [n, s] of [["a", 0], ["b", 4], ["c", 8]] as const) {
    v!.clips.push(clip(n, s, 4, { link: id(`l${n}`) }));
    a!.clips.push(clip(`s${n}`, s, 4, { link: id(`l${n}`) }));
  }
  const seq = p.sequences[0]!;
  seq.tracks.push(newTrack(id("v2"), "video", "V2"));
  return p;
}

test("lifting a V1 clip to V2 closes its hole on V1 and moves its sound along, closing that hole too (DESK-5)", () => {
  const p = lifted();
  const sc = buildScene(p);
  const sel = [...Array(sc.clipCount).keys()].filter((i) => sc.id[i] === id("b") || sc.id[i] === id("sb"));
  const v2 = sc.trackId.indexOf(id("v2"));
  const mv = laneChanger(sc, sel, v2)!;
  const plan = lanePlan(sc, sel, flagsOf(sc, sel), mv, 0, true)!;
  const ops = [...laneOps(sc, sel, mv, plan.delta, plan), ...liftCloseOps(sc, sel, plan.to)];
  const gaps = ops.filter((o) => o.op === "close_gap");
  assert.equal(gaps.length, 2, "one on V1, one on the audio lane the sound left");
  assert.ok(gaps.some((g) => g.op === "close_gap" && g.track === p.sequences[0]!.tracks[0]!.id && g.at === sec(6)));
  // the sound left A1 for another lane: a new audio track is made
  assert.ok(ops.some((o) => o.op === "add_track" && o.track.kind === "audio"));
  // without the magnetic main track nothing is closed
  assert.deepEqual(liftCloseOps(sc, [], []), []);
});

test("a clip lifted off the LAST place on V1 leaves no hole to close", () => {
  const p = lifted();
  const sc = buildScene(p);
  const c = sc.id.indexOf(id("c"));
  const v2 = sc.trackId.indexOf(id("v2"));
  assert.deepEqual(liftCloseOps(sc, [c], [v2]), []);
  assert.equal(leavesHole(sc, [c]), false); // so its sound may stay where it is
  assert.equal(leavesHole(sc, [sc.id.indexOf(id("a"))]), true);
  assert.equal(leavesHole(sc, [sc.id.indexOf(id("b")), c]), false); // b and c are the last two: nothing stays after them

});

test("Alt+Up on the magnetic main track lifts and closes the hole (keyboard)", () => {
  const p = lifted();
  const sc = buildScene(p);
  const sel = [...Array(sc.clipCount).keys()].filter((i) => sc.id[i] === id("a") || sc.id[i] === id("sa"));
  const on = laneStep(sc, sel, "up", true)!;
  assert.ok(on.ops.some((o) => o.op === "close_gap"));
  const off = laneStep(sc, sel, "up", false)!;
  assert.ok(!off.ops.some((o) => o.op === "close_gap"));
});

// ---- 5. Alt+Up on the top lane ----

test("Alt+Up on the top video lane wants a new video lane; Alt+Down on the last audio lane a new audio lane; elsewhere nothing", () => {
  const p = structuredClone(newProject("x"));
  p.media.push(mediaRef("m1", "v.mp4", "u", video, null));
  p.sequences[0]!.tracks[0]!.clips.push(clip("a", 0, 4));
  const sc = buildScene(p);
  assert.equal(newLaneKind(sc, [0], "up"), "video");
  assert.equal(newLaneKind(sc, [0], "down"), null);
  const q = structuredClone(p);
  q.sequences[0]!.tracks[1]!.clips.push(clip("s", 0, 4));
  const sq = buildScene(q);
  const snd = sq.id.indexOf(id("s"));
  assert.equal(newLaneKind(sq, [snd], "down"), "audio");
  assert.equal(newLaneKind(sq, [snd], "up"), null);
});

test("the new lane plus the move make one op list that validates against a scene with that track", () => {
  const p = structuredClone(newProject("x"));
  p.media.push(mediaRef("m1", "v.mp4", "u", video, null));
  p.sequences[0]!.tracks[0]!.clips.push(clip("a", 0, 4));
  const sc = buildScene(p);
  const seq = p.sequences[0]!;
  const add = addTrackOp(seq.id, newTrack(id("v2"), "video", "V2"), 1);
  const tracks = [...seq.tracks];
  tracks.splice(add.op === "add_track" ? add.index : 0, 0, add.op === "add_track" ? add.track : (undefined as never));
  const sc2 = buildScene({ ...p, sequences: [{ ...seq, tracks }] });
  const moved = laneStep(sc2, [sc2.id.indexOf(id("a"))], "up", true)!;
  assert.equal(sc2.trackName[moved.track], "V2");
  assert.equal(moved.ops[0]!.op, "move");
  assert.equal(sc.trackCount + 1, sc2.trackCount);
});

// ---- 3. fast navigation ----

test("Up / Down jump to the previous / next edit point on any track; Shift+Up / Down to markers", () => {
  const p = lifted();
  p.sequences[0]!.markers = [{ id: id("k1"), time: sec(2), name: "", colour: null, kind: "marker" }, { id: id("k2"), time: sec(9), name: "", colour: null, kind: "marker" }] as never;
  const sc = buildScene(p);
  assert.equal(jumpTarget(sc, sec(5), "nextCut"), sec(8));
  assert.equal(jumpTarget(sc, sec(5), "prevCut"), sec(4));
  assert.equal(jumpTarget(sc, sec(4), "nextCut"), sec(8)); // on a cut: the NEXT one, not itself
  assert.equal(jumpTarget(sc, sec(12), "nextCut"), null);
  assert.equal(jumpTarget(sc, 0, "prevCut"), null);
  assert.equal(jumpTarget(sc, sec(5), "nextMarker"), sec(9));
  assert.equal(jumpTarget(sc, sec(5), "prevMarker"), sec(2));
  assert.equal(jumpTarget(sc, sec(9), "nextMarker"), null);
});

test("the keys: Up/Down = edit points, Shift+Up/Down = markers, without a selection; no conflicts in any preset", () => {
  const k = (key: string, shiftKey = false): KeyLike => ({ key, code: key, ctrlKey: false, metaKey: false, shiftKey, altKey: false });
  const map = buildKeymap();
  assert.equal(resolveKey(k("ArrowUp"), "canvas", map, false)?.id, "view.prevCut");
  assert.equal(resolveKey(k("ArrowDown"), "canvas", map, false)?.id, "view.nextCut");
  assert.equal(resolveKey(k("ArrowUp", true), "canvas", map, false)?.id, "marker.prev");
  assert.equal(resolveKey(k("ArrowDown", true), "canvas", map, false)?.id, "marker.next");
  assert.equal(resolveKey(k("ArrowUp"), "canvas", map, true)?.id, "select.up"); // with a selection the arrows still move between clips
  for (const preset of PRESETS) assert.deepEqual(findConflicts(buildKeymap({ preset: preset.id, overrides: {} })), []);
  // Option+T on a Mac types a different character: the physical key still matches
  assert.equal(resolveKey({ key: "†", code: "KeyT", ctrlKey: false, metaKey: false, shiftKey: false, altKey: true }, "global", map)?.id, "view.focusTimeline");
});

// ---- 4. selection ----

test("Shift+click selects the range on the same track, or the time range across tracks; without an anchor it toggles", () => {
  const p = lifted();
  const sc = buildScene(p);
  const idx = (n: string) => sc.id.indexOf(id(n));
  assert.deepEqual(rangeSelect(sc, id("a"), idx("c")), [idx("a"), idx("b"), idx("c")]);
  assert.deepEqual(rangeSelect(sc, id("c"), idx("a")), [idx("a"), idx("b"), idx("c")]);
  const across = rangeSelect(sc, id("a"), idx("sb"))!; // V1 clip a, sound of b on A1: everything within 0-8 s on every track
  assert.deepEqual(new Set(across.map((i) => sc.id[i])), new Set([id("a"), id("b"), id("sa"), id("sb")]));
  assert.equal(rangeSelect(sc, null, idx("a")), null);
  assert.equal(rangeSelect(sc, id("gone"), idx("a")), null);

  const view: View = { pps: 50, scrollX: 0, scrollY: 0, width: 1000, height: 400 } as View;
  const x = (s: number) => gut(view) + s * 50 + 10;
  const y = RULER + LANE * sc.clipTrack[idx("a")]! + LANE / 2;
  const ev = (xx: number, extra: Partial<PEvent> = {}): PEvent => ({ x: xx, y, kind: "mouse", shift: false, additive: false, ...extra });
  const ctx: Ctx = { scene: sc, view, selected: new Set([id("a")]), selFlags: flagsOf(sc, [idx("a")]), anchor: id("a") };
  const r = pointerDown(ctx, ev(x(9), { shift: true }));
  assert.equal(r.fx.select?.mode, "set");
  assert.deepEqual(new Set(r.fx.select?.ids), new Set([id("a"), id("b"), id("c")]));
  assert.equal(r.fx.select?.keepAnchor, true);
  const t = pointerDown(ctx, ev(x(5), { additive: true }));
  assert.equal(t.fx.select?.mode, "toggle"); // Ctrl/Cmd+click toggles one clip
});
