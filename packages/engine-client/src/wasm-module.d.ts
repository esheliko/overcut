// Hand-written surface of the generated WebAssembly package (`npm run build:wasm` writes the real one to ../wasm-pkg).
// tsconfig `paths` and the Vite alias both map "@app/wasm-pkg": types come from here (so typecheck works before the engine is built),
// code comes from the generated package. Keep in sync with crates/wasm/src/lib.rs.
declare module "@app/wasm-pkg" {
  export default function init(module?: unknown): Promise<unknown>;
  export function engine_info(): string;
}
