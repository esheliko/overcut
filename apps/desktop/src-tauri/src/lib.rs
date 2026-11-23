//! Native shell. Commands here mirror `packages/engine-client/src/tauri.ts`; keep them thin and forward to `app-core` / `app-timeline`.

use std::sync::Mutex;
use tauri::State;

/// The one open project (a window edits one project at a time in M1).
#[derive(Default)]
struct EditorState(Mutex<Option<app_timeline::Editor>>);

fn with_editor<T>(
    state: &State<'_, EditorState>,
    f: impl FnOnce(&mut app_timeline::Editor) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = state.0.lock().map_err(|_| "editor state poisoned".to_string())?;
    f(guard.as_mut().ok_or("no project is open")?)
}

#[tauri::command]
fn engine_info() -> String {
    app_core::engine_info_json()
}

#[tauri::command]
fn editor_open(state: State<'_, EditorState>, project_json: String) -> Result<(), String> {
    let editor = app_timeline::Editor::open(&project_json)?;
    *state.0.lock().map_err(|_| "editor state poisoned".to_string())? = Some(editor);
    Ok(())
}

#[tauri::command]
fn editor_apply(
    state: State<'_, EditorState>,
    op_json: String,
    coalesce: Option<u32>,
) -> Result<String, String> {
    with_editor(&state, |e| e.apply_json(&op_json, coalesce))
}

#[tauri::command]
fn editor_undo(state: State<'_, EditorState>) -> Result<String, String> {
    with_editor(&state, |e| e.undo_json())
}

#[tauri::command]
fn editor_redo(state: State<'_, EditorState>) -> Result<String, String> {
    with_editor(&state, |e| e.redo_json())
}

#[tauri::command]
fn editor_project(state: State<'_, EditorState>) -> Result<String, String> {
    with_editor(&state, |e| Ok(e.project_json()))
}

#[tauri::command]
fn editor_journal(state: State<'_, EditorState>) -> Result<String, String> {
    with_editor(&state, |e| Ok(e.journal_jsonl()))

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

#[tauri::command]
fn editor_take_log(state: State<'_, EditorState>) -> Result<String, String> {
    with_editor(&state, |e| Ok(e.take_log()))
}

#[tauri::command]
fn editor_checkpoint(state: State<'_, EditorState>) -> Result<String, String> {
    with_editor(&state, |e| Ok(e.checkpoint_json()))
}

/// Replaces the open editor with one rebuilt from a base, a checkpoint and the commit log; returns the `Recovery` report JSON.
#[tauri::command]
fn editor_recover(
    state: State<'_, EditorState>,
    base_json: Option<String>,
    checkpoint_json: Option<String>,
    log: String,
) -> Result<String, String> {
    let (editor, report) = app_timeline::Editor::recover_json(
        base_json.as_deref(),
        checkpoint_json.as_deref(),
        &log,
    )?;
    *state.0.lock().map_err(|_| "editor state poisoned".to_string())? = Some(editor);
    Ok(report)
}

#[tauri::command]
fn media_fingerprint(size: f64, first: Vec<u8>, last: Vec<u8>) -> Result<String, String> {
    if !(size >= 0.0 && size.fract() == 0.0 && size < 9_007_199_254_740_992.0) {
        return Err(r#"{"code":"invalid","message":"file size must be a whole number of bytes"}"#.into());
    }
    app_model::fingerprint(size as u64, &first, &last).map_err(|e| e.to_json())
}

/// Project folders live under the app data directory: `<app data>/projects/<project>/`. `project` is a flat name, checked like file names.
fn project_dir(app: &tauri::AppHandle, project: &str) -> Result<app_store::ProjectDir, String> {
    use tauri::Manager;
    let ok = !project.is_empty()
        && project.len() <= 64
        && project
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !ok {
        return Err("invalid project name".into());
    }
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("projects")
        .join(project);
    app_store::ProjectDir::open(root).map_err(|e| e.to_string())
}

// Storage errors cross as `{"code","message"}` JSON so the UI can say what happened (disk full, no permission) instead of failing silently.
fn io_err(e: std::io::Error) -> String {
    let code = match e.kind() {
        std::io::ErrorKind::PermissionDenied => "permission",
        std::io::ErrorKind::StorageFull | std::io::ErrorKind::QuotaExceeded => "quota",
        _ => "io",
    };
    let message = e.to_string().replace('\\', "\\\\").replace('"', "\\\"");
    format!(r#"{{"code":"{code}","message":"{message}"}}"#)
}

#[tauri::command]
fn store_read(app: tauri::AppHandle, project: String, name: String) -> Result<Option<Vec<u8>>, String> {
    project_dir(&app, &project)?.read(&name).map_err(io_err)
}

#[tauri::command]
fn store_write_atomic(app: tauri::AppHandle, project: String, name: String, bytes: Vec<u8>) -> Result<(), String> {
    project_dir(&app, &project)?.write_atomic(&name, &bytes).map_err(io_err)
}

#[tauri::command]
fn store_append(app: tauri::AppHandle, project: String, name: String, bytes: Vec<u8>) -> Result<(), String> {
    project_dir(&app, &project)?.append(&name, &bytes).map_err(io_err)
}

#[tauri::command]
fn store_truncate(app: tauri::AppHandle, project: String, name: String, size: u64) -> Result<(), String> {
    project_dir(&app, &project)?.truncate(&name, size).map_err(io_err)
}

#[tauri::command]
fn store_remove(app: tauri::AppHandle, project: String, name: String) -> Result<(), String> {
    project_dir(&app, &project)?.remove(&name).map_err(io_err)
}

/// Same contract as `project_open` in `crates/wasm`. Bytes cross IPC as JSON arrays for now (project files are small).
#[tauri::command]
fn project_open(bytes: Vec<u8>) -> Result<String, String> {
    app_model::open_json(&bytes).map_err(|e| e.to_json())
}

#[tauri::command]
fn project_save(project_json: String, previous: Vec<u8>) -> Result<Vec<u8>, String> {
    app_model::save_bytes(&project_json, &previous).map_err(|e| e.to_json())
}

#[tauri::command]
fn editor_evaluate(
    state: State<'_, EditorState>,
    sequence: String,
    ticks: i64,
    audio_samples: u32,
) -> Result<String, String> {
    with_editor(&state, |e| e.evaluate_json(&sequence, ticks, audio_samples))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(EditorState::default())
        .invoke_handler(tauri::generate_handler![
            engine_info,
            editor_open,
            editor_apply,
            editor_undo,
            editor_redo,
            editor_project,
            editor_journal,
            capabilities,
            editor_take_log,
            editor_checkpoint,
            editor_recover,
            media_fingerprint,
            store_read,
            store_write_atomic,
            store_append,
            store_truncate,
            store_remove,
            project_open,
            project_save,
            editor_evaluate
        ])
        .run(tauri::generate_context!())
        .expect("error while running the application");
}
