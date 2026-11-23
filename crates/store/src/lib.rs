//! # app-store
//!
//! **Owns**: the on-disk side of project persistence for native shells (`docs/features/persistence.md`): one folder per project,
//! `write_atomic` (write a temp file, flush it to disk, rename over the target, so a crash leaves the old file or the new one, never half of
//! either) and `append` (durable on return, for the commit log).
//!
//! **Does not own**: what the files mean (the engine does), the web storage (OPFS / IndexedDB live in `packages/engine-client`), or any
//! platform API: only `std::fs`. The Tauri shell (`apps/desktop/src-tauri`) exposes these as commands and holds no logic of its own.

pub mod desktop;

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// A project's folder. Names are flat file names: no separators, no `..`, no hidden files.
#[derive(Clone, Debug)]
pub struct ProjectDir {
    root: PathBuf,
}

fn check_name(name: &str) -> io::Result<()> {
    let ok = !name.is_empty()
        && name.len() <= 128
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'));
    if ok {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("not a valid project file name: {name:?}"),
        ))
    }
}

/// Flush the directory entry itself so a completed rename survives power loss (a no-op where the platform cannot open directories).
fn sync_dir(dir: &Path) {
    if let Ok(d) = File::open(dir) {
        let _ = d.sync_all();
    }
}

impl ProjectDir {
    /// Opens (creating it if needed) the folder.
    pub fn open(root: impl Into<PathBuf>) -> io::Result<ProjectDir> {
        let root = root.into();
        fs::create_dir_all(&root)?;
        Ok(ProjectDir { root })
    }

    pub fn path(&self) -> &Path {
        &self.root
    }

    fn file(&self, name: &str) -> io::Result<PathBuf> {
        check_name(name)?;
        Ok(self.root.join(name))
    }

    /// The file's bytes, or `None` when it does not exist.
    pub fn read(&self, name: &str) -> io::Result<Option<Vec<u8>>> {
        match fs::read(self.file(name)?) {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Replaces `name` with `bytes` atomically.
    pub fn write_atomic(&self, name: &str, bytes: &[u8]) -> io::Result<()> {
        self.write_atomic_limited(name, bytes, None)
    }

    /// `write_atomic`, optionally "crashing" after `crash_after` bytes of the temp file (before it is flushed or renamed). Test seam.
    fn write_atomic_limited(
        &self,
        name: &str,
        bytes: &[u8],
        crash_after: Option<usize>,
    ) -> io::Result<()> {
        let target = self.file(name)?;
        let tmp = self.root.join(format!("{name}.tmp"));
        let mut f = File::create(&tmp)?;
        if let Some(n) = crash_after {
            f.write_all(&bytes[..n.min(bytes.len())])?;
            return Err(io::Error::other("simulated crash"));
        }
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, &target)?;
        sync_dir(&self.root);
        Ok(())
    }

    /// Appends to `name` (created if missing); the bytes are on disk when this returns.
    pub fn append(&self, name: &str, bytes: &[u8]) -> io::Result<()> {
        let path = self.file(name)?;
        let created = !path.exists();
        let mut f = OpenOptions::new().create(true).append(true).open(path)?;
        f.write_all(bytes)?;
        f.sync_data()?;
        if created {
            sync_dir(&self.root);
        }
        Ok(())
    }

    /// Cuts `name` down to `size` bytes (drops a torn tail left by a crash); a missing or shorter file is left alone.
    pub fn truncate(&self, name: &str, size: u64) -> io::Result<()> {
        let path = self.file(name)?;
        let f = match OpenOptions::new().write(true).open(path) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e),
        };
        if f.metadata()?.len() > size {
            f.set_len(size)?;
            f.sync_data()?;
        }
        Ok(())
    }

    /// Deletes `name`; a missing file is not an error.
    pub fn remove(&self, name: &str) -> io::Result<()> {
        match fs::remove_file(self.file(name)?) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(tag: &str) -> ProjectDir {
        let p = std::env::temp_dir().join(format!("app-store-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        ProjectDir::open(p).unwrap()
    }

    #[test]
    fn read_write_append_remove() {
        let d = dir("basic");
        assert_eq!(d.read("a.bin").unwrap(), None);
        d.write_atomic("a.bin", b"one").unwrap();
        d.write_atomic("a.bin", b"two").unwrap();
        assert_eq!(d.read("a.bin").unwrap().unwrap(), b"two");
        d.append("j.jsonl", b"x\n").unwrap();
        d.append("j.jsonl", b"y\n").unwrap();
        assert_eq!(d.read("j.jsonl").unwrap().unwrap(), b"x\ny\n");
        d.remove("j.jsonl").unwrap();
        d.remove("j.jsonl").unwrap();
        assert_eq!(d.read("j.jsonl").unwrap(), None);
        let _ = fs::remove_dir_all(d.path());
    }

    #[test]
    fn names_cannot_escape_the_folder() {
        let d = dir("names");
        for bad in [
            "",
            "../x",
            "a/b",
            "a\\b",
            ".hidden",
            "x\0y",
            &"n".repeat(200),
        ] {
            assert!(d.read(bad).is_err(), "{bad:?}");
            assert!(d.write_atomic(bad, b"x").is_err());
        }
        let _ = fs::remove_dir_all(d.path());
    }

    /// The torn-write test: a crash at ANY point of a replace leaves the previous file whole, and the next save works.
    #[test]
    fn a_crash_mid_replace_leaves_the_last_good_file() {
        let d = dir("torn");
        let old = b"the last good project".to_vec();
        let new = vec![7u8; 4096];
        d.write_atomic("project.overcut", &old).unwrap();
        for cut in (0..=new.len()).step_by(61).chain([new.len()]) {
            assert!(d
                .write_atomic_limited("project.overcut", &new, Some(cut))
                .is_err());
            assert_eq!(
                d.read("project.overcut").unwrap().unwrap(),
                old,
                "cut {cut}"
            );
        }
        d.write_atomic("project.overcut", &new).unwrap();
        assert_eq!(d.read("project.overcut").unwrap().unwrap(), new);
        let _ = fs::remove_dir_all(d.path());
    }

    /// A crash while appending can only tear the tail of the log: everything before it is intact.
    #[test]
    fn a_torn_append_keeps_everything_before_it() {
        let d = dir("tornlog");
        d.append("journal.jsonl", b"{\"n\":1}\n").unwrap();
        d.append("journal.jsonl", b"{\"n\":2}\n{\"n\":").unwrap(); // the process died inside the third line
        let got = String::from_utf8(d.read("journal.jsonl").unwrap().unwrap()).unwrap();
        assert!(got.starts_with("{\"n\":1}\n{\"n\":2}\n"));
        d.truncate("journal.jsonl", 16).unwrap(); // cut the torn fragment
        assert_eq!(
            d.read("journal.jsonl").unwrap().unwrap(),
            b"{\"n\":1}\n{\"n\":2}\n"
        );
        d.truncate("journal.jsonl", 1000).unwrap(); // longer than the file: unchanged
        d.truncate("missing.jsonl", 0).unwrap();
        let _ = fs::remove_dir_all(d.path());
    }
}
