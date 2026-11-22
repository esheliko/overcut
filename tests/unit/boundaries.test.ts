import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error plain .mjs script, no types
import { findViolations } from "../../scripts/check-boundaries.mjs";

const f = (path: string, text: string) => ({ path, text });

test("engine crates may not depend on platform crates (only crates/wasm may)", () => {
  const bad = findViolations([f("crates/core/Cargo.toml", '[dependencies]\nserde = "1"\nweb-sys = "0.3"\n')]);
  assert.equal(bad.length, 1);
  assert.match(bad[0], /web-sys/);
  assert.deepEqual(findViolations([f("crates/core/Cargo.toml", '[dependencies]\nserde = "1"\n')]), []);
  assert.equal(findViolations([f("crates/render/Cargo.toml", '[dependencies]\nweb-sys = "0.3"\n')]).length, 1);
  assert.deepEqual(findViolations([f("crates/wasm/Cargo.toml", '[dependencies]\nwasm-bindgen = "0.2"\n')]), []);
});

test("only engine-client may import the wasm package or Tauri", () => {
  const ui = f("apps/web/src/App.tsx", 'import init from "@app/wasm-pkg";\nimport { invoke } from "@tauri-apps/api/core";');
  assert.equal(findViolations([ui]).length, 2);
  assert.deepEqual(findViolations([f("packages/engine-client/src/wasm.ts", 'await import("@app/wasm-pkg");')]), []);
  assert.deepEqual(findViolations([f("packages/engine-client/src/tauri.ts", 'import { invoke } from "@tauri-apps/api/core";')]), []);
  assert.equal(findViolations([f("packages/engine-client/src/index.ts", 'import "@tauri-apps/api/core";')]).length, 1);
});

test("UI code never reaches into the Rust crates by path", () => {
  assert.equal(findViolations([f("apps/web/src/x.ts", 'import "../../../crates/core/src/lib";')]).length, 1);
});

test("the real repository passes", () => {
  const files: { path: string; text: string }[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (["node_modules", "target", "dist", "wasm-pkg", ".git"].includes(n)) continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|toml)$/.test(n)) files.push({ path: p.split("\\").join("/"), text: readFileSync(p, "utf8") });
    }
  };
  for (const d of ["apps", "packages", "crates"]) walk(d);
  assert.deepEqual(findViolations(files), []);
});
