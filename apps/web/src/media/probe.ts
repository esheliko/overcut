/** Looks inside an imported file: what the bin shows (length, size, codec, poster) and what the project needs (frame rate, audio). */
import { MediaDecodeError, type Engine } from "@app/engine-client";
import { codecLabel, extOf, type Probed } from "./plan";
import type { MediaKind } from "@app/engine-client";

export interface ProbeResult {
  probed: Probed;
  codec: string;
  /** Object URL of a small JPEG, or `undefined` (audio, or no frame could be drawn). The caller revokes it. */
  poster?: string;
  /** The same picture as a Blob, for the poster cache (no `fetch` of the object URL: the page's CSP only lets `fetch` reach itself). */
  posterBlob?: Blob;
}

const POSTER_W = 320;

async function jpegUrl(source: CanvasImageSource, w: number, h: number): Promise<{ url: string; blob: Blob } | undefined> {
  const scale = Math.min(1, POSTER_W / Math.max(1, w));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  ctx.drawImage(source, 0, 0, cw, ch);
  const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", 0.72));
  return blob ? { url: URL.createObjectURL(blob), blob } : undefined;
}

/** Stills never go through the decoder: the browser decodes them. */
async function probeImage(file: File): Promise<ProbeResult> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new MediaDecodeError("unsupported", `This browser cannot open ${extOf(file.name).toUpperCase() || "this"} images.`);
  }
  try {
    const pic = await jpegUrl(bitmap, bitmap.width, bitmap.height);
    return { probed: { kind: "image", durationTicks: null, width: bitmap.width, height: bitmap.height, hasAudio: false, hasVideo: true }, codec: extOf(file.name).toUpperCase(), poster: pic?.url, posterBlob: pic?.blob };
  } finally {
    bitmap.close();
  }
}

/** Opens the file with the engine (range reads, never the whole file), reads its tracks and draws a poster from the first frame. */
export async function probeFile(engine: Engine, file: File, kind: MediaKind): Promise<ProbeResult> {
  if (kind === "image") return probeImage(file);
  const handle = await engine.media.open(file);
  try {
    const { info } = handle;
    const v = info.video;
    const a = info.audio;
    // The kind comes from the tracks, not the name: an audio recording saved as .webm or .mp4 is audio, not a broken video.
    if (!v && !a) throw new MediaDecodeError("unsupported", "This file has no picture or sound OverCut can use.");
    const probed: Probed = {
      kind: v ? "video" : "audio",
      durationTicks: info.durationTicks,
      width: v?.width,
      height: v?.height,
      rotation: v?.rotation,
      fps: v?.fps,
      hasAudio: !!a,
      hasVideo: !!v,
    };
    let pic: { url: string; blob: Blob } | undefined;
    if (v) {
      try {
        const f = await handle.videoFrame(0);
        try {
          if (f.kind === "gpu") pic = await jpegUrl(f.frame, f.width, f.height);
          else pic = await jpegUrl(await createImageBitmap(new ImageData(new Uint8ClampedArray(f.rgba), f.width, f.height)), f.width, f.height);
        } finally {
          f.release();
        }
      } catch {
        /* a card without a poster is fine; the clip itself still decodes later */
      }
    }
    return { probed, codec: [v && codecLabel(v.codec), a && codecLabel(a.codec)].filter(Boolean).join(" + "), poster: pic?.url, posterBlob: pic?.blob };
  } finally {
    await handle.close();
  }
}
