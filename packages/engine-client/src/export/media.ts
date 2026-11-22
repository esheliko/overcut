import type { MediaRef } from "../model.generated";
import { TICKS_PER_SECOND } from "./plan";

/** One decoded picture the compositor can draw. `close` releases decoder or GPU memory at once (`VideoFrame.close()`). */
export interface DrawableFrame {
  source: CanvasImageSource;
  width: number;
  height: number;
  /** Display rotation in degrees clockwise (from the container), applied when drawing. Default 0. */
  rotation?: 0 | 90 | 180 | 270;
  close(): void;
}

export interface MediaVideo {
  /** The picture visible at `sourceTicks` of the media (the media's own frame grid, floor). */
  frame(sourceTicks: number): Promise<DrawableFrame>;
  close(): void;
}

export interface MediaAudio {
  /** Fills `out[c]` (one array per channel, length >= `count`) with samples `[startSample, startSample + count)` at the sequence sample rate. Past the end: silence. */
  read(startSample: number, count: number, out: Float32Array[]): Promise<void>;
  close(): void;
}

export interface OpenedMedia {
  video?: MediaVideo;
  audio?: MediaAudio;
}

/** Resolves a project's `MediaRef` to decoders. Returns null when this resolver does not handle the ref's `uri`. M1-016 registers the WebCodecs one. */
export type MediaResolver = (ref: MediaRef, sampleRate: number) => Promise<OpenedMedia | null>;

export const sourceSample = (ticks: number, rate: number): number => Number((BigInt(ticks) * BigInt(rate)) / TICKS_PER_SECOND);

// ---- built-in synthetic media: `test:pattern?w=1280&h=720` (deterministic, no files; used by tests and the export harness) ----

const TEST_FPS = 30;
const CLICK_MS = 3;

/**
 * The same scene as the S3 spike (spikes/s3-encode): dark moving gradient, a bar and a frame counter, and an all-white flash frame once per
 * source second; audio is silence plus a 3 ms 2 kHz click starting at the exact sample where each flash frame starts. Both are pure functions of source time.
 */
export function createTestPatternMedia(uri: string, sampleRate: number): OpenedMedia {
  const q = new URLSearchParams(uri.split("?")[1] ?? "");
  const W = Math.max(16, Number(q.get("w") ?? 1280) | 0);
  const H = Math.max(16, Number(q.get("h") ?? 720) | 0);
  const canvas = new OffscreenCanvas(W, H);
  const g = canvas.getContext("2d");
  if (!g) throw new Error("OffscreenCanvas 2D is not available");
  g.font = `bold ${Math.round(H / 8)}px monospace`;
  const frame: DrawableFrame = { source: canvas, width: W, height: H, close: () => undefined };
  return {
    video: {
      async frame(ticks: number) {
        const i = Number((BigInt(Math.max(0, ticks)) * BigInt(TEST_FPS)) / TICKS_PER_SECOND);
        if (i % TEST_FPS === 0) {
          g.fillStyle = "#fff";
          g.fillRect(0, 0, W, H);
        } else {
          const grad = g.createLinearGradient(0, 0, W, H);
          const h = (i * 2) % 360;
          grad.addColorStop(0, `hsl(${h} 60% 18%)`);
          grad.addColorStop(1, `hsl(${(h + 90) % 360} 60% 10%)`);
          g.fillStyle = grad;
          g.fillRect(0, 0, W, H);
          g.fillStyle = "#e0602a";
          g.fillRect((i * 11) % (W - 200), H * 0.55, 200, 120);
          g.fillStyle = "#cfd8dc";
          g.fillText(String(i).padStart(6, "0"), 40, H * 0.2);
        }
        return frame;
      },
      close: () => undefined,
    },
    audio: createTestPatternAudio(sampleRate),
  };
}

/** Silence plus a 3 ms 2 kHz Hann-shaped click (amplitude 0.8) starting at every whole source second: the audio half of the sync fixture. No canvas needed. */
export function createTestPatternAudio(sampleRate: number): MediaAudio {
  const clickLen = Math.round((CLICK_MS * sampleRate) / 1000);
  return {
    async read(start, count, out) {
      for (const ch of out) ch.fill(0, 0, count);
      const first = Math.floor(start / sampleRate);
      const last = Math.floor((start + count - 1) / sampleRate);
      for (let k = Math.max(0, first); k <= last; k++) {
        const cs = k * sampleRate;
        for (let s = Math.max(cs, start); s < Math.min(cs + clickLen, start + count); s++) {
          const j = s - cs;
          const v = 0.8 * Math.sin((2 * Math.PI * 2000 * j) / sampleRate) * Math.sin((Math.PI * j) / clickLen);
          for (const ch of out) ch[s - start] = v;
        }
      }
    },
    close: () => undefined,
  };
}

const resolvers: MediaResolver[] = [];

/** Registers a resolver for real media (the WebCodecs backend, M1-016). Resolvers are tried in registration order, the built-in `test:` media last. */
export function registerMediaResolver(r: MediaResolver): void {
  resolvers.push(r);
}

export async function openMedia(ref: MediaRef, sampleRate: number): Promise<OpenedMedia | null> {
  for (const r of resolvers) {
    const m = await r(ref, sampleRate);
    if (m) return m;
  }
  return ref.uri.startsWith("test:") ? createTestPatternMedia(ref.uri, sampleRate) : null;
}
