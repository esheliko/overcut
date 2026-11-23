//! Desktop-only commands (M1-041): native dialogs, OS drag-and-drop, the projects folder, saving an export, "Show in folder", codec status.
//! Thin on purpose: the disk logic is `app_store::desktop` (tested on Linux CI); these only own the dialogs and the events.

use app_store::desktop as disk;
use std::path::PathBuf;
use tauri::ipc::Response;
use tauri::{DragDropEvent, Emitter, Manager, WindowEvent};
use tauri_plugin_dialog::DialogExt;

pub fn app_data(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// Where finished exports wait until the person saves them (shared with the `native-media` commands).
pub fn exports_dir(app: &tauri::AppHandle) -> PathBuf {
    app_data(app)
        .unwrap_or_else(|_| std::env::temp_dir().join("overcut"))
        .join("exports")
}

fn paths_json(paths: Vec<PathBuf>) -> Vec<String> {
    paths
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())
}

/// The system "open files" dialog. Returns the chosen media paths (empty when cancelled).
#[tauri::command]
pub async fn desktop_pick_media(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    blocking(move || {
        let picked = app
            .dialog()
            .file()
            .add_filter("Video, audio and images", disk::MEDIA_EXTENSIONS)
            .blocking_pick_files()
            .unwrap_or_default();
        let paths = picked
            .into_iter()
            .filter_map(|p| p.into_path().ok())
            .collect::<Vec<_>>();
        paths_json(disk::media_paths(paths))
    })
    .await
}

/// `{ "size": bytes }` of a picked file.
#[tauri::command]
pub fn desktop_file_size(path: String) -> Result<f64, String> {
    disk::file_size(std::path::Path::new(&path))
        .map(|n| n as f64)
        .map_err(|e| e.to_string())
}

/// `len` bytes at `offset` (raw binary response): the webview fingerprints a file from its two ends without reading the middle.
#[tauri::command]
pub fn desktop_read_range(path: String, offset: f64, len: u32) -> Result<Response, String> {
    if !(offset >= 0.0 && offset.fract() == 0.0) {
        return Err("offset must be a whole number of bytes".into());
    }
    disk::read_range(std::path::Path::new(&path), offset as u64, len as usize)
        .map(Response::new)
        .map_err(|e| e.to_string())
}

/// The folder projects are saved in.
#[tauri::command]
pub fn desktop_projects_folder(app: tauri::AppHandle) -> Result<String, String> {
    Ok(disk::projects_root(&app_data(&app)?)
        .to_string_lossy()
        .into_owned())
}

/// Lets the person choose the projects folder. Returns the new folder, or `null` when cancelled.
#[tauri::command]
pub async fn desktop_choose_projects_folder(
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    blocking(move || -> Result<Option<String>, String> {
        let Some(dir) = app
            .dialog()
            .file()
            .blocking_pick_folder()
            .and_then(|p| p.into_path().ok())
        else {
            return Ok(None);
        };
        disk::set_projects_root(&app_data(&app)?, &dir).map_err(|e| e.to_string())?;
        Ok(Some(dir.to_string_lossy().into_owned()))
    })
    .await?
}

/// The system Save dialog for a finished export (`file_name` is the engine's file in the exports folder, `suggested` the name to offer).
/// Writes straight to the chosen place and returns its path, or `null` when cancelled.
#[tauri::command]
pub async fn desktop_save_export(
    app: tauri::AppHandle,
    file_name: String,
    suggested: String,
) -> Result<Option<String>, String> {
    if file_name.contains(['/', '\\']) || suggested.contains(['/', '\\']) {
        return Err("invalid file name".into());
    }
    let src = exports_dir(&app).join(&file_name);
    blocking(move || -> Result<Option<String>, String> {
        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("mp4")
            .to_string();
        let Some(dest) = app
            .dialog()
            .file()
            .set_file_name(&suggested)
            .add_filter("Video", &[ext.as_str()])
            .blocking_save_file()
            .and_then(|p| p.into_path().ok())
        else {
            return Ok(None);
        };
        disk::deliver_export(&src, &dest).map_err(|e| e.to_string())?;
        Ok(Some(dest.to_string_lossy().into_owned()))
    })
    .await?
}

/// The system "Open project" dialog (`.overcut`). Returns `[name, bytes]`, or `null` when cancelled. Bytes cross IPC as a JSON array, like `project_open`.
#[tauri::command]
pub async fn desktop_open_project(app: tauri::AppHandle) -> Result<Option<(String, Vec<u8>)>, String> {
    blocking(move || -> Result<Option<(String, Vec<u8>)>, String> {
        let Some(path) = app
            .dialog()
            .file()
            .add_filter("OverCut project", &["overcut"])
            .blocking_pick_file()
            .and_then(|p| p.into_path().ok())
        else {
            return Ok(None);
        };
        let bytes = disk::read_project_file(&path).map_err(|e| e.to_string())?;
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        Ok(Some((name, bytes)))
    })
    .await?
}

/// The system "Save project as" dialog (`suggested` is the file name to offer). Writes the whole file or nothing; returns its path, or `null` when cancelled.
#[tauri::command]
pub async fn desktop_save_project(
    app: tauri::AppHandle,
    bytes: Vec<u8>,
    suggested: String,
) -> Result<Option<String>, String> {
    if suggested.contains(['/', '\\']) {
        return Err("invalid file name".into());
    }
    blocking(move || -> Result<Option<String>, String> {
        let Some(dest) = app
            .dialog()
            .file()
            .set_file_name(&suggested)
            .add_filter("OverCut project", &["overcut"])
            .blocking_save_file()
            .and_then(|p| p.into_path().ok())
        else {
            return Ok(None);
        };
        disk::write_project_file(&dest, &bytes).map_err(|e| e.to_string())?;
        Ok(Some(dest.to_string_lossy().into_owned()))
    })
    .await?
}

/// Shows a file in the system file manager (selected where the system can).
#[tauri::command]
pub fn desktop_reveal(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err("that file no longer exists".into());
    }
    let (program, args) = disk::reveal_command(std::env::consts::OS, &p);
    // Explorer reports a non-zero status even when it opened fine, so only a failure to start counts.
    std::process::Command::new(program)
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// What the desktop can encode: `{ "h264": "hardware"|"software"|"none", "webm": bool, "canEnableH264": bool }`.
/// Hardware = an OS / GPU encoder opens; software = the Cisco OpenH264 library is present; WebM and the opt-in OpenH264 download are not built yet.
#[tauri::command]
pub fn desktop_codecs() -> String {
    #[cfg(feature = "native-media")]
    let h264 = {
        let _ = app_native_media::init();
        let hardware = app_native_media::H264_PREFERENCE
            .iter()
            .copied()
            .filter(|n| *n != "libopenh264")
            .any(app_native_media::encoder_available);
        if hardware {
            "hardware"
        } else if app_native_media::encoder_available("libopenh264") {
            "software"
        } else {
            "none"
        }
    };
    #[cfg(not(feature = "native-media"))]
    let h264 = "none";
    format!(r#"{{"h264":"{h264}","webm":false,"canEnableH264":false}}"#)
}

/// The opt-in OpenH264 download (ADR 0004, `docs/features/privacy-network.md`). Not built yet: refuses, downloads nothing.
#[tauri::command]
pub fn desktop_enable_h264() -> Result<(), String> {
    Err(r#"{"code":"not_yet","message":"The OpenH264 download is not available in this build yet."}"#.into())
}

/// Forwards OS file drops onto the window to the page as `overcut://drop` (media paths only) and hover state as `overcut://drag` (bool).
pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    let WindowEvent::DragDrop(drag) = event else {
        return;
    };
    match drag {
        DragDropEvent::Enter { .. } => {
            let _ = window.emit("overcut://drag", true);
        }
        DragDropEvent::Leave => {
            let _ = window.emit("overcut://drag", false);
        }
        DragDropEvent::Drop { paths, .. } => {
            let _ = window.emit("overcut://drag", false);
            let media = paths_json(disk::media_paths(paths.iter().cloned()));
            if !media.is_empty() {
                let _ = window.emit("overcut://drop", media);
            }
        }
        _ => {}
    }
}
