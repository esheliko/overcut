import type { DecodedFrame, MediaApi, MediaHandle } from "../types";
import { MediaDecodeError } from "../types";
import { TICKS_PER_SECOND } from "./plan";
import type { DrawableFrame, OpenedMedia } from "./media";

const rotationOf = (deg: number): 0 | 90 | 180 | 270 => (deg === 90 || deg === 180 || deg === 270 ? deg : 0);

/**
 * Adapts the production decoder (`Engine.media`, M1-016: demux + WebCodecs in the Worker) to what the export loop needs.
 * - Video: sequence `source_time` (ticks) -> the media's own frame index (`floor(ticks * fps)`, ADR 0010: repeats or skips come from this rule), clamped to the last frame.
 *   Asking again for the frame already held reuses it (slow motion and low-fps media decode each picture once); every other frame is released as soon as the next one arrives.
 *   Variable frame rate media is refused for now (needs the pts table; follow-up) rather than exported with wrong timing.
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
    if (v.vfr || !v.fps || v.fps.num <= 0 || v.fps.den <= 0) {
      close();
      throw new MediaDecodeError("unsupported", `"${name}" has a variable frame rate, which export does not support yet.`);
    }
    const { num, den } = v.fps;
    const last = Math.max(0, v.packets - 1);
    let held: { index: number; frame: DecodedFrame; drawable: DrawableFrame } | undefined;
    let scratch: OffscreenCanvas | undefined;
    const release = (): void => {
      held?.frame.release();
      held = undefined;
    };
    out.video = {
      async frame(ticks) {
        const index = Math.min(last, Number((BigInt(Math.max(0, ticks)) * BigInt(num)) / (TICKS_PER_SECOND * BigInt(den))));
        if (held?.index === index) return held.drawable;
        release();
        const frame = await handle.videoFrame(index);
        let source: CanvasImageSource;
        if (frame.kind === "gpu") source = frame.frame;
        else {
          scratch ??= new OffscreenCanvas(frame.width, frame.height);
          scratch.width = frame.width;
          scratch.height = frame.height;
          scratch.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(frame.rgba.buffer as ArrayBuffer, frame.rgba.byteOffset, frame.rgba.byteLength), frame.width, frame.height), 0, 0);
          source = scratch;
        }
        // `close` is a no-op: the frame stays alive until the next index is requested (or the media closes), so a repeated frame is drawn without a second decode.
        const drawable: DrawableFrame = { source, width: frame.width, height: frame.height, rotation: rotationOf(v.rotation), close: () => undefined };
        held = { index, frame, drawable };
        return drawable;
      },
      close: () => {
        release();
        if (!a) close();
      },
    };
  }
  if (a) {
    const channels = Math.max(1, a.channels);
    out.audio = {
      async read(start, count, planar) {
        const pcm = await handle.audio(start, count);
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
