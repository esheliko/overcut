//! `Editor`: a project plus its history behind a JSON-string API. This is what `crates/wasm` and the Tauri shell expose,
//! so both platforms share one tested implementation and bindings stay logic-free.

use crate::history::{journal_to_jsonl, History};
use crate::op::Op;
use app_model::Project;
use serde::{Deserialize, Serialize};

/// What the UI learns after every edit (the full patch stream arrives with the timeline UI, M1-034).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EditOutcome {
    /// Counts state changes; the UI re-reads the project when it moved.
    pub revision: u64,
    pub can_undo: bool,
    pub can_redo: bool,
    /// False for an undo/redo with nothing to do.
    pub changed: bool,
}

/// One op, or a list applied atomically as one undo step.
#[derive(Deserialize)]
#[serde(untagged)]
enum OneOrMany {
    Many(Vec<Op>),
    One(Op),
}

pub struct Editor {
    project: Project,
    history: History,
    revision: u64,
}

impl Editor {
    /// Opens a project from JSON; refuses one that fails `Project::validate`.
    pub fn open(project_json: &str) -> Result<Editor, String> {
        let project: Project = serde_json::from_str(project_json).map_err(|e| e.to_string())?;
        project.validate().map_err(|e| e.to_string())?;
        Ok(Editor::from_project(project))
    }

    pub fn from_project(project: Project) -> Editor {
        Editor {
            project,
            history: History::new(),
            revision: 0,
        }
    }

    pub fn project(&self) -> &Project {
        &self.project
    }

    pub fn history(&self) -> &History {
        &self.history
    }

    fn outcome(&self, changed: bool) -> EditOutcome {
        EditOutcome {
            revision: self.revision,
            can_undo: self.history.can_undo(),
            can_redo: self.history.can_redo(),
            changed,
        }
    }

    /// Applies an op (or an array of ops as one step) given as JSON. `coalesce` merges consecutive edits sharing it into one undo step.
    pub fn apply_json(&mut self, op_json: &str, coalesce: Option<u32>) -> Result<String, String> {
        let ops = match serde_json::from_str::<OneOrMany>(op_json).map_err(|e| e.to_string())? {
            OneOrMany::One(op) => vec![op],
            OneOrMany::Many(ops) => ops,
        };
        self.history
            .apply_batch(&mut self.project, ops, coalesce.map(u64::from))
            .map_err(|e| e.to_string())?;
        self.revision += 1;
        Ok(self.outcome_json(true))
    }

    pub fn undo_json(&mut self) -> Result<String, String> {
        let changed = self
            .history
            .undo(&mut self.project)
            .map_err(|e| e.to_string())?;
        self.revision += u64::from(changed);
        Ok(self.outcome_json(changed))
    }

    pub fn redo_json(&mut self) -> Result<String, String> {
        let changed = self
            .history
            .redo(&mut self.project)
            .map_err(|e| e.to_string())?;
        self.revision += u64::from(changed);
        Ok(self.outcome_json(changed))
    }

    fn outcome_json(&self, changed: bool) -> String {
        serde_json::to_string(&self.outcome(changed)).expect("EditOutcome always serializes")
    }

    pub fn project_json(&self) -> String {
        serde_json::to_string(&self.project).expect("Project always serializes")
    }

    /// Everything applied so far as JSON Lines (for autosave; see `history::journal_to_jsonl`).
    pub fn journal_jsonl(&self) -> String {
        journal_to_jsonl(self.history.journal())
    }
}
