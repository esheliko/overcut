//! The `.overcut` file: a zip container holding a versioned `project.json` plus optional extra entries
//! (thumbnails, waveform peaks, a journal). Bytes in, bytes out: no I/O (hosts own storage). See `docs/features/project-file.md`.
//!
//! Guarantees: unknown JSON fields and unknown zip entries survive a read/write round trip; a file written by a newer
//! app opens read-only and is never rewritten; older files are migrated by a chain of pure `vN -> vN+1` functions;
//! corrupt or hostile input is an `Err`, never a panic.

use crate::project::{ModelError, Project, SCHEMA_VERSION};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt;
use std::io::{Cursor, Read, Write};

/// Name of the required entry holding the document.
pub const PROJECT_ENTRY: &str = "project.json";
/// Size of the head and tail windows hashed by [`fingerprint`].
pub const FINGERPRINT_WINDOW: usize = 64 * 1024;
const MAX_PROJECT_JSON: u64 = 64 * 1024 * 1024;
const MAX_ENTRY: u64 = 64 * 1024 * 1024;
const MAX_TOTAL: u64 = 256 * 1024 * 1024;
const MAX_ENTRIES: usize = 4096;

/// Why a file could not be read or written. `code()` is stable and crosses the JS boundary.
#[derive(Debug)]
pub enum FileError {
    /// Not a zip, truncated, or a damaged entry.
    Corrupt(String),
    /// A zip without `project.json`.
    MissingProject,
    /// `project.json` is not valid JSON of the expected shape (or the migrated document breaks an invariant).
    BadProject(String),
    /// The file's schema is newer than this app understands and it cannot even be displayed.
    NewerVersion { found: u32, supported: u32 },
    /// Tried to save a project that was opened read-only.
    ReadOnly { found: u32, supported: u32 },
    /// Size or entry-count limits exceeded (zip bomb guard) or an unsafe entry name.
    Limits(String),
    /// Bad argument from the host (e.g. wrong fingerprint window length).
    Invalid(String),
}

impl FileError {
    pub fn code(&self) -> &'static str {
        match self {
            FileError::Corrupt(_) => "corrupt",
            FileError::MissingProject => "missing_project",
            FileError::BadProject(_) => "bad_project",
            FileError::NewerVersion { .. } => "newer_version",
            FileError::ReadOnly { .. } => "read_only",
            FileError::Limits(_) => "limits",
            FileError::Invalid(_) => "invalid",
        }
    }

    /// `{"code": ..., "message": ...}` for the bindings.
    pub fn to_json(&self) -> String {
        serde_json::json!({ "code": self.code(), "message": self.to_string() }).to_string()
    }
}

impl fmt::Display for FileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FileError::Corrupt(m) => write!(f, "the file is damaged or not an .overcut project: {m}"),
            FileError::MissingProject => write!(f, "the file has no project.json"),
            FileError::BadProject(m) => write!(f, "the project data is invalid: {m}"),
            FileError::NewerVersion { found, supported } => write!(
                f,
                "this project was made by a newer version of OverCut (format {found}, this app supports up to {supported}); update the app to open it"
            ),
            FileError::ReadOnly { found, supported } => write!(
                f,
                "this project is read-only: it uses format {found} but this app supports up to {supported}; saving would lose data"
            ),
            FileError::Limits(m) => write!(f, "the file exceeds a safety limit: {m}"),
            FileError::Invalid(m) => write!(f, "invalid argument: {m}"),
        }
    }
}

impl std::error::Error for FileError {}

impl From<ModelError> for FileError {
    fn from(e: ModelError) -> Self {
        FileError::BadProject(e.to_string())
    }
}

/// One migration step: rewrites a document of schema `N` into schema `N+1` (and sets `schema_version`).
pub type Migration = fn(Value) -> Result<Value, FileError>;

/// `MIGRATIONS[n - 1]` upgrades version `n` to `n + 1`. Its length must be `SCHEMA_VERSION - 1` (tested).
/// A format change = bump `SCHEMA_VERSION`, append one function here, and check in `fixtures/project.v<new>.json`
/// (keep every older fixture: the tests migrate each of them to current).
pub const MIGRATIONS: &[Migration] = &[v1_to_v2, v2_to_v3, v3_to_v4, v4_to_v5];

/// 1 -> 2 (M2-002): tracks gained `hidden`, `solo`, `height` and `colour`, all optional with the M1 behaviour as default, so the
/// document needs no rewriting beyond the version. Bumping the version keeps older apps from opening (and flattening) files that use them.
fn v1_to_v2(mut doc: Value) -> Result<Value, FileError> {
    doc["schema_version"] = Value::from(2);
    Ok(doc)
}

/// 2 -> 3 (M2-003): clips gained `transform` (identity when absent, not written when identity), so only the version changes; older apps
/// must not open and flatten a file whose clips carry one.
fn v2_to_v3(mut doc: Value) -> Result<Value, FileError> {
    doc["schema_version"] = Value::from(3);
    Ok(doc)
}

/// 3 -> 4 (M2-007): sequences gained `markers`, `range` and `loop_range`, all optional (none / none / false when absent, not written
/// when empty), so only the version changes; older apps must not open and flatten a file that carries them.
fn v3_to_v4(mut doc: Value) -> Result<Value, FileError> {
    doc["schema_version"] = Value::from(4);
    Ok(doc)
}

/// 4 -> 5 (M2 TL-19): sequences gained `background` (black when absent, not written when black), so only the version changes; older
/// apps must not open and flatten a file that carries one.
fn v4_to_v5(mut doc: Value) -> Result<Value, FileError> {
    doc["schema_version"] = Value::from(5);
    Ok(doc)
}

fn schema_version_of(doc: &Value) -> Option<u32> {
    doc.get("schema_version")?
        .as_u64()
        .and_then(|v| u32::try_from(v).ok())
}

/// Runs the chain from `from` to `SCHEMA_VERSION` over `chain` (a parameter so the machinery is testable).
pub(crate) fn migrate_with(
    chain: &[Migration],
    target: u32,
    mut doc: Value,
    from: u32,
) -> Result<Value, FileError> {
    let mut v = from;
    while v < target {
        let step = chain
            .get((v - 1) as usize)
            .ok_or_else(|| FileError::BadProject(format!("no migration from format {v}")))?;
        doc = step(doc)?;
        v += 1;
        if schema_version_of(&doc) != Some(v) {
            return Err(FileError::BadProject(format!(
                "migration to format {v} did not set schema_version"
            )));
        }
    }
    Ok(doc)
}

/// An opened `.overcut` file: the typed project plus everything needed to write it back without loss.
#[derive(Debug, Clone)]
pub struct ProjectFile {
    project: Project,
    /// The document as read (after migration), kept so unknown fields can be merged back on write.
    raw: Value,
    /// Extra zip entries (thumbnails, peaks, journal, unknown future entries), in name order.
    entries: BTreeMap<String, Vec<u8>>,
    found_version: u32,
    read_only: bool,
}

impl ProjectFile {
    /// A new, empty file around a fresh project.
    pub fn new(project: Project) -> ProjectFile {
        let raw = serde_json::to_value(&project).unwrap_or(Value::Null);
        ProjectFile {
            found_version: project.schema_version,
            project,
            raw,
            entries: BTreeMap::new(),
            read_only: false,
        }
    }

    pub fn project(&self) -> &Project {
        &self.project
    }
    /// The project for editing; refused when the file was opened read-only.
    pub fn project_mut(&mut self) -> Result<&mut Project, FileError> {
        self.check_writable()?;
        Ok(&mut self.project)
    }
    pub fn read_only(&self) -> bool {
        self.read_only
    }
    /// The schema version found on disk (before migration).
    pub fn found_version(&self) -> u32 {
        self.found_version
    }
    pub fn migrated(&self) -> bool {
        self.found_version < SCHEMA_VERSION
    }
    pub fn entries(&self) -> &BTreeMap<String, Vec<u8>> {
        &self.entries
    }
    /// Adds or replaces an extra entry (e.g. `thumbnails/<id>.jpg`, `peaks/<id>.bin`).
    pub fn set_entry(&mut self, name: &str, bytes: Vec<u8>) -> Result<(), FileError> {
        self.check_writable()?;
        check_entry_name(name)?;
        if name == PROJECT_ENTRY {
            return Err(FileError::Invalid("project.json is reserved".into()));
        }
        self.entries.insert(name.to_string(), bytes);
        Ok(())
    }
    pub fn remove_entry(&mut self, name: &str) -> Result<(), FileError> {
        self.check_writable()?;
        self.entries.remove(name);
        Ok(())
    }

    fn check_writable(&self) -> Result<(), FileError> {
        if self.read_only {
            Err(FileError::ReadOnly {
                found: self.found_version,
                supported: SCHEMA_VERSION,
            })
        } else {
            Ok(())
        }
    }

    /// Reads a container. Never panics on any input.
    pub fn read(bytes: &[u8]) -> Result<ProjectFile, FileError> {
        let (json, entries) = unzip(bytes)?;
        Self::from_parts(&json, entries, MIGRATIONS, SCHEMA_VERSION)
    }

    pub(crate) fn from_parts(
        json: &[u8],
        entries: BTreeMap<String, Vec<u8>>,
        chain: &[Migration],
        target: u32,
    ) -> Result<ProjectFile, FileError> {
        let doc: Value =
            serde_json::from_slice(json).map_err(|e| FileError::BadProject(e.to_string()))?;
        let found = schema_version_of(&doc)
            .filter(|v| *v >= 1)
            .ok_or_else(|| FileError::BadProject("missing or invalid schema_version".into()))?;
        if found > target {
            // Newer than we know: show it if it still parses as our shape, never allow writing it back.
            let project: Project =
                serde_json::from_value(doc.clone()).map_err(|_| FileError::NewerVersion {
                    found,
                    supported: target,
                })?;
            return Ok(ProjectFile {
                project,
                raw: doc,
                entries,
                found_version: found,
                read_only: true,
            });
        }
        let doc = migrate_with(chain, target, doc, found)?;
        let project: Project = serde_json::from_value(doc.clone())
            .map_err(|e| FileError::BadProject(e.to_string()))?;
        project.validate()?;
        Ok(ProjectFile {
            project,
            raw: doc,
            entries,
            found_version: found,
            read_only: false,
        })
    }

    /// Writes the container (deterministic: sorted entries, fixed timestamps). Refused when read-only.
    pub fn write(&self) -> Result<Vec<u8>, FileError> {
        self.check_writable()?;
        self.project.validate()?;
        let new = serde_json::to_value(&self.project)
            .map_err(|e| FileError::BadProject(e.to_string()))?;
        let merged = merge_preserving(&self.raw, &new);
        let mut json =
            serde_json::to_vec_pretty(&merged).map_err(|e| FileError::BadProject(e.to_string()))?;
        json.push(b'\n');
        zip_up(&json, &self.entries)
    }
}

/// Overlays `new` (the typed document) on `old` (what was read): every key the model knows is taken from `new`,
/// every key only `old` has (a newer field) is kept. Arrays of objects with an `id` are matched by id, so reordering,
/// inserting or deleting elements never moves unknown data onto the wrong element.
pub(crate) fn merge_preserving(old: &Value, new: &Value) -> Value {
    match (old, new) {
        (Value::Object(o), Value::Object(n)) => {
            let mut out = o.clone();
            for (k, nv) in n {
                let merged = match o.get(k) {
                    Some(ov) => merge_preserving(ov, nv),
                    None => nv.clone(),
                };
                out.insert(k.clone(), merged);
            }
            Value::Object(out)
        }
        (Value::Array(o), Value::Array(n)) => {
            let by_id: BTreeMap<&str, &Value> = o
                .iter()
                .filter_map(|e| Some((e.get("id")?.as_str()?, e)))
                .collect();
            Value::Array(
                n.iter()
                    .map(|ne| {
                        match ne
                            .get("id")
                            .and_then(Value::as_str)
                            .and_then(|id| by_id.get(id))
                        {
                            Some(oe) => merge_preserving(oe, ne),
                            None => ne.clone(),
                        }
                    })
                    .collect(),
            )
        }
        _ => new.clone(),
    }
}

fn check_entry_name(name: &str) -> Result<(), FileError> {
    let bad = name.is_empty()
        || name.len() > 512
        || name.starts_with('/')
        || name.contains('\\')
        || name.contains('\0')
        || name
            .split('/')
            .any(|p| p == ".." || p == "." || p.is_empty());
    if bad {
        Err(FileError::Limits(format!("unsafe entry name {name:?}")))
    } else {
        Ok(())
    }
}

type Entries = BTreeMap<String, Vec<u8>>;

fn unzip(bytes: &[u8]) -> Result<(Vec<u8>, Entries), FileError> {
    let corrupt = |e: &dyn fmt::Display| FileError::Corrupt(e.to_string());
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| corrupt(&e))?;
    if zip.len() > MAX_ENTRIES {
        return Err(FileError::Limits(format!(
            "more than {MAX_ENTRIES} entries"
        )));
    }
    let mut project = None;
    let mut entries = BTreeMap::new();
    let mut total = 0u64;
    for i in 0..zip.len() {
        let file = zip.by_index(i).map_err(|e| corrupt(&e))?;
        if file.is_dir() {
            continue;
        }
        let name = file.name().to_string();
        check_entry_name(&name)?;
        let cap = if name == PROJECT_ENTRY {
            MAX_PROJECT_JSON
        } else {
            MAX_ENTRY
        };
        let mut buf = Vec::new();
        // `take(cap + 1)` bounds memory regardless of the declared size.
        file.take(cap + 1)
            .read_to_end(&mut buf)
            .map_err(|e| corrupt(&e))?;
        if buf.len() as u64 > cap {
            return Err(FileError::Limits(format!(
                "entry {name} is larger than {cap} bytes"
            )));
        }
        total += buf.len() as u64;
        if total > MAX_TOTAL {
            return Err(FileError::Limits(
                "file expands to more than 256 MiB".into(),
            ));
        }
        if name == PROJECT_ENTRY {
            project = Some(buf);
        } else {
            entries.insert(name, buf);
        }
    }
    Ok((project.ok_or(FileError::MissingProject)?, entries))
}

fn zip_up(json: &[u8], entries: &BTreeMap<String, Vec<u8>>) -> Result<Vec<u8>, FileError> {
    let err = |e: &dyn fmt::Display| FileError::Corrupt(e.to_string());
    let mut out = Cursor::new(Vec::new());
    let mut w = zip::ZipWriter::new(&mut out);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    w.start_file(PROJECT_ENTRY, opts).map_err(|e| err(&e))?;
    w.write_all(json).map_err(|e| err(&e))?;
    for (name, data) in entries {
        // Thumbnails and peaks are already compact; storing keeps them seekable and cheap.
        let o = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        w.start_file(name.as_str(), o).map_err(|e| err(&e))?;
        w.write_all(data).map_err(|e| err(&e))?;
    }
    w.finish().map_err(|e| err(&e))?;
    Ok(out.into_inner())
}

/// Content fingerprint used to relink moved media: size plus a BLAKE3 hash of the first and last
/// [`FINGERPRINT_WINDOW`] bytes (all of the file when it is smaller). Format: `b3-64k:<size>:<hex>`.
/// `first` and `last` must be exactly `min(size, 64 KiB)` bytes long.
pub fn fingerprint(size: u64, first: &[u8], last: &[u8]) -> Result<String, FileError> {
    let want = size.min(FINGERPRINT_WINDOW as u64) as usize;
    if first.len() != want || last.len() != want {
        return Err(FileError::Invalid(format!(
            "fingerprint windows must be {want} bytes for a {size}-byte file"
        )));
    }
    let mut h = blake3::Hasher::new();
    h.update(&size.to_le_bytes());
    h.update(first);
    h.update(last);
    Ok(format!("b3-64k:{size}:{}", h.finalize().to_hex()))
}

/// The size recorded in a fingerprint, for a cheap "is this the same file" pre-check before hashing.
pub fn fingerprint_size(fp: &str) -> Option<u64> {
    let mut it = fp.split(':');
    (it.next()? == "b3-64k").then_some(())?;
    it.next()?.parse().ok()
}

/// JSON for the bindings: `{project, read_only, found_version, migrated, entries}`. See `docs/features/project-file.md`.
pub fn open_json(bytes: &[u8]) -> Result<String, FileError> {
    let f = ProjectFile::read(bytes)?;
    let v = serde_json::json!({
        "project": f.project,
        "read_only": f.read_only,
        "found_version": f.found_version,
        "migrated": f.migrated(),
        "entries": f.entries.keys().collect::<Vec<_>>(),
    });
    Ok(v.to_string())
}

/// Writes `project_json` as a container. `previous` is the container the host opened (or empty for a new file):
/// its unknown fields and extra entries are carried over, and a read-only previous file refuses the save.
pub fn save_bytes(project_json: &str, previous: &[u8]) -> Result<Vec<u8>, FileError> {
    let project: Project =
        serde_json::from_str(project_json).map_err(|e| FileError::BadProject(e.to_string()))?;
    let mut f = if previous.is_empty() {
        ProjectFile::new(project.clone())
    } else {
        ProjectFile::read(previous)?
    };
    *f.project_mut()? = project;
    f.write()
}

#[cfg(test)]
mod tests;
