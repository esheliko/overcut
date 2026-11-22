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
}

#[cfg(test)]
mod tests {
    #[test]
    fn forwards_to_core() {
        assert_eq!(super::engine_info(), app_core::engine_info_json());
    }

    #[test]
    fn editor_forwards_to_the_timeline_editor() {
        assert!(super::Editor::new("{}").is_err());
    }
}
