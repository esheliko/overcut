//! Browser bindings. Keep this file thin: logic belongs in `app-core`, where it is testable natively.
//! Build with `npm run build:wasm` (output: packages/engine-client/wasm-pkg, git-ignored).

use wasm_bindgen::prelude::wasm_bindgen;

/// JSON of `app_core::EngineInfo`.
#[wasm_bindgen]
pub fn engine_info() -> String {
    app_core::engine_info_json()
}

/// Normalises the browser's raw probe JSON into `app_core::Capabilities` JSON (host `web`).
#[wasm_bindgen]
pub fn capabilities(probe_json: &str) -> Result<String, String> {
    app_core::capabilities_json(probe_json, "web", None)
}

#[cfg(test)]
mod tests {
    #[test]
    fn forwards_to_core() {
        assert_eq!(super::engine_info(), app_core::engine_info_json());
    }

    #[test]
    fn capabilities_are_stamped_web() {
        let json = super::capabilities("{}").unwrap();
        assert!(json.contains("\"host\":\"web\""), "{json}");
        assert!(super::capabilities("[]").is_err());
    }
}
