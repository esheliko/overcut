/** A `MediaHost` backed by the engine's decoders (`Engine.media`, M1-016). The caller supplies how to open a project media file
 *  (a `File`/`Blob` resolved from `MediaRef.uri`: file handle, import registry); handles are opened once per media and reused. */
import type { Engine, MediaHandle, MediaRef } from "@app/engine-client";
import type { AudioFormat, MediaHost } from "./host";

const TICKS_PER_SECOND = 705_600_000;

/** Size of the thumbnail bitmap for a coded frame shown rotated `rotation` degrees clockwise (multiples of 90), scaled to cover `width` x `height`.
 *  `coded` is what the decoder frame is resampled to first; `out` is the upright result. Pure, so it is unit tested. */
export function thumbPlan(frameW: number, frameH: number, rotation: number, width: number, height: number) {
  const rot = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
  const swap = rot === 90 || rot === 270;
  const dw = swap ? frameH : frameW, dh = swap ? frameW : frameH;
  const scale = Math.max(width / dw, height / dh);
  const coded = { w: Math.max(1, Math.round(frameW * scale)), h: Math.max(1, Math.round(frameH * scale)) };
  const out = swap ? { w: coded.h, h: coded.w } : coded;
  return { rot, coded, out };
}

export function engineMediaHost(open: (media: MediaRef) => Promise<MediaHandle>): MediaHost {
  const handles = new Map<string, Promise<MediaHandle>>();
  const handle = (m: MediaRef) => {
    let h = handles.get(m.id);
    if (!h) { h = open(m); handles.set(m.id, h); h.catch(() => handles.delete(m.id)); }
    return h;
  };
  return {
    /** Closes the decoder handle for a media id (file left the project, or was relinked to another file). A later request opens it afresh. */
    async release(id: string) {
      const h = handles.get(id);
      handles.delete(id);
      if (h) await h.then((x) => x.close(), () => undefined).catch(() => undefined);
    },
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
        // Scale to cover width x height (the cache keeps the small size), then turn it upright by the file's display rotation.
        const plan = thumbPlan(frame.width, frame.height, v.rotation ?? 0, width, height);
        const opts: ImageBitmapOptions = { resizeWidth: plan.coded.w, resizeHeight: plan.coded.h, resizeQuality: "medium" };
        const src: ImageBitmapSource = frame.kind === "gpu" ? frame.frame : new ImageData(Uint8ClampedArray.from(frame.rgba), frame.width, frame.height);
        const bmp = await createImageBitmap(src, opts);
        if (plan.rot === 0) return bmp;
        try {
          const c = new OffscreenCanvas(plan.out.w, plan.out.h);
          const g = c.getContext("2d")!;
          g.translate(plan.out.w / 2, plan.out.h / 2);
          g.rotate((plan.rot * Math.PI) / 180);
          g.drawImage(bmp, -plan.coded.w / 2, -plan.coded.h / 2);
          return c.transferToImageBitmap();
        } finally { bmp.close(); }
      } finally { frame.release(); }
    },
  };
}

/** The host for imported media: each file comes from `fileOf` (the bin's live or relinked file) and is opened once through the engine.
 *  A media file that is offline (no file) rejects, which the media layer draws as a placeholder. */
export function importedMediaHost(engine: Pick<Engine, "media">, fileOf: (id: string) => Promise<File | null>): MediaHost {
  return engineMediaHost(async (m) => {
    const file = await fileOf(m.id);
    if (!file) throw new Error("media is offline");
    return engine.media.open(file);
  });
}
