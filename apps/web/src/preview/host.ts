/**
 * UI-thread side of the preview Worker (M1-023). Owns the Worker, hands it the canvas (`transferControlToOffscreen`), runs the AudioContext
 * (Web Audio does not exist in workers; its output position is the master clock, sampled here and sent to the Worker), and mirrors the little
 * player state the UI reads (`frame`, `isPlaying`, `speed`) from the Worker's messages. The UI thread only receives state.
 */
import type { RendererInfo } from "@app/engine-client";
import { createWebAudio } from "./audio";
import type { AudioOut } from "./player";
import { epochNow, type FromPreview, type PreviewConfig, type PreviewRpc, type ToPreview } from "./protocol";
import { TICKS_PER_SECOND } from "./timing";

export interface HostHandlers {
  onFrame(frame: number): void;
  onState(playing: boolean, rate: number): void;
  onError(message: string): void;
}

/** The player as the UI sees it: synchronous reads of mirrored state, commands forwarded to the Worker. */
export class PlayerProxy {
  frame = 0;
  isPlaying = false;
  speed = 0;
  endFrame = 0;
  constructor(private readonly host: PreviewHost) {}
  seek(frame: number): void { this.frame = Math.min(this.endFrame, Math.max(0, Math.floor(frame))); this.host.send({ type: "cmd", cmd: { name: "seek", frame: this.frame } }); }
  step(delta: number): void { this.seek(this.frame + delta); }
  toggle(): void { this.host.unlockAudio(); this.host.send({ type: "cmd", cmd: { name: "toggle" } }); }
  key(key: "J" | "K" | "L"): void { this.host.unlockAudio(); this.host.send({ type: "cmd", cmd: { name: "key", key } }); }
  pause(): void { this.host.send({ type: "cmd", cmd: { name: "pause" } }); }
}

const transferred = new WeakSet<HTMLCanvasElement>();

export class PreviewHost {
  readonly player = new PlayerProxy(this);
  /** Resolves with the backend in use, rejects with a plain message when no GPU backend works. */
  readonly ready: Promise<RendererInfo>;
  private readonly worker: Worker;
  private audio: AudioOut | undefined;
  private clockTimer: ReturnType<typeof setInterval> | undefined;
  private nextId = 1;
  private readonly waiting = new Map<number, (v: unknown) => void>();
  disposed = false;

  constructor(canvas: HTMLCanvasElement, public h: HostHandlers, prefer: "auto" | "webgpu" | "webgl2" = "auto") {
    if (transferred.has(canvas)) throw new Error("this canvas already belongs to a preview");
    transferred.add(canvas);
    const offscreen = canvas.transferControlToOffscreen();
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.ready = new Promise<RendererInfo>((resolve, reject) => {
      this.onReady = { resolve, reject };
    });
    this.worker.addEventListener("message", (e: MessageEvent<FromPreview>) => this.onMessage(e.data));
    this.worker.addEventListener("error", (e) => this.onReady?.reject(new Error(e.message || "preview worker failed")));
    this.send({ type: "init", canvas: offscreen, prefer }, [offscreen]);
  }
  private onReady: { resolve(i: RendererInfo): void; reject(e: Error): void } | undefined;

  send(m: ToPreview, transfer: Transferable[] = []): void {
    if (!this.disposed) this.worker.postMessage(m, transfer);
  }

  /** Called from a user gesture (play key/click): starts the audio output while the gesture is still on the stack (Safari needs that). */
  unlockAudio(): void {
    this.audio ??= createWebAudio(48_000);
    void this.audio?.resume();
  }

  /** The shared project (or the sequence settings) changed: the Worker re-reads it and the same player takes the new length, rate and clips. */
  configure(c: PreviewConfig): void {
    this.player.endFrame = Math.ceil((c.endTicks * c.rate.num) / (TICKS_PER_SECOND * c.rate.den));
    this.player.frame = Math.min(this.player.frame, this.player.endFrame);
    this.send({ type: "config", ...c });
  }

  resize(width: number, height: number): void { this.send({ type: "resize", width, height }); }

  /** Test and measurement requests. */
  rpc<T = unknown>(rpc: PreviewRpc): Promise<T> {
    return new Promise<T>((resolve) => {
      const id = this.nextId++;
      this.waiting.set(id, resolve as (v: unknown) => void);
      this.send({ type: "rpc", id, rpc });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.send({ type: "dispose" });
    this.disposed = true;
    this.stopClock();
    this.audio?.stop();
    this.worker.terminate();
  }

  private sampleClock(): void {
    if (!this.audio) return;
    this.send({ type: "clock", audio: this.audio.clock.now(), epoch: epochNow() });
  }
  private startClock(): void {
    if (this.clockTimer || !this.audio) return;
    this.clockTimer = setInterval(() => this.sampleClock(), 100);
  }
  private stopClock(): void {
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.clockTimer = undefined;
  }

  private onMessage(m: FromPreview): void {
    switch (m.type) {
      case "ready": this.onReady?.resolve(m.info); return;
      case "fail": this.onReady?.reject(new Error(m.message)); return;
      case "frame": this.player.frame = m.frame; this.h.onFrame(m.frame); return;
      case "state":
        this.player.isPlaying = m.playing;
        this.player.speed = m.rate;
        if (m.playing) this.startClock(); else this.stopClock();
        this.h.onState(m.playing, m.rate);
        return;
      case "error": this.h.onError(m.message); return;
      case "audio": this.audio?.schedule(m.left, m.right, m.when); return;
      case "audio-stop": this.audio?.stop(); return;
      case "request": void this.answerAudio(m.id); return;
      case "reply": this.waiting.get(m.id)?.(m.value); this.waiting.delete(m.id); return;
    }
  }

  private async answerAudio(id: number): Promise<void> {
    this.audio ??= createWebAudio(48_000);
    const running = (await this.audio?.resume()) ?? false;
    this.send({ type: "reply", id, value: { running, audio: this.audio?.clock.now() ?? 0, epoch: epochNow() } });
  }
}

const registry = new WeakMap<HTMLCanvasElement, { host: PreviewHost; refs: number; timer?: ReturnType<typeof setTimeout> }>();

/**
 * One host per canvas element (a canvas can be handed to a Worker once). React may unmount and remount the same element in one tick (StrictMode,
 * effect re-runs): the Worker is only disposed when nobody re-acquired the canvas by the next task.
 */
export function acquirePreviewHost(canvas: HTMLCanvasElement, handlers: HostHandlers): { host: PreviewHost; release(): void } {
  let e = registry.get(canvas);
  if (e) { clearTimeout(e.timer); e.timer = undefined; e.host.h = handlers; }
  else { e = { host: new PreviewHost(canvas, handlers), refs: 0 }; registry.set(canvas, e); }
  e.refs++;
  const entry = e;
  return {
    host: entry.host,
    release() {
      if (--entry.refs > 0) return;
      entry.timer = setTimeout(() => { entry.host.dispose(); registry.delete(canvas); }, 0);
    },
  };
}
