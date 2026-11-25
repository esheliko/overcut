/**
 * Pure import logic (no DOM, no engine): what kind of file is this, what does the project look like after adding it,
 * which edit ops put it on the timeline. Unit tests: tests/unit/media-plan.test.ts. Behaviour: docs/features/media-bin.md.
 */
import { adoptedFormat } from "../canvas";
import type { Clip, MediaKind, MediaRef, Op, Project, Rational, Resolution, Track } from "@app/engine-client";

/** Ticks per second (ADR 0010). */
export const TICKS = 705_600_000;
/** A still image sits on the timeline this long until the user trims it. */
export const STILL_SECONDS = 5;

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
/** A fresh 32-hex id (the form the engine requires for ids a caller creates). */
export const newId = (): string => hex(crypto.getRandomValues(new Uint8Array(16)));

const VIDEO_EXT = new Set(["mp4", "m4v", "mov", "webm", "mkv", "avi", "mpg", "mpeg", "3gp", "ts", "mts", "m2ts", "wmv", "flv", "ogv"]);
const AUDIO_EXT = new Set(["m4a", "mp3", "aac", "wav", "ogg", "oga", "opus", "flac", "aif", "aiff", "wma"]);
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp", "heic", "heif"]);

/** An engine message as a sentence: first letter up, a full stop at the end (it is shown inside a longer message). */
export const sentence = (m: string): string => {
  const t = m.trim();
  return t === "" ? t : `${t[0]!.toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? "" : "."}`;
};

export const extOf = (name: string): string => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "");

/** Video, audio or image by MIME type, falling back to the extension (phones and some desktops give no type). `null` = not media. */
export function classify(name: string, mime: string): MediaKind | null {
  const major = mime.split("/")[0];
  if (major === "video" || major === "audio" || major === "image") return major;
  const e = extOf(name);
  if (VIDEO_EXT.has(e)) return "video";
  if (AUDIO_EXT.has(e)) return "audio";
  if (IMAGE_EXT.has(e)) return "image";
  return null;
}

/** What import learned about a file. */
export interface Probed {
  kind: MediaKind;
  /** Source length in ticks; `null` for a still. */
  durationTicks: number | null;
  width?: number;
  height?: number;
  /** Clockwise display rotation of the video (90 and 270 swap width and height). */
  rotation?: number;
  fps?: Rational;
  hasAudio: boolean;
  hasVideo: boolean;
}

export const DEFAULT_RATE: Rational = { num: 30, den: 1 };

export const clipCount = (p: Project): number => p.sequences.reduce((n, s) => n + s.tracks.reduce((m, t) => m + t.clips.length, 0), 0);

/** End of the last clip on any track of the first sequence, in ticks. */
export function timelineEnd(p: Project): number {
  let end = 0;
  for (const t of p.sequences[0]?.tracks ?? []) for (const c of t.clips) end = Math.max(end, c.start + c.duration);
  return end;
}

/** Frame rate and size the sequence should take from this file, or `null` when it has no picture. */
export function sequenceFrom(p: Probed): { frame_rate: Rational; resolution: Resolution } | null {
  if (!p.hasVideo || !p.width || !p.height) return null;
  const turned = p.rotation === 90 || p.rotation === 270;
  const [w, h] = turned ? [p.height, p.width] : [p.width, p.height];
  const fps = p.fps && p.fps.num > 0 && p.fps.den > 0 ? p.fps : DEFAULT_RATE;
  return { frame_rate: fps, resolution: { width: w, height: h } };
}

/** True while no picture has been added: the next picture sets the sequence's frame rate and size. */
export const sequenceIsUnset = (p: Project): boolean => !p.media.some((m) => m.kind !== "audio");

export function mediaRef(id: string, name: string, uri: string, probed: Probed, hash: string | null): MediaRef {
  return { id, kind: probed.kind, name, uri, duration: probed.kind === "image" ? null : probed.durationTicks, hash };
}

/**
 * The ops that record an import: the media entry and, for the first picture, the sequence's frame rate and size. Applied together with
 * the timeline insert (first import) as one undo step.
 */
export function importOps(p: Project, ref: MediaRef, probed: Probed): Op[] {
  const ops: Op[] = [{ op: "add_media", media: ref }];
  const seq = p.sequences[0];
  // The first picture sets size and frame rate ("match first clip") except for what the user fixed in the canvas settings.
  const from = seq && sequenceIsUnset(p) ? sequenceFrom(probed) : null;
  const adopt = seq && from ? adoptedFormat(seq, from) : null;
  if (seq && adopt) ops.push({ op: "set_sequence_format", sequence: seq.id, ...adopt });
  return ops;
}

/** Where a clip of `length` should start: at `want` if both tracks are free there, else after everything already on the timeline. */
export function placeAt(p: Project, want: number, length: number, only?: readonly string[]): number {
  const tracks = (p.sequences[0]?.tracks ?? []).filter((t) => !only || only.includes(t.id));
  const free = tracks.every((t) => t.clips.every((c) => want + length <= c.start || c.start + c.duration <= want));
  return free ? Math.max(0, want) : timelineEnd(p);
}

/** The tracks a media item goes on: the first unlocked video and audio track, except that `target` (a dropped-on lane) takes the slot of its own kind. */
export function destTracks(p: Project, media: MediaRef, target?: string): { vt: Track | undefined; at: Track | undefined } {
  const tracks = p.sequences[0]?.tracks ?? [];
  const aim = tracks.find((t) => t.id === target && !t.locked);
  const pick = (kind: Track["kind"]) => (aim && aim.kind === kind && (kind === "audio" || media.kind !== "audio") ? aim : tracks.find((t) => t.kind === kind && !t.locked));
  return { vt: pick("video"), at: pick("audio") };
}

/**
 * The ops that put `media` on the timeline at `start`: a video file gives a clip on the first video track plus, when it has sound,
 * a matching clip on the first audio track; audio goes on the audio track; a still gets `STILL_SECONDS`. One array = one undo step.
 * Returns `null` when the sequence has no suitable track.
 */
export function insertOps(p: Project, media: MediaRef, probed: Probed, start: number, ids: () => string = newId, target?: string): Op[] | null {
  const { vt, at } = destTracks(p, media, target);
  const duration = media.kind === "image" ? STILL_SECONDS * TICKS : media.duration ?? 0;
  if (duration <= 0) return null;
  const link = ids(); // the picture and the sound of one video import are linked: they select, move, trim and cut together
  const clip = (linked = false): Clip => ({ id: ids(), media: media.id, start, source_in: 0, duration, ...(linked ? { link } : {}) });
  const ops: Op[] = [];
  if (media.kind === "audio") {
    if (!at) return null;
    ops.push({ op: "insert_clip", track: at.id, clip: clip() });
  } else {
    if (!vt) return null;
    const withSound = media.kind === "video" && probed.hasAudio && at;
    ops.push({ op: "insert_clip", track: vt.id, clip: clip(!!withSound) });
    if (withSound) ops.push({ op: "insert_clip", track: at.id, clip: clip(true) });
  }
  return ops;
}

/** "1:05", "0:07", "1:02:03": a length for a card. */
export function formatDuration(ticks: number | null | undefined): string {
  if (ticks == null) return "";
  const s = Math.max(0, Math.round(ticks / TICKS));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/** Short codec label for a card, from a WebCodecs string ("avc1.64001f" -> "H.264"). */
export function codecLabel(codec: string | undefined): string {
  if (!codec) return "";
  const c = codec.toLowerCase();
  if (c.startsWith("avc")) return "H.264";
  if (c.startsWith("hvc") || c.startsWith("hev")) return "H.265";
  if (c.startsWith("vp09")) return "VP9";
  if (c.startsWith("vp8")) return "VP8";
  if (c.startsWith("av01")) return "AV1";
  if (c.startsWith("mp4a")) return "AAC";
  return codec.toUpperCase();
}

/**
 * Why a card is offline. `moved`: a path or handle was kept and the file is gone or needs permission. `reopen`: the file came from a plain
 * file input, which no browser lets a page keep across a reload, so it has to be chosen again (one click, nothing was lost).
 */
export const offlineReason = (uri: string | undefined): "moved" | "reopen" => (uri?.startsWith("file:") ? "reopen" : "moved");
