//! Browser bindings. Keep this file thin: logic belongs in `app-core`, where it is testable natively.
//! Build with `npm run build:wasm` (output: packages/engine-client/wasm-pkg, git-ignored).

use wasm_bindgen::prelude::wasm_bindgen;

/// JSON of `app_core::EngineInfo`.
#[wasm_bindgen]
pub fn engine_info() -> String {
    app_core::engine_info_json()
}

/// An open project plus its undo history (`app_timeline::Editor`). All data crosses as JSON strings; errors become JS exceptions.
#[wasm_bindgen]
pub struct Editor(app_timeline::Editor);

#[wasm_bindgen]
impl Editor {
    /// Opens a project from its JSON; throws if it does not validate.
    #[wasm_bindgen(constructor)]
    pub fn new(project_json: &str) -> Result<Editor, String> {
        app_timeline::Editor::open(project_json).map(Editor)
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
}

/// Normalises the browser's raw probe JSON into `app_core::Capabilities` JSON (host `web`).
#[wasm_bindgen]
pub fn capabilities(probe_json: &str) -> Result<String, String> {
    app_core::capabilities_json(probe_json, "web", None)
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
    }

    #[test]
    fn capabilities_are_stamped_web() {
        let json = super::capabilities("{}").unwrap();
        assert!(json.contains("\"host\":\"web\""), "{json}");
        assert!(super::capabilities("[]").is_err());
    }
}
