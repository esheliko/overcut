// node run.mjs : builds the cdylib for wasm32 and prints the checksum and ns per sample. Compare with
// `cargo run --release -p app-model --example s9_native` (checksum) - both must print the same value.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
execSync("cargo build --release --target wasm32-unknown-unknown", { stdio: "inherit", cwd: new URL(".", import.meta.url) });
const bytes = readFileSync(new URL("target/wasm32-unknown-unknown/release/s9_wasm.wasm", import.meta.url));
const { instance } = await WebAssembly.instantiate(bytes, {});
const { checksum } = instance.exports;
checksum(10_000); // warm up
const t0 = performance.now();
const h = checksum(1_000_000);
const ms = performance.now() - t0;
console.log(`wasm checksum(1M) = ${BigInt.asUintN(64, h)}  ${(ms * 1e6 / 1e6).toFixed(0)} ns/sample (includes key generation)`);
