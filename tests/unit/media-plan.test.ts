import assert from "node:assert/strict";
import { test } from "node:test";
import { STILL_SECONDS, TICKS, classify, clipCount, codecLabel, formatBytes, formatDuration, iconForKind, importOps, insertOps, mediaRef, placeAt, sentence, sequenceFrom, sequenceIsUnset, timelineEnd, type Probed } from "../../apps/web/src/media/plan";
import { probeFile } from "../../apps/web/src/media/probe";
import type { Engine } from "../../packages/engine-client/src/index";
import { newProject as emptyProject } from "../../packages/engine-client/src/project";

const video: Probed = { kind: "video", durationTicks: 10 * TICKS, width: 1080, height: 1920, rotation: 0, fps: { num: 24000, den: 1001 }, hasAudio: true, hasVideo: true };
const counter = () => { let n = 0; return () => (++n).toString(16).padStart(32, "0"); };

test("classify uses the MIME type, then the extension (phones often give no type)", () => {
  assert.equal(classify("a.bin", "video/mp4"), "video");
  assert.equal(classify("IMG_0001.MOV", ""), "video");
  assert.equal(classify("song.m4a", ""), "audio");
  assert.equal(classify("photo.HEIC", ""), "image");
  assert.equal(classify("notes.pdf", "application/pdf"), null);
  assert.equal(classify("noext", ""), null);
});

test("the bin icon is the audio icon for audio, the video icon for video, the still icon for images", () => {
  assert.equal(iconForKind("audio"), "audio");
  assert.equal(iconForKind("video"), "video");
  assert.equal(iconForKind("image"), "media");
});

test("the first picture sets frame rate and size, rotated phone video swaps its sides; audio sets nothing", () => {
  assert.deepEqual(sequenceFrom(video), { frame_rate: { num: 24000, den: 1001 }, resolution: { width: 1080, height: 1920 } });
  assert.deepEqual(sequenceFrom({ ...video, rotation: 90 })?.resolution, { width: 1920, height: 1080 });
  assert.equal(sequenceFrom({ kind: "audio", durationTicks: TICKS, hasAudio: true, hasVideo: false }), null);
  assert.deepEqual(sequenceFrom({ ...video, fps: undefined })?.frame_rate, { num: 30, den: 1 }); // variable frame rate: the default
});

test("only the first picture adopts its settings; the media entry always comes first", () => {
  const p0 = emptyProject("x");
  const vref = mediaRef("v", "v.mp4", "u", video, null);
  const aud: Probed = { kind: "audio", durationTicks: TICKS, hasAudio: true, hasVideo: false };
  const aref = mediaRef("a", "a.m4a", "u", aud, null);
  assert.equal(sequenceIsUnset(p0), true);
  const first = importOps(p0, vref, video);
  assert.deepEqual(first.map((o) => o.op), ["add_media", "set_sequence_format"]);
  assert.deepEqual(first[1], { op: "set_sequence_format", sequence: p0.sequences[0]!.id, frame_rate: { num: 24000, den: 1001 }, resolution: { width: 1080, height: 1920 } });
  assert.deepEqual(importOps(p0, aref, aud).map((o) => o.op), ["add_media"]); // audio never changes the sequence
  const afterAudio = { ...p0, media: [aref] };
  assert.equal(sequenceIsUnset(afterAudio), true);
  assert.deepEqual(importOps(afterAudio, vref, video).map((o) => o.op), ["add_media", "set_sequence_format"]);
  const afterVideo = { ...p0, media: [vref] };
  assert.equal(sequenceIsUnset(afterVideo), false);
  assert.deepEqual(importOps(afterVideo, { ...vref, id: "w" }, video).map((o) => o.op), ["add_media"]);
});

test("a video with sound becomes two clips in ONE op list (one undo step); audio and stills go where they belong", () => {
  const p = emptyProject("x");
  const [v, a] = p.sequences[0]!.tracks;
  const ref = mediaRef("m1", "v.mp4", "u", video, null);
  const ops = insertOps(p, ref, video, 0, counter())!;
  assert.equal(ops.length, 2);
  assert.deepEqual(ops.map((o) => (o.op === "insert_clip" ? o.track : "")), [v!.id, a!.id]);
  assert.ok(ops.every((o) => o.op === "insert_clip" && o.clip.duration === 10 * TICKS && o.clip.start === 0 && o.clip.source_in === 0));

  const silent = insertOps(p, ref, { ...video, hasAudio: false }, 0)!;
  assert.equal(silent.length, 1);

  const song = mediaRef("m2", "s.m4a", "u", { kind: "audio", durationTicks: 3 * TICKS, hasAudio: true, hasVideo: false }, null);
  const audioOps = insertOps(p, song, { kind: "audio", durationTicks: 3 * TICKS, hasAudio: true, hasVideo: false }, 0)!;
  assert.deepEqual(audioOps.map((o) => (o.op === "insert_clip" ? o.track : "")), [a!.id]);

  const still = mediaRef("m3", "p.jpg", "u", { kind: "image", durationTicks: null, hasAudio: false, hasVideo: true }, null);
  const stillOps = insertOps(p, still, { kind: "image", durationTicks: null, hasAudio: false, hasVideo: true }, 0)!;
  assert.equal(stillOps.length, 1);
  assert.ok(stillOps[0]!.op === "insert_clip" && stillOps[0]!.clip.duration === STILL_SECONDS * TICKS);
});

test("placement: the wanted spot when free, else after everything; a project without tracks refuses", () => {
  let p = emptyProject("x");
  const ref = mediaRef("m1", "v.mp4", "u", video, null);
  const first = insertOps(p, ref, video, 0, counter())!;
  p = { ...p, media: [ref], sequences: [{ ...p.sequences[0]!, tracks: p.sequences[0]!.tracks.map((t, i) => ({ ...t, clips: [first[i]!.op === "insert_clip" ? first[i]!.clip : (undefined as never)] })) }] };
  assert.equal(clipCount(p), 2);
  assert.equal(timelineEnd(p), 10 * TICKS);
  assert.equal(placeAt(p, 12 * TICKS, 5 * TICKS), 12 * TICKS); // free
  assert.equal(placeAt(p, 4 * TICKS, 2 * TICKS), 10 * TICKS); // inside a clip: goes to the end
  assert.equal(placeAt(p, 8 * TICKS, 5 * TICKS), 10 * TICKS); // would overlap the tail
  assert.equal(insertOps({ ...p, sequences: [{ ...p.sequences[0]!, tracks: [] }] }, ref, video, 0), null);
});

test("labels for cards", () => {
  assert.equal(formatDuration(65 * TICKS), "1:05");
  assert.equal(formatDuration(3723 * TICKS), "1:02:03");
  assert.equal(formatDuration(null), "");
  assert.equal(formatBytes(2 * 1024 ** 3), "2.0 GB");
  assert.equal(formatBytes(1500), "1 KB");
  assert.equal(codecLabel("avc1.64001f"), "H.264");
  assert.equal(codecLabel("hvc1.1.6.L93.B0"), "H.265");
  assert.equal(codecLabel("opus"), "OPUS");
});

test("an engine message becomes a sentence before it is shown inside a longer one", () => {
  assert.equal(sentence("unknown container format"), "Unknown container format.");
  assert.equal(sentence("This device cannot decode H.265 (HEVC) video."), "This device cannot decode H.265 (HEVC) video.");
  assert.equal(sentence("  Really?  "), "Really?");
  assert.equal(sentence(""), "");
});

test("probe: the tracks decide the kind, so an audio-only .webm named as video imports as audio; a file with no usable track is refused in words", async () => {
  const track = { codec: "opus", width: 0, height: 0, rotation: 0, sampleRate: 48000, channels: 2, durationTicks: 5 * TICKS, packets: 250, vfr: false };
  const engineWith = (info: unknown): Engine => ({ media: { open: async () => ({ info, close: async () => undefined }) } }) as unknown as Engine;
  const ok = await probeFile(engineWith({ container: "webm", durationTicks: 5 * TICKS, audio: track }), new File(["x"], "voice.webm", { type: "video/webm" }), "video");
  assert.equal(ok.probed.kind, "audio");
  assert.equal(ok.probed.hasVideo, false);
  assert.equal(ok.probed.hasAudio, true);
  // The bin icon follows the tracks: an audio-only .webm (its MIME says video) gets the audio icon, a real video keeps the video icon.
  assert.equal(iconForKind(ok.probed.kind), "audio");
  assert.equal(iconForKind(video.kind), "video");
  await assert.rejects(probeFile(engineWith({ container: "webm", durationTicks: 0 }), new File(["x"], "empty.webm"), "video"), /no picture or sound/);
});
