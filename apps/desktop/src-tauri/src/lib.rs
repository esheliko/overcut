//! Native shell. Commands here mirror `packages/engine-client/src/tauri.ts`; keep them thin and forward to `app-core`.

#[tauri::command]
fn engine_info() -> String {
    app_core::engine_info_json()
}

/// The webview's raw probe, normalised, plus the facts only the native side knows.
#[tauri::command]
fn capabilities(probe_json: String) -> Result<String, String> {
    let native = app_core::NativeInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        cores: std::thread::available_parallelism().ok().map(|n| n.get() as u32),
    };
    app_core::capabilities_json(&probe_json, "tauri", Some(&native))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![engine_info, capabilities])
        .run(tauri::generate_context!())
        .expect("error while running the application");
}
