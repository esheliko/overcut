import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/target/**", "**/wasm-pkg/**", "**/node_modules/**", "**/*.d.ts", "apps/desktop/src-tauri/gen/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: { "@typescript-eslint/consistent-type-imports": "error" },
  },
  { files: ["**/*.mjs"], languageOptions: { globals: globals.node } },
  { files: ["**/sw.js"], languageOptions: { globals: globals.serviceworker } },
);
