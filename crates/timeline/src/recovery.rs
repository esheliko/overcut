//! Commit log and crash recovery (M1-040, `docs/features/persistence.md`).
//!
//! Every successful edit, undo and redo appends one JSON line to the editor's log: `{"n":1,"r":"apply","ops":[..],"key":7}`,
//! `{"n":2,"r":"undo"}`, `{"n":3,"r":"redo"}`. `n` counts from 1 and must be gapless. The host appends the lines to durable storage
//! after each edit. Because undo and redo are records too, replaying the log through `History` rebuilds the **undo stack as well as the
//! document**: after recovery, undo reaches back to the start of the crashed session.
//!
//! A crash can only tear the last line, so recovery keeps the longest valid prefix: the first line that is unparsable, out of sequence
//! or does not apply ends the replay, and the rest is reported as dropped, never guessed at.

use crate::editor::Editor;
use crate::history::History;
use crate::op::Op;
use app_model::Project;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "r", rename_all = "snake_case")]
pub(crate) enum Record {
    Apply { ops: Vec<Op>, key: Option<u64> },
    Undo,
    Redo,
}

#[derive(Serialize, Deserialize)]
struct Line {
    n: u64,
    #[serde(flatten)]
    rec: Record,
}

impl Record {
    pub(crate) fn to_line(&self, n: u64) -> String {
        let mut s = serde_json::to_string(&Line {
            n,
            rec: self.clone(),
        })
        .expect("a record always serializes");
        s.push('\n');
        s
    }
}

/// What `Editor::recover` did.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Recovery {
    /// Records applied from the log (the editor's `seq` afterwards).
    pub replayed: u64,
    /// Non-empty log lines that were not applied (torn tail, corruption, a record that no longer applies).
    pub dropped: u64,
    /// The undo history reaches back to the start of the session (false when a checkpoint had to stand in for a base that could not be replayed).
    pub full_history: bool,
    /// The text of the valid prefix of the log, to write back so the next crash recovers from a clean file.
    pub valid_log: String,
}

/// Parses the longest valid prefix. Returns the records and the number of non-empty lines left over.
fn parse_log(text: &str) -> (Vec<Record>, u64) {
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let mut out = Vec::with_capacity(lines.len());
    for (i, l) in lines.iter().enumerate() {
        match serde_json::from_str::<Line>(l) {
            Ok(line) if line.n == out.len() as u64 + 1 => out.push(line.rec),
            _ => return (out, (lines.len() - i) as u64),
        }
    }
    (out, 0)
}

/// Applies `records` to `ed` in order. Returns how many applied.
fn replay(ed: &mut Editor, records: &[Record]) -> usize {
    for (i, r) in records.iter().enumerate() {
        let ok = {
            let (p, h) = ed.parts_mut();
            match r {
                Record::Apply { ops, key } => h.apply_batch(p, ops.clone(), *key).is_ok(),
                Record::Undo => matches!(h.undo(p), Ok(true)),
                Record::Redo => matches!(h.redo(p), Ok(true)),
            }
        };
        if !ok {
            return i;
        }
        let next = ed.seq() + 1;
        let rev = ed.revision_hint() + 1;
        ed.set_progress(next, rev);
    }
    records.len()
}

fn open_project(json: &str) -> Result<Project, String> {
    let p: Project = serde_json::from_str(json).map_err(|e| e.to_string())?;
    p.validate().map_err(|e| e.to_string())?;
    Ok(p)
}

impl Editor {
    /// Rebuilds an editor after a crash.
    ///
    /// * `base_json`: the project as it was when the session began (the last clean save); the log is relative to it.
    /// * `checkpoint_json`: optional `Editor::checkpoint_json` output (a state after record `seq`).
    /// * `log`: the commit log, possibly torn.
    ///
    /// Replays the whole log over the base (full undo history). Only when that cannot reach the checkpoint (damaged log, unusable base)
    /// is the checkpoint used instead, with the log after it, so undo then reaches back to the checkpoint only (`full_history: false`).
    pub fn recover(
        base_json: Option<&str>,
        checkpoint_json: Option<&str>,
        log: &str,
    ) -> Result<(Editor, Recovery), String> {
        let (records, dropped_in_parse) = parse_log(log);
        let checkpoint = match checkpoint_json {
            Some(c) => {
                #[derive(Deserialize)]
                struct Cp {
                    seq: u64,
                    project: Project,
                }
                serde_json::from_str::<Cp>(c)
                    .ok()
                    .filter(|c| c.project.validate().is_ok())
            }
            None => None,
        };
        let mut best: Option<(Editor, usize, bool)> = None;
        if let Some(base) = base_json.and_then(|b| open_project(b).ok()) {
            let mut ed = Editor::from_project(base);
            let n = replay(&mut ed, &records);
            best = Some((ed, n, true));
        }
        if let Some(cp) = checkpoint {
            let reach = best.as_ref().map_or(0, |b| b.1 as u64);
            if cp.seq > reach && cp.seq <= records.len() as u64 {
                let mut ed = Editor::from_parts(cp.project, History::new(), cp.seq, cp.seq);
                let n = cp.seq as usize + replay(&mut ed, &records[cp.seq as usize..]);
                best = Some((ed, n, false));
            }
        }
        let (mut ed, n, full_history) = best.ok_or("no usable base project or checkpoint")?;
        ed.rebase_shadow();
        let valid_log: String = records
            .iter()
            .take(n)
            .enumerate()
            .map(|(i, r)| r.to_line(i as u64 + 1))
            .collect();
        let rec = Recovery {
            replayed: n as u64,
            dropped: dropped_in_parse + (records.len() - n) as u64,
            full_history,
            valid_log,
        };
        Ok((ed, rec))
    }

    /// `recover` over JSON strings, returning `(editor, Recovery JSON)`.
    pub fn recover_json(
        base_json: Option<&str>,
        checkpoint_json: Option<&str>,
        log: &str,
    ) -> Result<(Editor, String), String> {
        let (ed, rec) = Editor::recover(base_json, checkpoint_json, log)?;
        Ok((ed, serde_json::to_string(&rec).map_err(|e| e.to_string())?))
    }
}
