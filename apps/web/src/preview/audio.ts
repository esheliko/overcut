/** Web Audio output for the player: an AudioContext whose output position is the master clock. */
import type { AudioOut, Clock } from "./player";

export const performanceClock: Clock = { now: () => performance.now() / 1000 };

/** Audible-time clock of a context: `getOutputTimestamp` extrapolated with the performance clock (smooth), else `currentTime - outputLatency`. */
function audibleClock(ctx: AudioContext): Clock {
  return {
    now() {
      const ts = ctx.getOutputTimestamp?.();
      if (ts && ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0 && ts.contextTime > 0) {
        return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
      }
      return ctx.currentTime - (ctx.outputLatency || 0);
    },
  };
}

/** `undefined` where the browser has no Web Audio (the player then plays silently against the performance clock). */
export function createWebAudio(sampleRate = 48_000): AudioOut | undefined {
  const Ctor = typeof AudioContext !== "undefined" ? AudioContext : undefined;
  if (!Ctor) return undefined;
  let ctx: AudioContext | undefined;
  const live = new Set<AudioBufferSourceNode>();
  const get = () => (ctx ??= new Ctor({ sampleRate, latencyHint: "interactive" }));
  let clock: Clock | undefined;
  return {
    sampleRate,
    get clock() { return (clock ??= audibleClock(get())); },
    schedule(left, right, when) {
      const c = get();
      let l = left;
      let r = right;
      let at = when;
      // Never start in the past: trim the part that is already over, so the rest stays aligned with the clock instead of shifting later.
      if (at < c.currentTime) {
        const skip = Math.min(l.length, Math.ceil((c.currentTime - at) * c.sampleRate));
        l = l.subarray(skip);
        r = r.subarray(skip);
        at += skip / c.sampleRate;
      }
      if (l.length === 0) return;
      const buf = c.createBuffer(2, l.length, c.sampleRate);
      buf.copyToChannel(l as Float32Array<ArrayBuffer>, 0);
      buf.copyToChannel(r as Float32Array<ArrayBuffer>, 1);
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(c.destination);
      src.onended = () => live.delete(src);
      live.add(src);
      src.start(at);
    },
    stop() {
      for (const s of live) { try { s.stop(); } catch { /* already ended */ } }
      live.clear();
    },
    async resume() {
      const c = get();
      if (c.state !== "running") await Promise.race([c.resume().catch(() => undefined), new Promise((r) => setTimeout(r, 400))]);
      return c.state === "running";
    },
  };
}
