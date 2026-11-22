//! Browser bindings. Keep this file thin: logic belongs in `app-core`, where it is testable natively.
//! Build with `npm run build:wasm` (output: packages/engine-client/wasm-pkg, git-ignored).

use wasm_bindgen::prelude::wasm_bindgen;

/// JSON of `app_core::EngineInfo`.
#[wasm_bindgen]
pub fn engine_info() -> String {
    app_core::engine_info_json()
}

#[cfg(test)]
mod tests {
    #[test]
    fn forwards_to_core() {
        assert_eq!(super::engine_info(), app_core::engine_info_json());
    }
}
