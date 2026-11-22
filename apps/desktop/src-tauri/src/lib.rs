//! Native shell. Commands here mirror `packages/engine-client/src/tauri.ts`; keep them thin and forward to `app-core`.

#[tauri::command]
fn engine_info() -> String {
    app_core::engine_info_json()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![engine_info])
        .run(tauri::generate_context!())
        .expect("error while running the application");
}
