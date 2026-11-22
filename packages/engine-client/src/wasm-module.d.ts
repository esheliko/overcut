// Hand-written surface of the generated WebAssembly package (`npm run build:wasm` writes the real one to ../wasm-pkg).
// tsconfig `paths` and the Vite alias both map "@app/wasm-pkg": types come from here (so typecheck works before the engine is built),
// code comes from the generated package. Keep in sync with crates/wasm/src/lib.rs.
declare module "@app/wasm-pkg" {
  export default function init(module?: unknown): Promise<unknown>;
  export function engine_info(): string;
  export function project_open(bytes: Uint8Array): string;
  export function project_save(project_json: string, previous: Uint8Array): Uint8Array;
  /** An open project plus its undo history. Mirrors `Editor` in crates/wasm/src/lib.rs; all data is JSON strings. */
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
  }
  export function capabilities(probe_json: string): string;
}
