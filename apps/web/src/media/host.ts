/** What the media layer needs from the host's decoders (WebCodecs worker on the web, native decoders in the shells; M1-016).
 *  `FakeMediaHost` stands in until a real decoder is wired, and for the sample project, tests and the S8 bench. */
import type { MediaRef } from "@app/engine-client";

export interface AudioFormat { sampleRate: number; channels: number; frames: number }

export interface MediaHost {
  /** Null when the media has no audio. */
  audioFormat(media: MediaRef): Promise<AudioFormat | null>;
  /** Interleaved i16 PCM for frames [start, start + frames), clamped to the stream end (a short or empty result is the end). */
  readAudio(media: MediaRef, startFrame: number, frames: number): Promise<Int16Array>;
  /** A decoded video frame near `seconds`, scaled to fit `width` x `height` (cover). The caller owns (and closes) the bitmap. */
  thumbnail(media: MediaRef, seconds: number, width: number, height: number): Promise<ImageBitmap>;
}

function seed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Deterministic synthetic media: a few-seconds-long tone with a slow envelope and beats, and gradient frames labelled with the time. */
export class FakeMediaHost implements MediaHost {
  constructor(private opts: { seconds?: number; sampleRate?: number; channels?: number } = {}) {}
  private get rate() { return this.opts.sampleRate ?? 48000; }
  async audioFormat(media: MediaRef): Promise<AudioFormat | null> {
    if (media.kind !== "audio" && media.kind !== "video") return null;
    return { sampleRate: this.rate, channels: this.opts.channels ?? 2, frames: Math.round((this.opts.seconds ?? 600) * this.rate) };
  }
  async readAudio(media: MediaRef, startFrame: number, frames: number): Promise<Int16Array> {
    const fmt = (await this.audioFormat(media))!;
    const n = Math.max(0, Math.min(frames, fmt.frames - startFrame));
    const out = new Int16Array(n * fmt.channels);
    const s = seed(media.uri), f0 = 110 + (s % 330), beat = 1.5 + (s % 7) / 4;
    for (let i = 0; i < n; i++) {
      const t = (startFrame + i) / fmt.sampleRate;
      const env = 0.15 + 0.85 * Math.abs(Math.sin(t * beat)) * (0.6 + 0.4 * Math.sin(t * 0.37 + s));
      const v = Math.round(Math.sin(t * f0 * 2 * Math.PI) * env * 26000);
      for (let c = 0; c < fmt.channels; c++) out[i * fmt.channels + c] = c === 0 ? v : Math.round(v * 0.9);
    }
    return out;
  }
  async thumbnail(media: MediaRef, seconds: number, width: number, height: number): Promise<ImageBitmap> {
    const c = new OffscreenCanvas(width, height);
    const g = c.getContext("2d")!;
    const hue = (seed(media.uri) % 360 + seconds * 6) % 360;
    const grad = g.createLinearGradient(0, 0, width, height);
    grad.addColorStop(0, `hsl(${hue} 60% 38%)`);
    grad.addColorStop(1, `hsl(${(hue + 50) % 360} 60% 22%)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, width, height);
    g.fillStyle = "rgba(255,255,255,0.85)";
    g.font = `600 ${Math.round(height / 4)}px system-ui, sans-serif`;
    g.textBaseline = "middle";
    g.fillText(`${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`, 6, height / 2);
    return c.transferToImageBitmap();
  }
}

/** Restricts a host to the sample project's synthetic media (`uri` starting with `fixture:`), so imported files never show made-up waveforms
 *  or frames: they keep placeholders until a real host serves them. */
export function onlyFixtures(host: MediaHost): MediaHost {
  const ok = (m: MediaRef) => m.uri.startsWith("fixture:");
  return {
    audioFormat: async (m) => (ok(m) ? host.audioFormat(m) : null),
    readAudio: (m, s, n) => (ok(m) ? host.readAudio(m, s, n) : Promise.resolve(new Int16Array(0))),
    thumbnail: (m, t, w, h) => (ok(m) ? host.thumbnail(m, t, w, h) : Promise.reject(new Error("no decoder for this media"))),
  };
}
