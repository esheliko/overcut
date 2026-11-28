import assert from "node:assert/strict";
import { test } from "node:test";
import type { Clip, Project } from "@app/engine-client";
import { HOLD_DELAY, repeatFrames, repeatInterval } from "../../apps/web/src/preview/holdSchedule";
import { trimEdgeFrame, trimPreview } from "../../apps/web/src/timeline/trimPreview";
import { CK_MUSIC, CK_OVERLAY, CK_PHOTO, CK_SOUND, CK_VIDEO, buildScene } from "../../apps/web/src/timeline/scene";
import { loadZoom, saveZoom } from "../../apps/web/src/timeline/zoomStore";
import { MAX_PPS, MIN_PPS } from "../../apps/web/src/timeline/view";

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m }; };

test("a project's zoom is remembered per project and forgotten on Fit", () => {
  const s = mem();
  assert.equal(loadZoom("a", s), null);
  saveZoom("a", 123.4567, s);
  saveZoom("b", 8, s);
  assert.equal(loadZoom("a", s), 123.457);
  assert.equal(loadZoom("b", s), 8);
  saveZoom("a", null, s);
  assert.equal(loadZoom("a", s), null);
  assert.equal(loadZoom("b", s), 8);
});

test("a saved zoom that is not a usable number is ignored; one out of range is clamped; blocked storage never throws", () => {
  const s = mem();
  s.setItem("overcut.zoom.x", "abc"); assert.equal(loadZoom("x", s), null);
  s.setItem("overcut.zoom.x", "-4"); assert.equal(loadZoom("x", s), null);
  s.setItem("overcut.zoom.x", "99999"); assert.equal(loadZoom("x", s), MAX_PPS);
  s.setItem("overcut.zoom.x", "0.0000001"); assert.equal(loadZoom("x", s), MIN_PPS);
  const bad = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
  assert.equal(loadZoom("x", bad), null);
  assert.doesNotThrow(() => saveZoom("x", 10, bad));
  assert.equal(loadZoom("x", null), null);
});

test("held frame step: waits 400 ms, repeats, speeds up to one frame of 30 fps, then takes bigger steps", () => {
  assert.equal(HOLD_DELAY, 400);
  assert.equal(repeatInterval(0), 160);
  let prev = repeatInterval(0);
  for (let n = 1; n < 40; n++) { const w = repeatInterval(n); assert.ok(w <= prev, `interval ${n} must not grow`); prev = w; }
  assert.equal(repeatInterval(60), 33);
  assert.equal(repeatFrames(0), 1);
  assert.equal(repeatFrames(20), 2);
  assert.equal(repeatFrames(40), 4);
  // 1.2 s of holding (the audit's case) must move far more than one frame: the press, then repeats from 400 ms.
  let t = HOLD_DELAY, frames = 1, n = 0;
  while (t <= 1200) { frames += repeatFrames(n); t += repeatInterval(n); n++; }
  assert.ok(frames >= 6, `held 1.2 s moved ${frames} frames`);
});

test("the frame under a trimmed edge stays inside the clip as it is now", () => {
  // a clip 2 s .. 4 s at 30 fps: frames 60 .. 119
  assert.equal(trimEdgeFrame("start", 2.5, 2, 4, 30), 75);
  assert.equal(trimEdgeFrame("end", 3, 2, 4, 30), 89); // the last frame shown before the new out point
  assert.equal(trimEdgeFrame("start", 1, 2, 4, 30), 60); // dragged past the start: the first frame
  assert.equal(trimEdgeFrame("end", 9, 2, 4, 30), 119); // dragged past the end: the last frame
  assert.equal(trimEdgeFrame("end", 1, 2, 4, 30), 60); // trimmed to nothing: still a frame of the clip
});

test("the trim preview store announces changes once and clears", () => {
  let n = 0;
  const off = trimPreview.subscribe(() => n++);
  trimPreview.set(10); trimPreview.set(10); trimPreview.set(11); trimPreview.set(null); trimPreview.set(null);
  off();
  assert.equal(n, 3);
  assert.equal(trimPreview.get(), null);
});

const clip = (id: string, media: string, over: Partial<Clip> = {}): Clip => ({ id, media, start: 0, source_in: 0, duration: 705_600_000 * 4, ...over });
const project: Project = {
  id: "p", name: "p", schema_version: 6,
  media: [{ id: "v", kind: "video", name: "v.mp4", uri: "u" }, { id: "i", kind: "image", name: "i.png", uri: "u" }, { id: "a", kind: "audio", name: "song.mp3", uri: "u" }],
  sequences: [{ id: "s", name: "s", frame_rate: { num: 30, den: 1 }, resolution: { width: 1280, height: 720 }, sample_rate: 48000, tracks: [
    { id: "t0", kind: "video", name: "V1", clips: [clip("c1", "v"), clip("c2", "i", { start: 705_600_000 * 4 })], locked: false, muted: false },
    { id: "t1", kind: "video", name: "V2", clips: [clip("c3", "i")], locked: false, muted: false },
    { id: "t2", kind: "audio", name: "A1", clips: [clip("c4", "v", { link: "L" })], locked: false, muted: false },
    { id: "t3", kind: "audio", name: "A2", clips: [clip("c5", "a")], locked: false, muted: false },
  ] }],
};

test("clips are coloured by what they are: video, photo, overlay, camera sound, music", () => {
  const sc = buildScene({ ...project, sequences: [{ ...project.sequences[0]!, tracks: project.sequences[0]!.tracks.map((t) => (t.id === "t0" ? { ...t, clips: t.clips.map((c) => (c.id === "c1" ? { ...c, link: "L" } : c)) } : t)) }] });
  const kind = (id: string) => sc.clipKind[sc.id.indexOf(id)];
  assert.equal(kind("c1"), CK_VIDEO);
  assert.equal(kind("c2"), CK_PHOTO);
  assert.equal(kind("c3"), CK_OVERLAY); // a picture above the main track is an overlay, still or not
  assert.equal(kind("c4"), CK_SOUND);
  assert.equal(kind("c5"), CK_MUSIC);
  const lane = (name: string) => sc.trackMusic[sc.trackName.indexOf(name)];
  assert.equal(lane("A1"), 0);
  assert.equal(lane("A2"), 1); // the music lane is told apart from the camera sound's
  assert.equal(lane("V1"), 0);
});
