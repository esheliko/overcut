// Hand-written surface of the generated WebAssembly package (`npm run build:wasm` writes the real one to ../wasm-pkg).
// tsconfig `paths` and the Vite alias both map "@app/wasm-pkg": types come from here (so typecheck works before the engine is built),
// code comes from the generated package. Keep in sync with crates/wasm/src/lib.rs.
declare module "@app/wasm-pkg" {
  export default function init(module?: unknown): Promise<unknown>;
  export function engine_info(): string;
  export function project_open(bytes: Uint8Array): string;
  export function project_save(project_json: string, previous: Uint8Array): Uint8Array;
  export function media_fingerprint(size: number, first: Uint8Array, last: Uint8Array): string;
  /** An open project plus its undo history. Mirrors `Editor` in crates/wasm/src/lib.rs; all data is JSON strings. */
  /** Decoded frame held by the engine; `free()` releases the host frame. Mirrors `FrameRef` in crates/wasm/src/media.rs. */
  export class FrameRef {
    index(): number;
    ptsTicks(): number;
    width(): number;
    height(): number;
    gpuId(): number | undefined;
    pixels(): Uint8Array | undefined;
    free(): void;
  }
  /** Opened media file (probe + `HostDecoder`). Mirrors `MediaFile` in crates/wasm/src/media.rs. */
  export class MediaFile {
    static open(source: { length: number; read(offset: number, len: number): Promise<Uint8Array> }): Promise<MediaFile>;
    info(): string;
    videoPacketsJson(): string;
    videoDescription(): Uint8Array;
    audioDescription(): Uint8Array;
    attach(host: object, audioRate: number): void;
    setGpu(gpu: boolean): void;
    videoFrame(index: number): Promise<FrameRef>;
    audio(startSample: number, count: number): Promise<Float32Array>;
    free(): void;
  }
  export class Editor {
    constructor(projectJson: string);
    free(): void;
    apply(opJson: string, coalesce?: number): string;
    undo(): string;
    redo(): string;
    project(): string;
    journal(): string;
    /** `FrameDescription` JSON; `ticks` is a BigInt (i64 in Rust). */
    evaluate(sequence: string, ticks: bigint, audioSamples: number): string;
    take_log(): string;
    checkpoint(): string;
    static recover(baseJson: string | undefined, checkpointJson: string | undefined, log: string): Editor;
    recovery(): string | undefined;
  }
  /** A waveform extraction. Mirrors `PeaksJob` in crates/wasm/src/lib.rs. */
  export class PeaksJob {
    constructor(sampleRate: number, channels: number, resume: Uint8Array);
    free(): void;
    next_frame(): number;
    push(pcm: Int16Array): void;
    snapshot(): Uint8Array;
    finish(): Uint8Array;
  }
  /** A parsed peaks file. Mirrors `PeaksView`. */
  export class PeaksView {
    constructor(bytes: Uint8Array);
    free(): void;
    sample_rate(): number;
    frames(): number;
    complete(): boolean;
    columns(startFrame: number, framesPerPx: number, count: number): Int16Array;
  }
}
