import { MediaDecodeError } from "./errors";
import type { DecodedFrame, FrameStream, MediaFileInfo, MediaHandle, OpenMediaOptions } from "../types";

/**
 * A picture (JPG, PNG, WebP, GIF, BMP, AVIF, HEIC) as a one-frame "video", so the preview, the thumbnails and the export treat it like any
 * other clip: every source time maps to frame 0. The browser decodes it (`createImageBitmap`, which also applies the EXIF orientation), so
 * this runs wherever the engine does (a Worker, or the desktop webview). How long it lasts on the timeline is the project's business.
 */

const ascii = (h: Uint8Array, at: number, s: string): boolean => s.split("").every((c, i) => h[at + i] === c.charCodeAt(0));

/** True when the first bytes of a file are a picture format (by content: names and MIME types lie, phones send none). */
export function isImageHead(h: Uint8Array): boolean {
  if (h.length < 12) return false;
  if (h[0] === 0x89 && ascii(h, 1, "PNG")) return true;
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return true; // JPEG
  if (ascii(h, 0, "GIF8") || ascii(h, 0, "BM")) return true;
  if (ascii(h, 0, "RIFF") && ascii(h, 8, "WEBP")) return true;
  if (ascii(h, 4, "ftyp")) return ["avif", "avis", "heic", "heix", "hevc", "mif1", "msf1"].some((b) => ascii(h, 8, b)); // a still brand, not a movie brand
  return false;
}

/** Reads the head of a file through `read` (a `Blob.slice` or a native range read) and says whether it is a picture. */
export async function sniffImage(head: Promise<ArrayBuffer>): Promise<boolean> {
  try {
    return isImageHead(new Uint8Array(await head));
  } catch {
    return false;
  }
}

/** `null` when the blob is not a picture (the caller goes on to the video demuxer). Rejects `unsupported` for a picture this device cannot decode. */
export async function openStill(file: Blob, opts: OpenMediaOptions = {}): Promise<MediaHandle | null> {
  if (!(await sniffImage(file.slice(0, 16).arrayBuffer()))) return null;
  return decodeStill(file, opts);
}

/** Decodes a blob already known to be a picture. */
export async function decodeStill(file: Blob, opts: OpenMediaOptions = {}): Promise<MediaHandle> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new MediaDecodeError("unsupported", "This device cannot open this kind of picture.");
  }
  return new StillHandle(bitmap, opts.audioRate ?? 48_000, (opts.gpu ?? true) && typeof VideoFrame !== "undefined");
}

class StillHandle implements MediaHandle {
  readonly info: MediaFileInfo;
  readonly frameKind: "gpu" | "cpu";
  private closed = false;
  private rgba: Uint8Array | undefined;
  private readonly counts = { received: 0, closed: 0 };

  constructor(private readonly bitmap: ImageBitmap, readonly audioRate: number, gpu: boolean) {
    this.frameKind = gpu ? "gpu" : "cpu";
    this.info = {
      container: "image",
      durationTicks: 0,
      video: { codec: "image", width: bitmap.width, height: bitmap.height, rotation: 0, sampleRate: 0, channels: 0, durationTicks: 0, packets: 1, fps: { num: 30, den: 1 }, vfr: false },
    };
  }

  frameIndexAt(): number {
    return 0;
  }

  /** The one frame's timestamp: the desktop preview bridge sends it so the Worker's `frameIndexAt` stays synchronous. */
  presentationTicks(): readonly number[] {
    return [0];
  }

  async videoFrame(index: number): Promise<DecodedFrame> {
    if (this.closed) throw new MediaDecodeError("invalid", "media is closed");
    if (!Number.isInteger(index) || index < 0) throw new MediaDecodeError("out_of_range", `frame ${index} is outside the clip`);
    const base = { index: 0, ptsTicks: 0, width: this.bitmap.width, height: this.bitmap.height };
    this.counts.received++;
    let released = false;
    const release = (after?: () => void): void => {
      if (released) return;
      released = true;
      this.counts.closed++;
      after?.();
    };
    if (this.frameKind === "gpu") {
      const frame = new VideoFrame(this.bitmap, { timestamp: 0 });
      return { ...base, kind: "gpu", frame, release: () => release(() => frame.close()) };
    }
    // A copy each time: the desktop bridge transfers the buffer to the preview Worker, which detaches it.
    this.rgba ??= this.read();
    return { ...base, kind: "cpu", rgba: this.rgba.slice(), release: () => release() };
  }

  private read(): Uint8Array {
    const canvas = new OffscreenCanvas(this.bitmap.width, this.bitmap.height);
    const g = canvas.getContext("2d", { willReadFrequently: true });
    if (!g) throw new MediaDecodeError("io", "no canvas to read the picture with");
    g.drawImage(this.bitmap, 0, 0);
    return new Uint8Array(g.getImageData(0, 0, canvas.width, canvas.height).data.buffer);
  }

  stream(): FrameStream {
    let sent = false;
    return {
      next: async () => (sent ? null : ((sent = true), this.videoFrame(0))),
      buffered: () => 0,
      close: () => undefined,
    };
  }

  async audio(_start: number, count: number): Promise<Float32Array> {
    return new Float32Array(Math.max(0, count) * 2);
  }

  stats(): { received: number; closed: number; open: number } {
    return { ...this.counts, open: this.counts.received - this.counts.closed };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.bitmap.close();
  }
}
