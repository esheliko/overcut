#!/usr/bin/env node
// Architecture guard (run by `npm run lint`). The engine stays portable and the UI stays platform-agnostic:
//  1. every engine crate except crates/wasm depends on no platform crate (wasm-bindgen, web-sys, js-sys, tauri): it must build and test natively.
//  2. Only packages/engine-client/src/wasm.ts may import the generated wasm package; only .../tauri.ts may import @tauri-apps/*.
//  3. UI and package code never imports Rust sources by path.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PLATFORM_CRATES = ['wasm-bindgen', 'web-sys', 'js-sys', 'wasm-bindgen-futures', 'tauri'];
/** Matches a real import of a module path (static `from`, side-effect `import`, dynamic `import()`), not a mention in a config or a type declaration. */
const IMPORT = (mod) => new RegExp(`(?:from\\s*|import\\s*\\(?\\s*)['"]${mod}`);
const WASM_OK = 'packages/engine-client/src/wasm.ts';
const TAURI_OK = 'packages/engine-client/src/tauri.ts';

/** Pure: problems in [{ path, text }] (paths use "/"). Empty = fine. */
export function findViolations(files) {
  const out = [];
  for (const { path, text } of files) {
    if (/^crates\/[^/]+\/Cargo\.toml$/.test(path) && path !== 'crates/wasm/Cargo.toml') {
      const deps = text.split(/^\[/m).filter((s) => /^(dev-|build-)?dependencies\b/.test(s)).join('\n');
      for (const c of PLATFORM_CRATES) if (new RegExp(`^${c}\\s*[=.]`, 'm').test(deps)) out.push(`${path}: depends on platform crate "${c}" (engine crates must stay portable; put bindings in crates/wasm or the Tauri shell)`);
    }
    if (/^(apps|packages)\/.+\.(ts|tsx)$/.test(path)) {
      if (path !== WASM_OK && IMPORT('@app\\/wasm-pkg').test(text)) out.push(`${path}: imports the wasm package directly (go through @app/engine-client)`);
      if (path !== TAURI_OK && IMPORT('@tauri-apps\\/').test(text)) out.push(`${path}: imports @tauri-apps/* directly (go through @app/engine-client)`);
      if (IMPORT('[./]*\\/?crates\\/').test(text)) out.push(`${path}: imports Rust sources by path`);
    }
  }
  return out;
}

function collect(dir, files = []) {
  for (const n of readdirSync(dir)) {
    if (['node_modules', 'target', 'dist', 'wasm-pkg', '.git'].includes(n)) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) collect(p, files);
    else if (/\.(ts|tsx|toml)$/.test(n)) files.push({ path: p.split('\\').join('/'), text: readFileSync(p, 'utf8') });
  }
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = ['apps', 'packages', 'crates'].flatMap((d) => collect(d));
  const bad = findViolations(files);
  if (bad.length) { console.error(bad.join('\n')); process.exit(1); }
  console.log(`boundaries ok (${files.length} files checked)`);
}
