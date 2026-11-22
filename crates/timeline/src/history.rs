//! `History`: undo/redo with coalescing, and the journal every state change is appended to.
//!
//! The journal records *every* op that changed the project, undo and redo included (an undo is the inverse ops, applied),
//! so `replay(base, journal) == state` holds with no special cases. Recovery therefore restores the document, not the undo stack.

use crate::apply::{apply_all, OpError};
use crate::op::{Inverse, Op};
use app_model::Project;

/// Edits with the same key, applied back to back, share one undo step (a drag is hundreds of `Move`s, one Ctrl+Z).
/// Any edit with a different key, `None`, or an undo/redo in between ends the run.
pub type CoalesceKey = u64;

#[derive(Clone, Debug)]
struct Step {
    /// What was applied, to redo it.
    forward: Vec<Op>,
    /// Applying this undoes `forward` (already ordered latest-first).
    inverse: Vec<Op>,
    key: Option<CoalesceKey>,
}

#[derive(Debug, Default)]
pub struct History {
    undo: Vec<Step>,
    redo: Vec<Step>,
    journal: Vec<Op>,
    /// Undo steps kept; the oldest is dropped beyond this. 0 = unlimited.
    limit: usize,
}

impl History {
    pub fn new() -> History {
        History::default()
    }

    /// Keep at most `limit` undo steps (0 = unlimited). The journal is never trimmed.
    pub fn with_limit(limit: usize) -> History {
        History {
            limit,
            ..History::default()
        }
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    /// Every op applied so far, in order (append-only).
    pub fn journal(&self) -> &[Op] {
        &self.journal
    }

    /// Applies `op` as one undo step (or merges it into the previous step when `key` matches). Clears redo.
    pub fn apply(
        &mut self,
        p: &mut Project,
        op: Op,
        key: Option<CoalesceKey>,
    ) -> Result<(), OpError> {
        self.apply_batch(p, vec![op], key)
    }

    /// Applies several ops as one atomic step: all or none.
    pub fn apply_batch(
        &mut self,
        p: &mut Project,
        ops: Vec<Op>,
        key: Option<CoalesceKey>,
    ) -> Result<(), OpError> {
        let Inverse(inverse) = apply_all(p, &ops)?;
        self.redo.clear();
        self.journal.extend(ops.iter().cloned());
        match self.undo.last_mut() {
            Some(last) if key.is_some() && last.key == key => {
                last.forward.extend(ops);
                last.inverse.splice(0..0, inverse);
            }
            _ => {
                self.undo.push(Step {
                    forward: ops,
                    inverse,
                    key,
                });
                if self.limit > 0 && self.undo.len() > self.limit {
                    self.undo.remove(0);
                }
            }
        }
        Ok(())
    }

    /// Undoes the latest step. `Ok(false)` when there is nothing to undo.
    pub fn undo(&mut self, p: &mut Project) -> Result<bool, OpError> {
        let Some(step) = self.undo.pop() else {
            return Ok(false);
        };
        match apply_all(p, &step.inverse) {
            Ok(_) => {
                self.journal.extend(step.inverse.iter().cloned());
                self.redo.push(Step { key: None, ..step });
                Ok(true)
            }
            Err(e) => {
                self.undo.push(step);
                Err(e)
            }
        }
    }

    /// Re-applies the latest undone step. `Ok(false)` when there is nothing to redo.
    pub fn redo(&mut self, p: &mut Project) -> Result<bool, OpError> {
        let Some(step) = self.redo.pop() else {
            return Ok(false);
        };
        match apply_all(p, &step.forward) {
            Ok(_) => {
                self.journal.extend(step.forward.iter().cloned());
                self.undo.push(step);
                Ok(true)
            }
            Err(e) => {
                self.redo.push(step);
                Err(e)
            }
        }
    }
}

/// Rebuilds the state a journal describes. Stops at the first op that does not apply (a torn tail after a crash is the caller's call).
pub fn replay(base: &Project, journal: &[Op]) -> Result<Project, (usize, OpError)> {
    let mut p = base.clone();
    for (i, op) in journal.iter().enumerate() {
        crate::apply::apply(&mut p, op.clone()).map_err(|e| (i, e))?;
    }
    Ok(p)
}

/// Journal as JSON Lines, one op per line, so autosave can append and a crash can only tear the last line.
pub fn journal_to_jsonl(journal: &[Op]) -> String {
    let mut out = String::new();
    for op in journal {
        out.push_str(&serde_json::to_string(op).expect("Op always serializes"));
        out.push('\n');
    }
    out
}

/// Parses `journal_to_jsonl` output. A final line that fails to parse (torn write) is dropped; any earlier bad line is an error.
pub fn journal_from_jsonl(text: &str) -> Result<Vec<Op>, serde_json::Error> {
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let mut ops = Vec::with_capacity(lines.len());
    for (i, line) in lines.iter().enumerate() {
        match serde_json::from_str(line) {
            Ok(op) => ops.push(op),
            Err(_) if i + 1 == lines.len() && !text.ends_with('\n') => break,
            Err(e) => return Err(e),
        }
    }
    Ok(ops)
}
