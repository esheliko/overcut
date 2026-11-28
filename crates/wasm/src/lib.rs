//! Browser bindings. Keep this file thin: logic belongs in `app-core`, where it is testable natively.
//! Build with `npm run build:wasm` (output: packages/engine-client/wasm-pkg, git-ignored).

mod media;
#[cfg(all(target_arch = "wasm32", feature = "render"))]
mod render;

use wasm_bindgen::prelude::wasm_bindgen;

/// JSON of `app_core::EngineInfo`.
#[wasm_bindgen]
pub fn engine_info() -> String {
    app_core::engine_info_json()
}

/// An open project plus its undo history (`app_timeline::Editor`). All data crosses as JSON strings; errors become JS exceptions.
#[wasm_bindgen]
pub struct Editor(app_timeline::Editor, Option<String>);

#[wasm_bindgen]
impl Editor {
    /// Opens a project from its JSON; throws if it does not validate.
    #[wasm_bindgen(constructor)]
    pub fn new(project_json: &str) -> Result<Editor, String> {
        app_timeline::Editor::open(project_json).map(|e| Editor(e, None))
    }

    /// Applies one op (JSON object) or several (JSON array, one undo step). Returns the `EditOutcome` JSON.
    pub fn apply(&mut self, op_json: &str, coalesce: Option<u32>) -> Result<String, String> {
        self.0.apply_json(op_json, coalesce)
    }

    pub fn undo(&mut self) -> Result<String, String> {
        self.0.undo_json()
    }

    pub fn redo(&mut self) -> Result<String, String> {
        self.0.redo_json()
    }

    pub fn project(&self) -> String {
        self.0.project_json()
    }

    pub fn journal(&self) -> String {
        self.0.journal_jsonl()
    }

    /// `FrameDescription` JSON for a sequence at `ticks` (i64: a BigInt in JS) with an audio window of `audio_samples`.
    pub fn evaluate(
        &mut self,
        sequence: &str,
        ticks: i64,
        audio_samples: u32,
    ) -> Result<String, String> {
        self.0.evaluate_json(sequence, ticks, audio_samples)
    }
    /// Snap a time or dragged span to clip edges, playhead and markers; params and answer JSON in `docs/features/snapping.md`.
    pub fn snap(&self, sequence: &str, params: &str) -> Result<String, String> {
        self.0.snap_json(sequence, params)
    }
    /// Commit-log lines (JSON Lines) produced since the last call; the host appends them to durable storage.
    pub fn take_log(&mut self) -> String {
        self.0.take_log()
    }

    /// `{"seq","project"}`: a snapshot for the periodic checkpoint.
    pub fn checkpoint(&self) -> String {
        self.0.checkpoint_json()
    }

    /// Rebuilds an editor after a crash from the session's base project, an optional checkpoint and the commit log.
    /// `recovery()` then returns the report JSON. Throws when neither the base nor the checkpoint is usable.
    pub fn recover(
        base_json: Option<String>,
        checkpoint_json: Option<String>,
        log: &str,
    ) -> Result<Editor, String> {
        let (e, report) = app_timeline::Editor::recover_json(
            base_json.as_deref(),
            checkpoint_json.as_deref(),
            log,
        )?;
        Ok(Editor(e, Some(report)))
    }

    /// The `Recovery` report JSON when this editor came from `recover`.
    pub fn recovery(&self) -> Option<String> {
        self.1.clone()
    }
}

/// Media fingerprint `b3-64k:<size>:<hash>` from the file size and its first and last 64 KiB (the whole file when smaller).
/// `size` is a JS number (exact below 2^53 bytes). Throws a `{code, message}` JSON string like the other project-file calls.
#[wasm_bindgen]
pub fn media_fingerprint(size: f64, first: &[u8], last: &[u8]) -> Result<String, String> {
    if !(size >= 0.0 && size.fract() == 0.0 && size < 9_007_199_254_740_992.0) {
        return Err(
            r#"{"code":"invalid","message":"file size must be a whole number of bytes"}"#.into(),
        );
    }
    app_model::fingerprint(size as u64, first, last).map_err(|e| e.to_json())
}

/// Normalises the browser's raw probe JSON into `app_core::Capabilities` JSON (host `web`).
#[wasm_bindgen]
pub fn capabilities(probe_json: &str) -> Result<String, String> {
    app_core::capabilities_json(probe_json, "web", None)
}

/// Pitch-keeping time stretch (`app_audio::stretch`, clip speed). `planar`: `channels` equal-length channels one after the other; the result is
/// laid out the same way with `output_len(len, num, den)` samples per channel.
#[wasm_bindgen]
pub fn stretch_audio(planar: &[f32], channels: u32, rate: u32, num: u32, den: u32) -> Vec<f32> {
    let n = channels.max(1) as usize;
    let len = planar.len() / n;
    let chans: Vec<&[f32]> = (0..n).map(|c| &planar[c * len..(c + 1) * len]).collect();
    app_audio::stretch::stretch(&chans, rate, num, den).concat()
}

/// A waveform extraction in progress (`app_audio::peaks::PeaksBuilder`). PCM goes in as interleaved i16 chunks.
#[wasm_bindgen]
pub struct PeaksJob(Option<app_audio::peaks::PeaksBuilder>);

#[wasm_bindgen]
impl PeaksJob {
    /// `resume`: bytes of a cached partial file to continue (empty = start fresh). Check `next_frame` afterwards.
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: u32, channels: u16, resume: &[u8]) -> Result<PeaksJob, String> {
        let b = if resume.is_empty() {
            app_audio::peaks::PeaksBuilder::new(sample_rate, channels)
        } else {
            app_audio::peaks::PeaksBuilder::resume(resume, channels).map_err(|e| e.to_string())?
        };
        Ok(PeaksJob(Some(b)))
    }

    /// First frame the next `push` must start at (0 unless resumed).
    pub fn next_frame(&self) -> f64 {
        self.0.as_ref().map_or(0.0, |b| b.next_frame() as f64)
    }

    pub fn push(&mut self, pcm: &[i16]) -> Result<(), String> {
        self.0.as_mut().ok_or("job finished")?.push(pcm);
        Ok(())
    }

    /// The peaks file so far (flagged incomplete); the job keeps running.
    pub fn snapshot(&self) -> Result<Vec<u8>, String> {
        Ok(self.0.as_ref().ok_or("job finished")?.snapshot().to_bytes())
    }

    /// The final peaks file (flagged complete). The job cannot be used afterwards.
    pub fn finish(&mut self) -> Result<Vec<u8>, String> {
        Ok(self.0.take().ok_or("job finished")?.finish().to_bytes())
    }
}

/// A parsed peaks file, kept in memory for drawing (the pyramid is derived once on open).
#[wasm_bindgen]
pub struct PeaksView(app_audio::peaks::Peaks);

#[wasm_bindgen]
impl PeaksView {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<PeaksView, String> {
        app_audio::peaks::Peaks::from_bytes(bytes)
            .map(PeaksView)
            .map_err(|e| e.to_string())
    }

    pub fn sample_rate(&self) -> u32 {
        self.0.sample_rate
    }

    /// Frames covered so far (f64: exact below 2^53).
    pub fn frames(&self) -> f64 {
        self.0.frames as f64
    }

    pub fn complete(&self) -> bool {
        self.0.complete
    }

    /// `count` (min, max) pairs, interleaved; min > max marks "no data yet".
    pub fn columns(&self, start_frame: f64, frames_per_px: f64, count: usize) -> Vec<i16> {
        let mut pairs = Vec::with_capacity(count);
        self.0
            .columns(start_frame, frames_per_px, count, &mut pairs);
        pairs.into_iter().flatten().collect()
    }
}

/// Opens a `.overcut` container: JSON `{project, read_only, found_version, migrated, entries}`.
/// On failure throws a JSON string `{code, message}` (see `app_model::FileError`).
#[wasm_bindgen]
pub fn project_open(bytes: &[u8]) -> Result<String, String> {
    app_model::open_json(bytes).map_err(|e| e.to_json())
}

/// Writes a `.overcut` container from project JSON. `previous` is the container that was opened (empty for a new file).
#[wasm_bindgen]
pub fn project_save(project_json: &str, previous: &[u8]) -> Result<Vec<u8>, String> {
    app_model::save_bytes(project_json, previous).map_err(|e| e.to_json())
}

#[cfg(test)]
mod tests {
    #[test]
    fn project_file_round_trips_and_errors_are_json() {
        let project = app_model::Project::new(
            &mut app_model::SeqIds::default(),
            "t",
            app_model::Rational::FPS_30,
            app_model::Resolution {
                width: 1280,
                height: 720,
            },
        );
        let json = serde_json::to_string(&project).unwrap();
        let bytes = super::project_save(&json, &[]).unwrap();
        let opened: serde_json::Value =
            serde_json::from_str(&super::project_open(&bytes).unwrap()).unwrap();
        assert_eq!(opened["project"]["name"], "t");
        let err: serde_json::Value =
            serde_json::from_str(&super::project_open(b"junk").unwrap_err()).unwrap();
        assert_eq!(err["code"], "corrupt");
    }

    #[test]
    fn forwards_to_core() {
        assert_eq!(super::engine_info(), app_core::engine_info_json());
    }

    #[test]
    fn editor_forwards_to_the_timeline_editor() {
        assert!(super::Editor::new("{}").is_err());
        assert!(super::Editor::recover(None, None, "").is_err());
        let data = [1u8; 10];
        assert!(super::media_fingerprint(10.0, &data, &data)
            .unwrap()
            .starts_with("b3-64k:10:"));
        assert!(super::media_fingerprint(-1.0, &data, &data).is_err());
    }

    #[test]
    fn capabilities_are_stamped_web() {
        let json = super::capabilities("{}").unwrap();
        assert!(json.contains("\"host\":\"web\""), "{json}");
        assert!(super::capabilities("[]").is_err());
    }
}
