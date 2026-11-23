//! Native shell. Commands here mirror `packages/engine-client/src/tauri.ts`; keep them thin and forward to `app-core` / `app-timeline`.

mod desktop;
#[cfg(feature = "native-media")]
mod native;

use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;

/// The one open project (a window edits one project at a time in M1).
#[derive(Default)]
struct EditorState(Mutex<Option<app_timeline::Editor>>);

fn with_editor<T>(
    state: &State<'_, EditorState>,
    f: impl FnOnce(&mut app_timeline::Editor) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "editor state poisoned".to_string())?;
    f(guard.as_mut().ok_or("no project is open")?)
}

#[tauri::command]
fn engine_info() -> String {
    app_core::engine_info_json()
}

#[tauri::command]
fn editor_open(state: State<'_, EditorState>, project_json: String) -> Result<(), String> {
    let editor = app_timeline::Editor::open(&project_json)?;
    *state
        .0
        .lock()
        .map_err(|_| "editor state poisoned".to_string())? = Some(editor);
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
    let (editor, report) =
        app_timeline::Editor::recover_json(base_json.as_deref(), checkpoint_json.as_deref(), &log)?;
    *state
        .0
        .lock()
        .map_err(|_| "editor state poisoned".to_string())? = Some(editor);
    Ok(report)
}

#[tauri::command]
fn media_fingerprint(size: f64, first: Vec<u8>, last: Vec<u8>) -> Result<String, String> {
    if !(size >= 0.0 && size.fract() == 0.0 && size < 9_007_199_254_740_992.0) {
        return Err(
            r#"{"code":"invalid","message":"file size must be a whole number of bytes"}"#.into(),
        );
    }
    app_model::fingerprint(size as u64, &first, &last).map_err(|e| e.to_json())
}

/// Project folders live under the projects root: the folder the person chose, else `<app data>/projects` (`app_store::desktop`).
fn project_dir(app: &tauri::AppHandle, project: &str) -> Result<app_store::ProjectDir, String> {
    app_store::desktop::project_dir(&desktop::app_data(app)?, project).map_err(|e| e.to_string())
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
fn store_read(
    app: tauri::AppHandle,
    project: String,
    name: String,
) -> Result<Option<Vec<u8>>, String> {
    project_dir(&app, &project)?.read(&name).map_err(io_err)
}

#[tauri::command]
fn store_write_atomic(
    app: tauri::AppHandle,
    project: String,
    name: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    project_dir(&app, &project)?
        .write_atomic(&name, &bytes)
        .map_err(io_err)
}

#[tauri::command]
fn store_append(
    app: tauri::AppHandle,
    project: String,
    name: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    project_dir(&app, &project)?
        .append(&name, &bytes)
        .map_err(io_err)
}

#[tauri::command]
fn store_truncate(
    app: tauri::AppHandle,
    project: String,
    name: String,
    size: u64,
) -> Result<(), String> {
    project_dir(&app, &project)?
        .truncate(&name, size)
        .map_err(io_err)
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

/// Waveform jobs and parsed peaks files, by id (mirrors `PeaksJob` / `PeaksView` in `crates/wasm`).
#[derive(Default)]
struct PeaksState {
    next: u32,
    jobs: HashMap<u32, app_audio::peaks::PeaksBuilder>,
    views: HashMap<u32, app_audio::peaks::Peaks>,
}

fn with_peaks<T>(
    state: &State<'_, Mutex<PeaksState>>,
    f: impl FnOnce(&mut PeaksState) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = state
        .lock()
        .map_err(|_| "peaks state poisoned".to_string())?;
    f(&mut guard)
}

/// Starts an extraction; returns `{id, next_frame}` JSON. `resume` is a cached partial file (empty = fresh).
#[tauri::command]
fn peaks_job_begin(
    state: State<'_, Mutex<PeaksState>>,
    sample_rate: u32,
    channels: u16,
    resume: Vec<u8>,
) -> Result<String, String> {
    with_peaks(&state, |s| {
        let b = if resume.is_empty() {
            app_audio::peaks::PeaksBuilder::new(sample_rate, channels)
        } else {
            app_audio::peaks::PeaksBuilder::resume(&resume, channels).map_err(|e| e.to_string())?
        };
        s.next += 1;
        let (id, next_frame) = (s.next, b.next_frame());
        s.jobs.insert(id, b);
        Ok(format!("{{\"id\":{id},\"next_frame\":{next_frame}}}"))
    })
}

#[tauri::command]
fn peaks_job_push(
    state: State<'_, Mutex<PeaksState>>,
    id: u32,
    pcm: Vec<i16>,
) -> Result<(), String> {
    with_peaks(&state, |s| {
        s.jobs.get_mut(&id).ok_or("no such job")?.push(&pcm);
        Ok(())
    })
}

#[tauri::command]
fn peaks_job_snapshot(state: State<'_, Mutex<PeaksState>>, id: u32) -> Result<Vec<u8>, String> {
    with_peaks(&state, |s| {
        Ok(s.jobs.get(&id).ok_or("no such job")?.snapshot().to_bytes())
    })
}

#[tauri::command]
fn peaks_job_finish(state: State<'_, Mutex<PeaksState>>, id: u32) -> Result<Vec<u8>, String> {
    with_peaks(&state, |s| {
        Ok(s.jobs.remove(&id).ok_or("no such job")?.finish().to_bytes())
    })
}

#[tauri::command]
fn peaks_job_drop(state: State<'_, Mutex<PeaksState>>, id: u32) -> Result<(), String> {
    with_peaks(&state, |s| {
        s.jobs.remove(&id);
        Ok(())
    })
}

/// Parses a peaks file; returns `{id, sample_rate, frames, complete}` JSON.
#[tauri::command]
fn peaks_view_open(state: State<'_, Mutex<PeaksState>>, bytes: Vec<u8>) -> Result<String, String> {
    with_peaks(&state, |s| {
        let p = app_audio::peaks::Peaks::from_bytes(&bytes).map_err(|e| e.to_string())?;
        s.next += 1;
        let id = s.next;
        let json = format!(
            "{{\"id\":{id},\"sample_rate\":{},\"frames\":{},\"complete\":{}}}",
            p.sample_rate, p.frames, p.complete
        );
        s.views.insert(id, p);
        Ok(json)
    })
}

#[tauri::command]
fn peaks_view_columns(
    state: State<'_, Mutex<PeaksState>>,
    id: u32,
    start_frame: f64,
    frames_per_px: f64,
    count: usize,
) -> Result<Vec<i16>, String> {
    with_peaks(&state, |s| {
        let mut pairs = Vec::with_capacity(count);
        s.views.get(&id).ok_or("no such peaks view")?.columns(
            start_frame,
            frames_per_px,
            count,
            &mut pairs,
        );
        Ok(pairs.into_iter().flatten().collect())
    })
}

#[tauri::command]
fn peaks_view_close(state: State<'_, Mutex<PeaksState>>, id: u32) -> Result<(), String> {
    with_peaks(&state, |s| {
        s.views.remove(&id);
        Ok(())
    })
}

macro_rules! handlers {
    ($($extra:path),*) => {
        tauri::generate_handler![
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
            editor_evaluate,
            peaks_job_begin,
            peaks_job_push,
            peaks_job_snapshot,
            peaks_job_finish,
            peaks_job_drop,
            peaks_view_open,
            peaks_view_columns,
            peaks_view_close,
            desktop::desktop_pick_media,
            desktop::desktop_file_size,
            desktop::desktop_read_range,
            desktop::desktop_projects_folder,
            desktop::desktop_choose_projects_folder,
            desktop::desktop_save_export,
            desktop::desktop_open_project,
            desktop::desktop_save_project,
            desktop::desktop_reveal,
            desktop::desktop_codecs,
            desktop::desktop_enable_h264 $(, $extra)*]
    };
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(desktop::on_window_event)
        .manage(EditorState::default())
        .manage(Mutex::new(PeaksState::default()));
    #[cfg(feature = "native-media")]
    let builder = builder.manage(native::NativeState::default()).invoke_handler(handlers![
        native::native_info,
        native::native_stash_begin,
        native::native_stash_append,
        native::native_stash_end,
        native::native_stash_remove,
        native::native_media_open,
        native::native_media_frame,
        native::native_media_audio,
        native::native_media_close,
        native::native_export_begin,
        native::native_export_video,
        native::native_export_audio,
        native::native_export_finish,
        native::native_export_cancel,
        native::native_export_read,
        native::native_export_remove
    ]);
    #[cfg(not(feature = "native-media"))]
    let builder = builder.invoke_handler(handlers![]);
    builder
        .run(tauri::generate_context!())
        .expect("error while running the application");
}
