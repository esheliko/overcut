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
            editor_journal
        ])
        .run(tauri::generate_context!())
        .expect("error while running the application");
}
