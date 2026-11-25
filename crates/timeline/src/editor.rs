//! `Editor`: a project plus its history behind a JSON-string API. This is what `crates/wasm` and the Tauri shell expose,
//! so both platforms share one tested implementation and bindings stay logic-free.

use crate::evaluate::{evaluate_into, FrameDescription};
use crate::history::{journal_to_jsonl, History};
use crate::op::Op;
use crate::recovery::Record;
use app_model::{Id, Project, Time};
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
    /// Reused by every `evaluate_json` call so the hot path does not allocate.
    frame: FrameDescription,
    /// Commit records applied so far (the sequence number of the latest record). See `recovery`.
    seq: u64,
    /// Records not yet handed to the host by `take_log`.
    pending: String,
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
            frame: FrameDescription::default(),
            seq: 0,
            pending: String::new(),
        }
    }

    /// Appends the commit record for a change that just succeeded.
    fn record(&mut self, r: Record) {
        self.seq += 1;
        self.pending.push_str(&r.to_line(self.seq));
    }

    /// Sequence number of the latest commit record (0 for a freshly opened project).
    pub fn seq(&self) -> u64 {
        self.seq
    }

    /// The commit records produced since the last call, as JSON Lines (empty when nothing changed). The host appends them
    /// to durable storage after every edit; `Editor::recover` replays them (`docs/features/persistence.md`).
    pub fn take_log(&mut self) -> String {
        std::mem::take(&mut self.pending)
    }

    /// `{"seq": n, "project": {...}}`: a snapshot of the state after record `n`, for the periodic checkpoint.
    pub fn checkpoint_json(&self) -> String {
        format!(
            r#"{{"seq":{},"project":{}}}"#,
            self.seq,
            self.project_json()
        )
    }

    pub(crate) fn from_parts(
        project: Project,
        history: History,
        seq: u64,
        revision: u64,
    ) -> Editor {
        Editor {
            project,
            history,
            revision,
            seq,
            pending: String::new(),
            frame: FrameDescription::default(),
        }
    }

    pub(crate) fn parts_mut(&mut self) -> (&mut Project, &mut History) {
        (&mut self.project, &mut self.history)
    }

    pub(crate) fn revision_hint(&self) -> u64 {
        self.revision
    }

    pub(crate) fn set_progress(&mut self, seq: u64, revision: u64) {
        self.seq = seq;
        self.revision = revision;
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
        let key = coalesce.map(u64::from);
        self.history
            .apply_batch(&mut self.project, ops.clone(), key)
            .map_err(|e| e.to_string())?;
        self.revision += 1;
        self.record(Record::Apply { ops, key });
        Ok(self.outcome_json(true))
    }

    pub fn undo_json(&mut self) -> Result<String, String> {
        let changed = self
            .history
            .undo(&mut self.project)
            .map_err(|e| e.to_string())?;
        self.revision += u64::from(changed);
        if changed {
            self.record(Record::Undo);
        }
        Ok(self.outcome_json(changed))
    }

    pub fn redo_json(&mut self) -> Result<String, String> {
        let changed = self
            .history
            .redo(&mut self.project)
            .map_err(|e| e.to_string())?;
        self.revision += u64::from(changed);
        if changed {
            self.record(Record::Redo);
        }
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

    /// `evaluate` for the sequence with this id (32 hex chars) at `ticks`, plus an audio window of `audio_samples`; returns the `FrameDescription` JSON.
    pub fn evaluate_json(
        &mut self,
        sequence: &str,
        ticks: i64,
        audio_samples: u32,
    ) -> Result<String, String> {
        let id = Id::parse(sequence).ok_or("sequence id is not 32 hex characters")?;
        let seq = self
            .project
            .sequences
            .iter()
            .find(|s| s.id.0 == id)
            .ok_or("unknown sequence")?;
        evaluate_into(seq, Time::from_ticks(ticks), audio_samples, &mut self.frame);
        serde_json::to_string(&self.frame).map_err(|e| e.to_string())
    }

    /// Snap a time (or a dragged span) to the sequence's clip edges, the playhead and markers (`docs/features/snapping.md`).
    /// `params`: `{"t":ticks,"tolerance":ticks,"playhead":ticks|null,"exclude":[clip ids],"markers":[ticks],"span":len ticks|null}`;
    /// with `span` the answer's `time` is the new START of a span of that length. Returns `{"time":ticks,"delta":ticks,"hit":{"time","kind"}|null}`.
    pub fn snap_json(&self, sequence: &str, params: &str) -> Result<String, String> {
        #[derive(Deserialize)]
        struct Params {
            t: Time,
            tolerance: Time,
            #[serde(default)]
            playhead: Option<Time>,
            #[serde(default)]
            exclude: Vec<app_model::ClipId>,
            #[serde(default)]
            markers: Vec<Time>,
            #[serde(default)]
            span: Option<Time>,
        }
        let q: Params = serde_json::from_str(params).map_err(|e| e.to_string())?;
        let id = Id::parse(sequence).ok_or("sequence id is not 32 hex characters")?;
        let seq = self
            .project
            .sequences
            .iter()
            .find(|s| s.id.0 == id)
            .ok_or("unknown sequence")?;
        let targets = crate::snap::targets_of(seq, &q.exclude, q.playhead, &q.markers);
        let r = match q.span {
            Some(len) => crate::snap::snap_span(q.t, len, &targets, q.tolerance),
            None => crate::snap::snap(q.t, &targets, q.tolerance),
        };
        let delta = r.time.ticks().saturating_sub(q.t.ticks());
        serde_json::to_string(&serde_json::json!({"time": r.time, "delta": delta, "hit": r.hit}))
            .map_err(|e| e.to_string())
    }
}
