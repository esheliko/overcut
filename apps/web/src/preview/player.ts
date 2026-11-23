/**
 * The preview player (M1-033). Audio is the master clock: timeline position = anchor + (audio clock - anchor time) * rate, so video
 * can only be late or skipped, never drift. Each frame the player asks the engine what is visible (`evaluate`), takes the decoded
 * frame of every layer from its sequential decode feed (one decoder run per clip, prefetching within a byte budget), and hands
 * the layers to the compositor. A frame that cannot be ready in time is skipped, never waited for.
 * Everything platform-specific (clock, audio output, renderer, media) is injected, so the logic runs under fake clocks in unit tests.
 */
import { containScale, layerOf, type AudioSegment, type DecodedFrame, type FrameDescription, type FrameStream, type LayerSource, type MediaHandle } from "@app/engine-client";
import { limit, mixSegment, sampleAtTicks, sourceSamplesFor } from "./audioMix";
import type { RenderLayer, Renderer } from "./renderer";
import { FrameCache, type Thumb } from "./scrubCache";
import { frameAtTicks, frameStartTicks, positionAt, prefetchFrames, shuttle, TICKS_PER_SECOND, type Anchor, type Rate } from "./timing";

export interface Clock { now(): number }

export interface AudioOut {
  readonly sampleRate: number;
  /** The clock audio is played against (seconds). */
  readonly clock: Clock;
  /** Play stereo samples starting at clock time `when`. Returns false if the output is not running. */
  schedule(left: Float32Array, right: Float32Array, when: number): void;
  /** Stop everything scheduled and not yet heard. */
  stop(): void;
  /** Start the output (a user gesture is on the stack). Resolves true when running. */
  resume(): Promise<boolean>;
}

export interface PlayerDeps {
  rate: Rate;
  sequence: string;
  size: { width: number; height: number };
  /** Timeline length in ticks. */
  endTicks: number;
  evaluate(ticks: number, audioSamples: number): Promise<FrameDescription>;
  media(id: string): MediaHandle | undefined;
  renderer: Renderer;
  /** Audio output; without it the player runs against `fallbackClock` and is silent. */
  audio?: AudioOut;
  fallbackClock: Clock;
  /** Called whenever the playhead frame changes (each presented frame while playing). */
  onFrame(frame: number): void;
  onState?(playing: boolean, rate: number): void;
  /** Called with a plain message when something cannot be shown (decoder fault). */
  onError?(message: string): void;
  /** Schedule the next presentation tick (requestAnimationFrame). Returns a cancel function. */
  raf(cb: () => void): () => void;
  /** Bytes of decoded frames each clip may hold ahead of the playhead (also the budget of the paused-playhead frame cache). */
  prefetchBytes?: number;
  /** How a decoded frame becomes compositor pixels (the device's chosen upload path, `uploadPath.ts`). `slot` = layer number, for reusable buffers. Default: the frame itself / its RGBA bytes. */
  upload?(frame: DecodedFrame, slot: number): LayerSource | Promise<LayerSource>;
  /** The timeline's filmstrip thumbnail nearest to `seconds` of media `media` (upright), used as a stand-in when nothing decoded is near. */
  standIn?(media: string, seconds: number): Thumb<ImageBitmap> | undefined;
  /**
   * The scrub strip's small picture of source frame `index` of `media` (coded orientation; the player applies the clip's display rotation), when one is built.
   * Shown at once while the exact frame decodes, then replaced. The player closes the bitmap.
   */
  strip?(media: string, index: number): Promise<{ bitmap: ImageBitmap; width: number; height: number; index: number } | undefined>;
  /** An exact (uncached) seek of `media` took `ms`: the measured seek times the strip rule uses. */
  onSeek?(media: string, ms: number): void;
}

export interface PlayerStats {
  /** Frames drawn. */
  presented: number;
  /** Sequence frames skipped because the clock moved on before they could be drawn. */
  dropped: number;
  /** Draws where a layer's decoded frame was not ready and the previous one was held. */
  stalls: number;
  /** Worst lateness of a presented frame (ms) against its due time. */
  maxLateMs: number;
  /** Lateness of each presented frame (ms), for percentiles. */
  late: number[];
  /** Latency of each scrub / step (ms): request to pixels. */
  scrubMs: number[];
  /** Presented frame timestamps (clock seconds), for fps. */
  times: number[];
  /** Audio chunks that had to be trimmed because the clock had moved on. */
  audioTrimmed: number;
  /** `[frame, audio-clock position in ticks]` when each presented frame's draw completed (A/V alignment checks). */
  marks: [number, number][];
  /** Scrub / step: ms from the request to the first visible update (a stand-in, or the exact frame when it was cached). Target < 16. `scrubMs` is the time to the exact frame. */
  firstUpdateMs: number[];
  /** Scrub draws that showed a stand-in first (nearest cached frame or thumbnail), and how many of those were thumbnails. */
  standIns: number;
  thumbStandIns: number;
  /** How far (frames) each first-picture stand-in was from the frame asked for: 0 = exact. Shows what the strip buys over thumbnails (test and measurement). */
  standInOff: number[];
  /** Scrub draws whose first picture was a scrub-strip frame (exact to within half the strip's stride). */
  stripStandIns: number;
  /** Scrub draws whose exact frame was already in the cache (frame step, small scrub, after decode-ahead). */
  cacheHits: number;
}

const CHUNK_SECONDS = 0.2;
const AHEAD_SECONDS = 0.8;
/** Time between starting the clock and the first audio sample, so the first chunk is ready. */
const START_LEAD = 0.06;

interface Feed {
  clip: string;
  media: MediaHandle;
  stream: FrameStream | undefined;
  queue: DecodedFrame[];
  current: DecodedFrame | undefined;
  filling: boolean;
  closed: boolean;
  max: number;
  failed: boolean;
}

export class Player {
  readonly stats: PlayerStats = { presented: 0, dropped: 0, stalls: 0, maxLateMs: 0, late: [], scrubMs: [], times: [], audioTrimmed: 0, marks: [], firstUpdateMs: [], standIns: 0, thumbStandIns: 0, stripStandIns: 0, standInOff: [], cacheHits: 0 };
  private cache: FrameCache<DecodedFrame>;
  private warmToken = 0;
  private warmStreams = new Set<FrameStream>();
  private frameNo = 0;
  private playing = false;
  private rate = 0;
  private anchor: Anchor = { ticks: 0, at: 0, rate: 0 };
  /** False between `play()` starting and its clock anchor being set: `position()` is the frame the run starts from until then. */
  private anchored = false;
  private clock: Clock;
  private cancelRaf: (() => void) | undefined;
  private feeds = new Map<string, Feed>();
  private presentedFrame = -1;
  private busy = false;
  private audioToken = 0;
  private audioPos = 0; // ticks of the next audio sample to schedule
  private audioWhen = 0;
  private scrubTarget: { frame: number; t0: number } | undefined;
  private scrubbing = false;
  private disposed = false;
  private lastActive = 0;

  constructor(private d: PlayerDeps) {
    this.clock = d.fallbackClock;
    this.cache = new FrameCache<DecodedFrame>(d.prefetchBytes ?? 192 * 1024 * 1024, 12, (f) => (f.kind === "cpu" ? f.rgba.byteLength : f.width * f.height * 4));
  }

  /** A media item left the project: its cached frames go. */
  dropMedia(id: string): void { this.cache.dropMedia(id); }

  /** Cached paused-playhead frames (test and measurement). */
  get cached(): number { return this.cache.size; }

  get frame(): number { return this.frameNo; }
  get isPlaying(): boolean { return this.playing; }

  /** True when nobody is playing or scrubbing and nothing happened for 400 ms: background work (the scrub strip) may run. */
  isIdle(): boolean { return !this.playing && !this.scrubbing && !this.scrubTarget && performance.now() - this.lastActive > 400; }
  get speed(): number { return this.rate; }
  get endFrame(): number { return Math.ceil((this.d.endTicks * this.d.rate.num) / (TICKS_PER_SECOND * this.d.rate.den)); }

  /**
   * The project changed under the player (edit, undo, import, a media file became readable): take the new rate, size, length or sequence,
   * drop every decode feed (clips may have moved or been trimmed) and redraw the frame the playhead is on, clamped to the new end.
   * Playback that was running carries on from the same frame (re-anchored on the new timeline). No restart, no new player.
   */
  reconfigure(patch: Partial<Pick<PlayerDeps, "rate" | "size" | "endTicks" | "sequence">>): void {
    if (this.disposed) return;
    const resume = this.playing ? this.rate : 0;
    if (this.playing) this.pause();
    const at = this.frameNo;
    this.d = { ...this.d, ...patch };
    this.closeFeeds();
    this.seek(at);
    if (resume !== 0 && this.frameNo < this.endFrame) void this.play(resume);
  }

  /** Jump to `frame` and draw it (paused). Latest call wins: scrubbing never queues stale work. */
  seek(frame: number, t0 = performance.now()): void {
    const f = Math.min(this.endFrame, Math.max(0, Math.floor(frame)));
    this.lastActive = performance.now();
    if (this.playing) this.pause();
    this.frameNo = f;
    this.cancelWarm();
    this.scrubTarget = { frame: f, t0 };
    if (!this.scrubbing) void this.scrubLoop();
  }

  step(delta: number): void { this.seek(this.frameNo + delta); }

  /** Normal-speed play (or pause when playing). */
  toggle(): void {
    if (this.playing) this.pause();
    else void this.play(1);
  }

  /** J/K/L. */
  key(k: "J" | "K" | "L"): void {
    if (k === "K") { this.pause(); return; }
    const next = shuttle(this.playing ? this.rate : 0, k);
    void this.play(next);
  }

  async play(rate = 1): Promise<void> {
    if (this.disposed) return;
    this.lastActive = performance.now();
    if (this.frameNo >= this.endFrame && rate > 0) this.frameNo = 0;
    if (this.frameNo <= 0 && rate < 0) this.frameNo = this.endFrame;
    const wasPlaying = this.playing;
    this.cancelWarm();
    const gen = ++this.audioToken;
    this.rate = rate;
    this.playing = true;
    this.d.onState?.(true, rate);
    // Pick the clock for this run: the audio clock when the output starts, else the fallback.
    if (!wasPlaying) {
      this.clock = this.d.fallbackClock;
      if (this.d.audio && (await this.d.audio.resume())) this.clock = this.d.audio.clock;
      if (gen !== this.audioToken || !this.playing) return;
    }
    // Bring the first frame up (and the feeds' first frames) before the clock starts, so playback begins without a stall.
    if (!wasPlaying || rate < 0) await this.draw(this.frameNo, true);
    if (gen !== this.audioToken || !this.playing) return;
    const startTicks = Math.min(this.d.endTicks, frameStartTicks(this.frameNo, this.d.rate));
    const lead = rate === 1 && this.d.audio ? START_LEAD : 0;
    const ticks = wasPlaying ? this.position() : startTicks;
    this.anchor = { ticks, at: this.clock.now() + lead, rate };
    this.anchored = true;
    this.presentedFrame = frameAtTicks(ticks, this.d.rate);
    this.d.audio?.stop();
    if (rate === 1 && this.d.audio) {
      this.audioPos = ticks;
      this.audioWhen = this.anchor.at;
      void this.audioLoop(gen);
    }
    this.cancelRaf?.();
    this.cancelRaf = this.d.raf(this.tick);
  }

  pause(): void {
    this.lastActive = performance.now();
    if (!this.playing) return;
    const end = this.position();
    this.playing = false;
    this.rate = 0;
    this.anchored = false;
    this.audioToken++;
    this.d.audio?.stop();
    this.cancelRaf?.();
    this.cancelRaf = undefined;
    this.frameNo = Math.min(this.endFrame, frameAtTicks(end, this.d.rate));
    this.closeFeeds();
    this.d.onState?.(false, 0);
    this.d.onFrame(this.frameNo);
    // Show exactly the frame the playhead stopped on.
    this.scrubTarget = { frame: this.frameNo, t0: performance.now() };
    if (!this.scrubbing) void this.scrubLoop();
  }

  /** Timeline position now, in ticks. */
  position(): number {
    return this.playing && this.anchored ? positionAt(this.anchor, this.clock.now(), this.d.endTicks) : frameStartTicks(this.frameNo, this.d.rate);
  }

  dispose(): void {
    this.disposed = true;
    this.pause();
    this.cancelWarm();
    this.closeFeeds();
    this.cache.clear();
    this.d.renderer.dispose();
  }

  // --- presentation -----------------------------------------------------------------------------------------------

  private tick = (): void => {
    if (!this.playing || this.disposed) return;
    const pos = this.position();
    const end = this.anchor.rate > 0 ? pos >= this.d.endTicks : pos <= 0;
    const want = Math.min(this.endFrame, frameAtTicks(pos, this.d.rate));
    if (want !== this.presentedFrame && !this.busy) void this.advance(want, pos);
    if (end && !this.busy) {
      this.frameNo = want;
      this.pause();
      return;
    }
    this.cancelRaf = this.d.raf(this.tick);
  };

  private async advance(want: number, pos: number): Promise<void> {
    this.busy = true;
    const gen = this.audioToken;
    try {
      const skipped = Math.abs(want - this.presentedFrame) - 1;
      if (skipped > 0) this.stats.dropped += skipped;
      this.presentedFrame = want;
      const due = frameStartTicks(want, this.d.rate);
      await this.draw(Math.min(want, Math.max(0, this.endFrame - 1)), false);
      if (gen !== this.audioToken) return;
      // Lateness: how far the audio clock is past this frame's due time when its pixels are on screen.
      const nowTicks = positionAt(this.anchor, this.clock.now(), Number.MAX_SAFE_INTEGER);
      const lateMs = Math.max(0, ((this.anchor.rate >= 0 ? nowTicks - due : due - nowTicks) / TICKS_PER_SECOND) * 1000);
      this.stats.presented++;
      this.stats.late.push(lateMs);
      this.stats.marks.push([want, nowTicks]);
      this.stats.maxLateMs = Math.max(this.stats.maxLateMs, lateMs);
      this.stats.times.push(this.d.fallbackClock.now());
      this.frameNo = want;
      this.d.onFrame(want);
      if (want % 12 === 0) void this.warm(want);
    } catch (e) {
      this.fail(e);
    } finally {
      this.busy = false;
      void pos;
    }
  }

  /** Start decoding the clips that come into view in the next half second (a cut should not stall for a keyframe's worth of decode). */
  private async warm(from: number): Promise<void> {
    if (this.rate <= 0) return;
    const ahead = Math.ceil((this.d.rate.num / this.d.rate.den) * 0.5);
    const desc = await this.d.evaluate(frameStartTicks(Math.min(this.endFrame - 1, from + ahead), this.d.rate), 0).catch(() => undefined);
    if (!desc || !this.playing) return;
    for (const l of desc.layers) {
      const media = this.d.media(l.media);
      if (media?.info.video && !this.feeds.has(l.clip)) this.feed(l.clip, media, media.frameIndexAt(l.source_time));
    }
  }

  /** Evaluate frame `f` and draw it. `first` brings every feed up at this frame (start of playback); otherwise feeds are only read. */
  private async draw(f: number, first: boolean): Promise<void> {
    const ticks = frameStartTicks(f, this.d.rate);
    const desc = await this.d.evaluate(ticks, 0);
    const layers: RenderLayer[] = [];
    const held: DecodedFrame[] = [];
    const reverse = this.rate < 0;
    try {
      for (const l of desc.layers) {
        const media = this.d.media(l.media);
        if (!media?.info.video) continue;
        const idx = media.frameIndexAt(l.source_time);
        let frame: DecodedFrame | undefined;
        if (reverse) {
          frame = await media.videoFrame(idx).catch(() => undefined);
          if (frame) held.push(frame);
        } else {
          const feed = this.feed(l.clip, media, idx);
          if (first) await this.prime(feed, idx);
          frame = this.take(feed, idx);
        }
        if (!frame) continue;
        layers.push(await this.layer(l, frame, media, layers.length));
      }
      this.d.renderer.render(layers, this.d.size);
    } finally {
      for (const h of held) h.release();
    }
  }

  private async layer(l: FrameDescription["layers"][number], frame: DecodedFrame, media: MediaHandle, slot: number): Promise<RenderLayer> {
    const source = this.d.upload ? await this.d.upload(frame, slot) : frame.kind === "gpu" ? frame.frame : { rgba: frame.rgba };
    return layerOf(l, { source, width: frame.width, height: frame.height, rotation: media.info.video?.rotation ?? 0 }, this.d.size);
  }

  /** A filmstrip thumbnail as a layer: it is upright already (rotation 0) and small, so the layer's scale grows by display size / thumbnail size. */
  private thumbLayer(l: FrameDescription["layers"][number], t: Thumb<ImageBitmap>, media: MediaHandle): RenderLayer {
    const v = media.info.video!;
    const turned = v.rotation === 90 || v.rotation === 270;
    const dw = turned ? v.height : v.width;
    const dh = turned ? v.width : v.height;
    const k = containScale({ width: dw, height: dh }, this.d.size);
    const sx = l.transform.scale[0] * k * (dw / t.width);
    const sy = l.transform.scale[1] * k * (dh / t.height);
    return layerOf({ ...l, transform: { ...l.transform, scale: [sx, sy] } }, { source: t.bitmap, width: t.width, height: t.height, rotation: 0 });
  }

  // --- paused: scrub and step -------------------------------------------------------------------------------------

  private async scrubLoop(): Promise<void> {
    this.scrubbing = true;
    try {
      while (this.scrubTarget && !this.disposed) {
        const { frame, t0 } = this.scrubTarget;
        this.scrubTarget = undefined;
        this.d.onFrame(frame);
        try {
          await this.drawOne(frame, t0);
        } catch (e) {
          if ((e as { kind?: string }).kind !== "cancelled") this.fail(e);
        }
      }
    } finally {
      this.scrubbing = false;
      this.lastActive = performance.now();
    }
  }

  /**
   * One-shot draw (paused). Per layer: the exact frame from the cache if it is there; else a stand-in is drawn at once (the nearest cached frame of
   * that media, else the nearest filmstrip thumbnail) while the exact frame decodes (the handle cancels older requests: latest wins), then the exact
   * frame replaces it. `firstUpdateMs` = request to the first visible update, `scrubMs` = request to the exact frame. Export never sees stand-ins.
   */
  private async drawOne(f: number, t0: number): Promise<void> {
    const ticks = frameStartTicks(f, this.d.rate);
    const desc = await this.d.evaluate(ticks, 0);
    if (this.scrubTarget) return; // a newer target arrived while evaluating
    const pinned: DecodedFrame[] = [];
    const wants: { l: FrameDescription["layers"][number]; media: MediaHandle; idx: number; exact?: DecodedFrame; strip?: { bitmap: ImageBitmap; width: number; height: number; index: number } }[] = [];
    try {
      for (const l of desc.layers) {
        const media = this.d.media(l.media);
        if (!media?.info.video) continue;
        const idx = media.frameIndexAt(l.source_time);
        const exact = this.cache.get(l.media, idx);
        if (exact) pinned.push(exact);
        wants.push({ l, media, idx, exact });
      }
      // The scrub strip's small picture of the exact frame index (a few ms) beats the nearest cached frame or thumbnail as the first picture.
      if (this.d.strip) {
        await Promise.all(wants.map(async (w) => { if (!w.exact) w.strip = await this.d.strip!(w.l.media, w.idx).catch(() => undefined); }));
      }
      const draw = async (allowStandIns: boolean): Promise<boolean> => {
        const layers: RenderLayer[] = [];
        let shown = false;
        for (const w of wants) {
          let frame = w.exact;
          if (!frame && !allowStandIns) continue;
          if (frame) layers.push(await this.layer(w.l, frame, w.media, layers.length));
          else if (w.strip) {
            layers.push(layerOf(w.l, { source: w.strip.bitmap, width: w.strip.width, height: w.strip.height, rotation: w.media.info.video?.rotation ?? 0 }, this.d.size));
            this.stats.standIns++;
            this.stats.stripStandIns++;
            this.stats.standInOff.push(Math.abs(w.strip.index - w.idx));
            shown = true;
          } else {
            frame = this.cache.nearest(w.l.media, w.idx);
            if (frame) { pinned.push(frame); layers.push(await this.layer(w.l, frame, w.media, layers.length)); this.stats.standIns++; this.stats.standInOff.push(Math.abs(frame.index - w.idx)); shown = true; continue; }
            const t = this.d.standIn?.(w.l.media, w.l.source_time / TICKS_PER_SECOND);
            if (t) {
              layers.push(this.thumbLayer(w.l, t, w.media));
              this.stats.standIns++;
              this.stats.thumbStandIns++;
              const fps = w.media.info.video?.fps;
              this.stats.standInOff.push(Math.round(Math.abs(t.seconds - w.l.source_time / TICKS_PER_SECOND) * (fps && fps.den > 0 ? fps.num / fps.den : 30)));
              shown = true;
            }
          }
        }
        if (this.scrubTarget || this.playing || this.disposed) return false; // stale: drop it
        if (shown || !allowStandIns) this.d.renderer.render(layers, this.d.size);
        return shown;
      };
      const missing = wants.filter((w) => !w.exact);
      if (missing.length === 0) {
        // Everything is cached (frame step, small scrub, decode-ahead did its job): one draw is both the first update and the exact frame.
        this.stats.cacheHits++;
        await draw(false);
        const ms = performance.now() - t0;
        this.stats.firstUpdateMs.push(ms);
        this.stats.scrubMs.push(ms);
        void this.warmAround(wants);
        return;
      }
      // Stand-in first (only when something better than the held picture exists), then the exact frames.
      const standIn = await draw(true);
      if (standIn) this.stats.firstUpdateMs.push(performance.now() - t0);
      if (this.scrubTarget || this.playing) return;
      await Promise.all(missing.map(async (w) => {
        const t1 = performance.now();
        const frame = await w.media.videoFrame(w.idx);
        this.d.onSeek?.(w.l.media, performance.now() - t1);
        w.exact = this.cache.put(w.l.media, frame);
        pinned.push(w.exact);
      }));
      if (this.scrubTarget || this.playing) return;
      await draw(false);
      const ms = performance.now() - t0;
      if (!standIn) this.stats.firstUpdateMs.push(ms); // nothing was shown before: the first update is the exact frame
      this.stats.scrubMs.push(ms);
      void this.warmAround(wants);
    } finally {
      for (const p of pinned) this.cache.unpin(p);
      for (const w of wants) w.strip?.bitmap.close();
    }
  }

  // --- decode-ahead around a paused playhead ------------------------------------------------------------------------

  private cancelWarm(): void {
    this.warmToken++;
    for (const s of this.warmStreams) s.close();
    this.warmStreams.clear();
  }

  /**
   * Decode a few frames each side of the paused playhead in one sequential run (from `idx - K`), so frame steps and small scrubs hit the cache. The cache
   * budget bounds it; any seek, play or reconfigure cancels it at once (closing the stream).
   */
  private async warmAround(wants: { media: MediaHandle; l: { media: string }; idx: number }[]): Promise<void> {
    this.cancelWarm();
    const token = this.warmToken;
    const list = wants.slice(0, 2);
    const k = Math.max(1, Math.min(3, Math.floor((12 / Math.max(1, list.length) - 1) / 2)));
    for (const w of list) {
      if (token !== this.warmToken || this.disposed) return;
      let stream: FrameStream | undefined;
      try {
        stream = w.media.stream(Math.max(0, w.idx - k), 2);
        this.warmStreams.add(stream);
        for (;;) {
          const fr = await stream.next();
          if (!fr) break;
          if (token !== this.warmToken || fr.index > w.idx + k) { fr.release(); break; }
          if (this.cache.has(w.l.media, fr.index)) fr.release();
          else this.cache.unpin(this.cache.put(w.l.media, fr));
        }
      } catch {
        /* decode-ahead is only an aid: a failing stream just means a cache miss later */
      } finally {
        if (stream) { this.warmStreams.delete(stream); stream.close(); }
      }
    }
  }

  // --- feeds (sequential decode while playing) ---------------------------------------------------------------------

  private feed(clip: string, media: MediaHandle, idx: number): Feed {
    let f = this.feeds.get(clip);
    if (f && !f.closed) {
      // Jumped backwards, or the decoder fell far behind: restart at the wanted frame rather than decode through everything.
      const behind = f.current && idx < f.current.index;
      const far = f.queue.length === 0 && f.current && idx - f.current.index > Math.max(8, f.max * 2);
      if (!behind && !far) return f;
      this.dropFeed(f);
    }
    const v = media.info.video!;
    f = {
      clip, media, stream: undefined, queue: [], current: undefined, filling: false, closed: false, failed: false,
      max: prefetchFrames(this.d.prefetchBytes ?? 192 * 1024 * 1024, v.width, v.height),
    };
    f.stream = media.stream(idx, f.max);
    this.feeds.set(clip, f);
    void this.fill(f);
    return f;
  }

  private async fill(f: Feed): Promise<void> {
    if (f.filling) return;
    f.filling = true;
    try {
      while (!f.closed && f.stream && f.queue.length < f.max) {
        const fr = await f.stream.next();
        if (!fr) break;
        if (f.closed) { fr.release(); break; }
        f.queue.push(fr);
      }
    } catch (e) {
      if (!f.closed && !f.failed) { f.failed = true; this.fail(e); }
    } finally {
      f.filling = false;
    }
  }

  /** Wait (bounded) for the feed's first frame at `idx`, so playback starts with a picture. */
  private async prime(f: Feed, idx: number): Promise<void> {
    const until = performance.now() + 1500;
    while (!f.closed && f.queue.length === 0 && !f.current && performance.now() < until && !f.failed) await new Promise((r) => setTimeout(r, 4));
    void idx;
  }

  /** The decoded frame for media frame `idx`: skip frames the clock has passed, hold the previous one if the next is not ready. */
  private take(f: Feed, idx: number): DecodedFrame | undefined {
    while (f.queue.length > 0 && f.queue[0]!.index < idx) {
      const old = f.queue.shift()!;
      if (old !== f.current) old.release();
    }
    if (f.queue.length > 0 && f.queue[0]!.index === idx) {
      const next = f.queue.shift()!;
      if (f.current && f.current !== next) f.current.release();
      f.current = next;
    } else if (!f.current || f.current.index !== idx) {
      if (f.queue.length === 0 || f.queue[0]!.index > idx) {
        // Either a repeated media frame (media slower than the sequence: expected) or the decoder is late.
        if (!f.current || idx > f.current.index) this.stats.stalls += f.queue.length === 0 ? 1 : 0;
      }
    }
    if (!f.filling && f.queue.length < f.max) void this.fill(f);
    return f.current;
  }

  private dropFeed(f: Feed): void {
    f.closed = true;
    f.stream?.close();
    for (const q of f.queue.splice(0)) q.release();
    f.current?.release();
    f.current = undefined;
    this.feeds.delete(f.clip);
  }

  private closeFeeds(): void {
    for (const f of [...this.feeds.values()]) this.dropFeed(f);
  }

  // --- audio ------------------------------------------------------------------------------------------------------

  private async audioLoop(gen: number): Promise<void> {
    const a = this.d.audio;
    if (!a) return;
    const rate = this.d.audio?.sampleRate ?? 48_000;
    const n = Math.round(CHUNK_SECONDS * rate);
    try {
      while (gen === this.audioToken && this.playing) {
        const ahead = this.audioWhen - a.clock.now();
        if (ahead > AHEAD_SECONDS) { await new Promise((r) => setTimeout(r, 40)); continue; }
        const startTicks = this.audioPos;
        if (startTicks >= this.d.endTicks) return;
        const desc = await this.d.evaluate(startTicks, n);
        const left = new Float32Array(n);
        const right = new Float32Array(n);
        // The clock may have passed this chunk's start while it was prepared (slow decode): drop the late head instead of drifting.
        const late = Math.max(0, a.clock.now() - this.audioWhen);
        const skip = Math.min(n, Math.floor(late * rate));
        if (skip > 0) this.stats.audioTrimmed++;
        await Promise.all(desc.audio.map((seg) => this.mixOne(left, right, seg, skip)));
        if (gen !== this.audioToken || !this.playing) return;
        limit(left);
        limit(right);
        a.schedule(skip > 0 ? left.subarray(skip) : left, skip > 0 ? right.subarray(skip) : right, this.audioWhen + skip / rate);
        this.audioWhen += n / rate;
        this.audioPos += Math.round((n / rate) * TICKS_PER_SECOND);
      }
    } catch (e) {
      if (gen === this.audioToken) this.fail(e);
    }
  }

  private async mixOne(left: Float32Array, right: Float32Array, seg: AudioSegment, skip: number): Promise<void> {
    const media = this.d.media(seg.media);
    const ch = media?.info.audio?.channels;
    if (!media || !ch) return;
    const start = sampleAtTicks(seg.source_start, media.audioRate);
    const src = await media.audio(start, sourceSamplesFor(seg));
    mixSegment(left, right, seg, src, ch, skip);
  }

  private fail(e: unknown): void {
    this.d.onError?.(e instanceof Error ? e.message : String(e));
  }
}
