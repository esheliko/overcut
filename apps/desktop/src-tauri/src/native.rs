//! Native media commands (S4 / M1-015): libav decode and H.264 + AAC encode, behind the `native-media` feature.
//! Thin on purpose: all logic lives in `app-native-media` (tested there); these only own ids, files and binary IPC.
//! Pixels and PCM cross as raw binary bodies / responses (never JSON): `[w u32 LE][h u32 LE][RGBA]` for a frame, f32 LE for audio.

use app_native_media::{ExportParams, NativeExport, NativeMedia};
use serde::Deserialize;
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Manager, State};

type Shared<T> = Arc<Mutex<T>>;

#[derive(Default)]
pub struct NativeState {
    next: Mutex<u32>,
    media: Mutex<HashMap<u32, Shared<NativeMedia>>>,
    stashes: Mutex<HashMap<u32, (PathBuf, std::fs::File)>>,
    exports: Mutex<HashMap<u32, Shared<Option<NativeExport>>>>,
}

impl NativeState {
    fn id(&self) -> u32 {
        let mut n = self.next.lock().unwrap_or_else(|e| e.into_inner());
        *n += 1;
        *n
    }
}

fn lock<T>(m: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, String> {
    m.lock().map_err(|_| "native state poisoned".to_string())
}

fn raw(request: &Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        InvokeBody::Raw(b) => Ok(b.clone()),
        InvokeBody::Json(_) => Err("expected a binary body".into()),
    }
}

fn header_u32(request: &Request<'_>, name: &str) -> Result<u32, String> {
    request.headers().get(name).and_then(|v| v.to_str().ok()).and_then(|s| s.parse().ok()).ok_or_else(|| format!("missing header {name}"))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

fn work_dir(app: &tauri::AppHandle, sub: &str) -> PathBuf {
    let base = app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("overcut"));
    base.join(sub)
}

/// Licence and capability report: what libav is linked, which H.264 encoders it has (the UI shows "hardware" only when one opens).
#[tauri::command]
pub fn native_info() -> String {
    let _ = app_native_media::init();
    let enc: Vec<&str> = app_native_media::H264_PREFERENCE.iter().copied().filter(|n| app_native_media::encoder_available(n)).collect();
    serde_json::json!({"license": app_native_media::libav_license(), "lgpl": app_native_media::libav_is_lgpl(), "h264Encoders": enc}).to_string()
}

// ---- files picked in the webview without a path: staged in a temp file, chunk by chunk ----

#[tauri::command]
pub fn native_stash_begin(app: tauri::AppHandle, state: State<'_, NativeState>) -> Result<String, String> {
    let dir = std::env::temp_dir().join("overcut-media");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let _ = &app;
    let id = state.id();
    let path = dir.join(format!("{}-{id}.bin", std::process::id()));
    let f = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    lock(&state.stashes)?.insert(id, (path.clone(), f));
    Ok(serde_json::json!({"id": id, "path": path}).to_string())
}

#[tauri::command]
pub fn native_stash_append(request: Request<'_>, state: State<'_, NativeState>) -> Result<(), String> {
    let id = header_u32(&request, "x-id")?;
    let body = raw(&request)?;
    let mut s = lock(&state.stashes)?;
    let (_, f) = s.get_mut(&id).ok_or("unknown stash")?;
    f.write_all(&body).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn native_stash_end(id: u32, state: State<'_, NativeState>) -> Result<(), String> {
    if let Some((_, f)) = lock(&state.stashes)?.get_mut(&id) {
        f.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn native_stash_remove(id: u32, state: State<'_, NativeState>) -> Result<(), String> {
    if let Some((p, _)) = lock(&state.stashes)?.remove(&id) {
        let _ = std::fs::remove_file(p);
    }
    Ok(())
}

// ---- decode ----

#[tauri::command]
pub async fn native_media_open(path: String, audio_rate: u32, state: State<'_, NativeState>) -> Result<String, String> {
    let m = blocking(move || NativeMedia::open(std::path::Path::new(&path), audio_rate).map_err(|e| e.to_string())).await?;
    let id = state.id();
    let out = serde_json::json!({"id": id, "info": serde_json::from_str::<serde_json::Value>(m.info_json()).map_err(|e| e.to_string())?, "pts": m.pts_ticks()});
    lock(&state.media)?.insert(id, Arc::new(Mutex::new(m)));
    Ok(out.to_string())
}

fn media_of(state: &State<'_, NativeState>, id: u32) -> Result<Shared<NativeMedia>, String> {
    lock(&state.media)?.get(&id).cloned().ok_or_else(|| "media is closed".to_string())
}

#[tauri::command]
pub async fn native_media_frame(id: u32, index: i64, state: State<'_, NativeState>) -> Result<Response, String> {
    let m = media_of(&state, id)?;
    let out = blocking(move || {
        let (w, h, px) = lock(&m)?.video_frame(index).map_err(|e| e.to_string())?;
        let mut out = Vec::with_capacity(8 + px.len());
        out.extend_from_slice(&w.to_le_bytes());
        out.extend_from_slice(&h.to_le_bytes());
        out.extend_from_slice(&px);
        Ok(out)
    })
    .await?;
    Ok(Response::new(out))
}

#[tauri::command]
pub async fn native_media_audio(id: u32, start: i64, count: u32, state: State<'_, NativeState>) -> Result<Response, String> {
    let m = media_of(&state, id)?;
    let pcm = blocking(move || lock(&m)?.audio(start, count as usize).map_err(|e| e.to_string())).await?;
    Ok(Response::new(pcm.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>()))
}

#[tauri::command]
pub fn native_media_close(id: u32, state: State<'_, NativeState>) -> Result<(), String> {
    lock(&state.media)?.remove(&id);
    Ok(())
}

// ---- encode ----

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginArgs {
    file_name: String,
    width: u32,
    height: u32,
    fps_num: u32,
    fps_den: u32,
    video_bitrate: u32,
    keyframe_seconds: f64,
    audio_rate: u32,
    audio_channels: u16,
    audio_bitrate: u32,
    has_audio: bool,
    prefer_software: bool,
    creation_time: Option<i64>,
}

#[tauri::command]
pub async fn native_export_begin(args: BeginArgs, app: tauri::AppHandle, state: State<'_, NativeState>) -> Result<String, String> {
    if args.file_name.contains(['/', '\\']) || !args.file_name.ends_with(".mp4") {
        return Err("invalid export file name".into());
    }
    let dir = work_dir(&app, "exports");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&args.file_name);
    let p = ExportParams {
        path: path.clone(),
        width: args.width,
        height: args.height,
        fps_num: args.fps_num,
        fps_den: args.fps_den,
        video_bitrate: args.video_bitrate,
        keyframe_seconds: args.keyframe_seconds,
        audio_rate: args.audio_rate,
        audio_channels: args.audio_channels,
        audio_bitrate: args.audio_bitrate,
        has_audio: args.has_audio,
        prefer_software: args.prefer_software,
        creation_time: args.creation_time,
    };
    let e = blocking(move || NativeExport::begin(p)).await?;
    let id = state.id();
    let encoder = e.video_encoder().to_string();
    lock(&state.exports)?.insert(id, Arc::new(Mutex::new(Some(e))));
    Ok(serde_json::json!({"id": id, "path": path, "encoder": encoder}).to_string())
}

fn export_of(state: &State<'_, NativeState>, id: u32) -> Result<Shared<Option<NativeExport>>, String> {
    lock(&state.exports)?.get(&id).cloned().ok_or_else(|| "unknown export".to_string())
}

#[tauri::command]
pub async fn native_export_video(request: Request<'_>, state: State<'_, NativeState>) -> Result<(), String> {
    let e = export_of(&state, header_u32(&request, "x-id")?)?;
    let body = raw(&request)?;
    blocking(move || lock(&e)?.as_mut().ok_or("export is finished")?.push_video(&body)).await
}

#[tauri::command]
pub async fn native_export_audio(request: Request<'_>, state: State<'_, NativeState>) -> Result<(), String> {
    let e = export_of(&state, header_u32(&request, "x-id")?)?;
    let body = raw(&request)?;
    let pcm: Vec<f32> = body.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    blocking(move || lock(&e)?.as_mut().ok_or("export is finished")?.push_audio(&pcm)).await
}

#[tauri::command]
pub async fn native_export_finish(id: u32, state: State<'_, NativeState>) -> Result<String, String> {
    let e = export_of(&state, id)?;
    let st = blocking(move || lock(&e)?.take().ok_or("export is finished")?.finish()).await?;
    lock(&state.exports)?.remove(&id);
    Ok(serde_json::json!({"frames": st.frames, "videoEncoder": st.video_encoder, "audioSamples": st.audio_samples, "fileBytes": st.file_bytes, "encodeMs": st.encode_ms}).to_string())
}

/// Stops the encoders and deletes the partial file. Safe to call twice.
#[tauri::command]
pub async fn native_export_cancel(id: u32, state: State<'_, NativeState>) -> Result<(), String> {
    let Some(e) = lock(&state.exports)?.remove(&id) else { return Ok(()) };
    blocking(move || {
        if let Some(enc) = lock(&e)?.take() {
            enc.abort();
        }
        Ok(())
    })
    .await
}

/// `len` bytes of a finished export at `offset` (the UI assembles a `File` or hands the path to a save dialog). Only files in the exports folder.
#[tauri::command]
pub fn native_export_read(file_name: String, offset: u64, len: u32, app: tauri::AppHandle) -> Result<Response, String> {
    use std::io::{Read, Seek, SeekFrom};
    if file_name.contains(['/', '\\']) {
        return Err("invalid export file name".into());
    }
    let mut f = std::fs::File::open(work_dir(&app, "exports").join(file_name)).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; len as usize];
    let n = f.read(&mut buf).map_err(|e| e.to_string())?;
    buf.truncate(n);
    Ok(Response::new(buf))
}

#[tauri::command]
pub fn native_export_remove(file_name: String, app: tauri::AppHandle) -> Result<(), String> {
    if file_name.contains(['/', '\\']) {
        return Err("invalid export file name".into());
    }
    let _ = std::fs::remove_file(work_dir(&app, "exports").join(file_name));
    Ok(())
}
