//! OverCut engine core.
//!
//! Rules (checked by `npm run lint`, `scripts/check-boundaries.mjs`):
//! - no platform crates here (`wasm-bindgen`, `web-sys`, `js-sys`, `tauri`): this crate must build and test natively;
//! - no I/O except through traits the host provides;
//! - data crosses the language boundary as JSON strings (or typed buffers) described in `packages/engine-client`.

use serde::{Deserialize, Serialize};

mod capabilities;
pub use capabilities::*;

/// Bumped when the shape of anything crossing the JS boundary changes incompatibly.
pub const ABI_VERSION: u32 = 1;

/// What the host (web or native shell) learns about the engine it loaded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EngineInfo {
    pub name: String,
    pub version: String,
    pub abi: u32,
}

/// Identity of this engine build.
pub fn engine_info() -> EngineInfo {
    EngineInfo {
        name: "overcut".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        abi: ABI_VERSION,
    }
}

/// `engine_info` as the JSON string the shells hand to the UI.
pub fn engine_info_json() -> String {
    serde_json::to_string(&engine_info()).expect("EngineInfo always serializes")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn info_round_trips_through_json() {
        let parsed: EngineInfo = serde_json::from_str(&engine_info_json()).unwrap();
        assert_eq!(parsed, engine_info());
        assert_eq!(parsed.abi, ABI_VERSION);
    }

    #[test]
    fn version_is_semver_like() {
        let v = engine_info().version;
        assert_eq!(v.split('.').count(), 3, "{v}");
    }
}
