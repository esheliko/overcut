import type { LayerSource } from "../render";
import type { DecodedFrame, FrameStream, MediaApi, MediaHandle } from "../types";
import { MediaDecodeError } from "../types";
import { ExportError } from "./types";
import { TICKS_PER_SECOND } from "./plan";
import type { DrawableFrame, OpenedMedia } from "./media";

/** Decoded frames the export keeps ahead of the one being composited. */
const STREAM_AHEAD = 6;

/** A failure while reading or decoding one clip, with the clip and the position in it, so a device report says exactly what was being read (not "can't be read"). */
function clipFailure(clip: string, at: string, e: unknown): ExportError {
  if (e instanceof ExportError) return e;
  const kind = e instanceof MediaDecodeError ? `${e.name}(${e.kind})` : e instanceof Error ? e.name : "Error";
  const message = e instanceof Error ? e.message : String(e);
  // A file the browser can no longer open (permission revoked, file moved or deleted) is the one case where "reconnect it" is true.
  const gone = e instanceof DOMException && ["NotFoundError", "NotReadableError", "SecurityError"].includes(e.name);
  return new ExportError(gone ? "media_unavailable" : "media_failed", `"${clip}" failed at ${at}: ${message}`, { name: kind, message, clip, at, stack: e instanceof Error ? e.stack?.slice(0, 1500) : undefined });
}

const rotationOf = (deg: number): 0 | 90 | 180 | 270 => (deg === 90 || deg === 180 || deg === 270 ? deg : 0);

/**
 * Adapts the production decoder (`Engine.media`, M1-016: demux + WebCodecs in the Worker) to what the export loop needs.
 * - Video: sequence `source_time` (ticks) -> the media's own frame index (`floor(ticks * fps)`, ADR 0010: repeats or skips come from this rule), clamped to the last frame.
 *   Asking again for the frame already held reuses it (slow motion and low-fps media decode each picture once); every other frame is released as soon as the next one arrives.
 *   Variable frame rate media looks the frame up in the clip's own timestamp table (`handle.frameIndexAt`, the rule the preview uses), so it exports at its real speed.
 * - Audio: the decoder gives interleaved f32 at the sequence rate; mono is copied to both channels, more than two channels keep front left and right.
 * - Display rotation from the container is applied by the compositor (`DrawableFrame.rotation`).
 */
export async function openBlobMedia(media: MediaApi, blob: Blob, sampleRate: number, name: string): Promise<OpenedMedia> {
  const handle: MediaHandle = await media.open(blob, { audioRate: sampleRate });
  const v = handle.info.video;
  const a = handle.info.audio;
  const close = (): void => void handle.close();
  const out: OpenedMedia = {};
  if (v) {
    const constant = !v.vfr && !!v.fps && v.fps.num > 0 && v.fps.den > 0;
    if (!constant && v.packets > 0 && typeof handle.frameIndexAt !== "function") {
      close();
      throw new MediaDecodeError("unsupported", `"${name}" has a variable frame rate, which this device cannot export.`);
    }
    const { num, den } = constant ? v.fps! : { num: 1, den: 1 };
    const last = Math.max(0, v.packets - 1);
    let held: { index: number; frame: DecodedFrame; drawable: DrawableFrame } | undefined;
    const release = (): void => {
      held?.frame.release();
      held = undefined;
    };
    // Export asks for frame after frame in order. A `videoFrame(i)` call restarts at the keyframe every time (about half a GOP of decoding per output frame
    // on long-GOP phone footage); one sequential stream decodes each picture once and keeps a few ahead, so decoding overlaps rendering and encoding.
    let stream: FrameStream | undefined;
    let streamNext = -1; // media index the stream will return next
    const closeStream = (): void => {
      stream?.close();
      stream = undefined;
      streamNext = -1;
    };
    let streamBroken = typeof handle.stream !== "function";
    /** The frame at `index` from the sequential stream: restarts it when `index` is behind it or more than a second ahead; null when the stream cannot serve it. */
    const fromStream = async (index: number): Promise<DecodedFrame | null> => {
      if (streamBroken) return null;
      try {
        const jump = Math.max(30, Math.round(constant ? num / den : 30));
        if (!stream || index < streamNext || index > streamNext + jump) {
          closeStream();
          stream = handle.stream(index, STREAM_AHEAD);
          streamNext = index;
        }
        for (;;) {
          const f = await stream.next();
          if (!f) return null;
          streamNext = f.index + 1;
          if (f.index >= index) return f; // a frame past `index` (a gap in the stream) is the nearest one the media has
          f.release();
        }
      } catch {
        streamBroken = true; // this decoder cannot stream: the random-access path below takes over for good
        closeStream();
        return null;
      }
    };
    out.video = {
      async frame(ticks) {
        const at = Math.max(0, ticks);
        const index = Math.min(last, constant ? Number((BigInt(at) * BigInt(num)) / (TICKS_PER_SECOND * BigInt(den))) : handle.frameIndexAt(at));
        if (held?.index === index) return held.drawable;
        // Decoding the next frame is asked for before the held one is released, so the decoder never waits on us for a free slot.
        const streamed = held && index < held.index ? null : await fromStream(index);
        release();
        let frame: DecodedFrame;
        try {
          frame = streamed ?? (await handle.videoFrame(index));
        } catch (e) {
          throw clipFailure(name, `video frame ${index} of ${v.packets} (source ${(at / Number(TICKS_PER_SECOND)).toFixed(3)} s)`, e);
        }
        const source: LayerSource = frame.kind === "gpu" ? frame.frame : { rgba: frame.rgba };
        // `close` is a no-op: the frame stays alive until the next index is requested (or the media closes), so a repeated frame is drawn without a second decode.
        const drawable: DrawableFrame = { source, width: frame.width, height: frame.height, rotation: rotationOf(v.rotation), close: () => undefined };
        held = { index, frame, drawable };
        return drawable;
      },
      close: () => {
        release();
        closeStream();
        if (!a) close();
      },
    };
  }
  if (a) {
    const channels = Math.max(1, a.channels);
    out.audio = {
      async read(start, count, planar) {
        let pcm: Float32Array;
        try {
          pcm = await handle.audio(start, count);
        } catch (e) {
          throw clipFailure(name, `audio samples ${start}..${start + count} (${sampleRate} Hz, clip is ${(Number(handle.info.durationTicks) / Number(TICKS_PER_SECOND)).toFixed(3)} s)`, e);
        }
        const l = planar[0];
        const r = planar[1];
        for (let i = 0; i < count; i++) {
          const left = pcm[i * channels] ?? 0;
          if (l) l[i] = left;
          if (r) r[i] = channels > 1 ? (pcm[i * channels + 1] ?? 0) : left;
        }
      },
      close,
    };
  }
  return out;
}
