/** A `MediaHost` backed by the engine's decoders (`Engine.media`, M1-016). The caller supplies how to open a project media file
 *  (a `File`/`Blob` resolved from `MediaRef.uri`: file handle, import registry); handles are opened once per media and reused. */
import type { MediaHandle, MediaRef } from "@app/engine-client";
import type { AudioFormat, MediaHost } from "./host";

const TICKS_PER_SECOND = 705_600_000;

export function engineMediaHost(open: (media: MediaRef) => Promise<MediaHandle>): MediaHost {
  const handles = new Map<string, Promise<MediaHandle>>();
  const handle = (m: MediaRef) => {
    let h = handles.get(m.id);
    if (!h) { h = open(m); handles.set(m.id, h); h.catch(() => handles.delete(m.id)); }
    return h;
  };
  return {
    async audioFormat(m): Promise<AudioFormat | null> {
      const a = (await handle(m)).info.audio;
      if (!a) return null;
      const h = await handle(m);
      return { sampleRate: h.audioRate, channels: Math.max(1, a.channels), frames: Math.round((a.durationTicks / TICKS_PER_SECOND) * h.audioRate) };
    },
    async readAudio(m, startFrame, frames) {
      const h = await handle(m);
      const f32 = await h.audio(startFrame, frames);
      const out = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i]! * 32767)));
      return out;
    },
    async thumbnail(m, seconds, width, height) {
      const h = await handle(m);
      const v = h.info.video;
      if (!v) throw new Error("no video track");
      const frame = await h.videoFrame(Math.max(0, Math.min(h.frameIndexAt(Math.round(seconds * TICKS_PER_SECOND)), Math.max(0, v.packets - 1))));
      try {
        // Scale to cover width x height (the cache keeps the small size); rotation metadata is not applied yet (follow-up).
        const scale = Math.max(width / frame.width, height / frame.height);
        const opts: ImageBitmapOptions = { resizeWidth: Math.round(frame.width * scale), resizeHeight: Math.round(frame.height * scale), resizeQuality: "medium" };
        const src: ImageBitmapSource = frame.kind === "gpu" ? frame.frame : new ImageData(Uint8ClampedArray.from(frame.rgba), frame.width, frame.height);
        return await createImageBitmap(src, opts);
      } finally { frame.release(); }
    },
  };
}
