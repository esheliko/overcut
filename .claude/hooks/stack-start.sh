#!/usr/bin/env bash
# Sourced by session-start.sh (kit/core). Say plainly which parts of the toolchain this session has, so nobody claims a check ran when it could not.
missing=""
for t in node npm cargo; do command -v "$t" >/dev/null 2>&1 || missing="$missing $t"; done
if [ -n "$missing" ]; then
  echo "TOOLCHAIN: missing in this session:$missing. Without them lint/typecheck/test cannot all run: say which checks you could not run."
fi
if ! command -v wasm-bindgen >/dev/null 2>&1; then
  echo "TOOLCHAIN: wasm-bindgen CLI missing: 'npm run build:wasm' / 'npm run dev' / 'npm run build' fail until it is installed (version pinned in crates/wasm/Cargo.toml: cargo install wasm-bindgen-cli --version <pin> --locked). lint, typecheck and test do not need it."
fi
[ -d node_modules ] || echo "SETUP: node_modules is missing: run 'npm ci' first."
