export type MediaErrorKind = "unsupported" | "io" | "invalid" | "out_of_range" | "cancelled";

/** A media failure with a kind the UI can act on. `unsupported` messages name the codec; `cancelled` is a superseded request (ignore it). */
export class MediaDecodeError extends Error {
  constructor(readonly kind: MediaErrorKind, message: string) {
    super(message);
    this.name = "MediaDecodeError";
  }
}

const KINDS: readonly string[] = ["unsupported", "io", "invalid", "out_of_range", "cancelled"];

/** What the wasm side throws (`{kind, message}` JSON string), what the host rejects with, or any Error. */
export function toMediaError(thrown: unknown): MediaDecodeError {
  if (thrown instanceof MediaDecodeError) return thrown;
  const text = typeof thrown === "string" ? thrown : thrown instanceof Error ? thrown.message : String(thrown);
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.kind === "string" && typeof o.message === "string") return new MediaDecodeError(KINDS.includes(o.kind) ? (o.kind as MediaErrorKind) : "io", o.message);
    }
  } catch {
    /* not JSON */
  }
  return new MediaDecodeError("io", text);
}

/** Human name of a WebCodecs codec string, for messages ("H.265 (HEVC)", not "hvc1.1.6.L93.B0"). */
export function codecName(codec: string): string {
  const c = codec.toLowerCase();
  if (c.startsWith("avc1") || c.startsWith("avc3")) return "H.264";
  if (c.startsWith("hvc1") || c.startsWith("hev1")) return "H.265 (HEVC)";
  if (c.startsWith("vp09")) return "VP9";
  if (c.startsWith("vp8")) return "VP8";
  if (c.startsWith("av01")) return "AV1";
  if (c.startsWith("mp4a")) return "AAC";
  if (c === "opus") return "Opus";
  if (c === "mp3") return "MP3";
  if (c.startsWith("pcm-")) return "WAV";
  if (c === "vorbis") return "Vorbis";
  if (c === "flac") return "FLAC";
  return codec;
}

export function unsupported(kind: "video" | "audio", codec: string): MediaDecodeError {
  return new MediaDecodeError("unsupported", `This device cannot decode ${codecName(codec)} ${kind} (${codec}). Convert the file to H.264/AAC, or open it on a device that supports ${codecName(codec)}.`);
}
