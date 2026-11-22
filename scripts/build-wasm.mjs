#!/usr/bin/env node
// Builds crates/wasm into packages/engine-client/wasm-pkg (ES module + .wasm), the package the web app loads.
// Needs: the wasm32-unknown-unknown target (rust-toolchain.toml installs it) and the matching `wasm-bindgen` CLI:
//   cargo install wasm-bindgen-cli --version <the version pinned in crates/wasm/Cargo.toml> --locked
// Optional: `wasm-opt` (binaryen) is used on release builds when present.   Flags: --dev (skip optimisation, faster)
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const dev = process.argv.includes('--dev');
const pinned = /wasm-bindgen\s*=\s*"=?([\d.]+)"/.exec(readFileSync('crates/wasm/Cargo.toml', 'utf8'))?.[1];
const have = spawnSync('wasm-bindgen', ['--version'], { encoding: 'utf8' });
if (have.error || have.status !== 0) { console.error(`wasm-bindgen CLI not found. Install it: cargo install wasm-bindgen-cli --version ${pinned} --locked`); process.exit(1); }
if (pinned && !have.stdout.includes(pinned)) { console.error(`wasm-bindgen CLI is "${have.stdout.trim()}" but crates/wasm pins ${pinned}: cargo install wasm-bindgen-cli --version ${pinned} --locked --force`); process.exit(1); }

const profile = dev ? 'debug' : 'release';
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
run('cargo', ['build', '-p', 'app-wasm', '--target', 'wasm32-unknown-unknown', ...(dev ? [] : ['--release'])]);
const wasm = `target/wasm32-unknown-unknown/${profile}/app_wasm.wasm`;
run('wasm-bindgen', ['--target', 'web', '--out-dir', 'packages/engine-client/wasm-pkg', '--out-name', 'app_wasm', ...(dev ? ['--debug'] : []), wasm]);
if (!dev && spawnSync('wasm-opt', ['--version']).status === 0) run('wasm-opt', ['-O3', '-o', 'packages/engine-client/wasm-pkg/app_wasm_bg.wasm', 'packages/engine-client/wasm-pkg/app_wasm_bg.wasm']);
console.log('wasm built: packages/engine-client/wasm-pkg');
