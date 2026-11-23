//! Disk-side helpers of the desktop shell (M1-041, `docs/features/desktop.md`): where projects live, which dropped files are media, copying a
//! finished export to where the person chose, and the command that shows a file in the OS file manager. Pure `std`, so Linux CI tests them
//! without a webview; the Tauri commands in `apps/desktop/src-tauri` only forward to these.

use crate::ProjectDir;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

/// File name (inside the app data folder) that remembers the folder the person chose for projects.
pub const ROOT_FILE: &str = "projects-folder.txt";

fn invalid(msg: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, msg.into())
}

/// The folder projects are kept in: the person's choice if one was saved and still exists, else `<app_data>/projects`.
pub fn projects_root(app_data: &Path) -> PathBuf {
    if let Ok(text) = fs::read_to_string(app_data.join(ROOT_FILE)) {
        let p = PathBuf::from(text.trim());
        if !text.trim().is_empty() && p.is_absolute() && p.is_dir() {
            return p;
        }
    }
    app_data.join("projects")
}

/// Remembers `folder` (created if missing) as the projects folder. Fails, changing nothing, if it cannot be written to.
pub fn set_projects_root(app_data: &Path, folder: &Path) -> io::Result<()> {
    if !folder.is_absolute() {
        return Err(invalid("the projects folder must be an absolute path"));
    }
    fs::create_dir_all(folder)?;
    let probe = folder.join(".overcut-write-test");
    fs::write(&probe, b"")?;
    let _ = fs::remove_file(&probe);
    fs::create_dir_all(app_data)?;
    ProjectDir::open(app_data)?.write_atomic(ROOT_FILE, folder.to_string_lossy().as_bytes())
}

/// A project's folder under the projects root. `project` is a flat name (letters, digits, `-`, `_`).
pub fn project_dir(app_data: &Path, project: &str) -> io::Result<ProjectDir> {
    let ok = !project.is_empty()
        && project.len() <= 64
        && project
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !ok {
        return Err(invalid("invalid project name"));
    }
    ProjectDir::open(projects_root(app_data).join(project))
}

/// Extensions the import dialog and drag-and-drop accept (the decoder says the last word; this only keeps folders and documents out).
pub const MEDIA_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "mov", "mkv", "webm", "avi", "mpg", "mpeg", "ts", "mts", "m2ts", "3gp", "wmv",
    "flv", "ogv", "mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus", "aif", "aiff", "png",
    "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "avif",
];

/// Keeps the files (not folders) whose extension is a media type, in order.
pub fn media_paths(paths: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    paths
        .into_iter()
        .filter(|p| {
            p.is_file()
                && p.extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| MEDIA_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        })
        .collect()
}

/// Reads up to `len` bytes of `path` at `offset` (the webview fingerprints and sniffs a file without loading it).
pub fn read_range(path: &Path, offset: u64, len: usize) -> io::Result<Vec<u8>> {
    use std::io::{Seek, SeekFrom};
    let mut f = fs::File::open(path)?;
    f.seek(SeekFrom::Start(offset))?;
    let mut buf = Vec::with_capacity(len.min(1 << 24));
    f.take(len as u64).read_to_end(&mut buf)?;
    Ok(buf)
}

/// Size in bytes of a regular file.
pub fn file_size(path: &Path) -> io::Result<u64> {
    let m = fs::metadata(path)?;
    if m.is_file() {
        Ok(m.len())
    } else {
        Err(invalid("not a file"))
    }
}

/// Copies a finished export to the place the person chose in the Save dialog: written to `<dest>.part`, flushed, then renamed over `dest`, so a
/// full disk or a crash never leaves a half file under the real name. Returns the bytes written.
pub fn deliver_export(src: &Path, dest: &Path) -> io::Result<u64> {
    let ext = dest
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    if !matches!(ext.as_deref(), Some("mp4" | "webm")) {
        return Err(invalid("an export is saved as .mp4 or .webm"));
    }
    if dest.parent().is_none_or(|p| !p.is_dir()) {
        return Err(invalid("the folder to save in does not exist"));
    }
    let mut part = dest.as_os_str().to_owned();
    part.push(".part");
    let part = PathBuf::from(part);
    let result = (|| {
        let mut input = fs::File::open(src)?;
        let mut out = fs::File::create(&part)?;
        let n = io::copy(&mut input, &mut out)?;
        out.flush()?;
        out.sync_all()?;
        fs::rename(&part, dest)?;
        Ok(n)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&part);
    }
    result
}

/// The program and arguments that show `path` selected in the OS file manager. `os` is `std::env::consts::OS`. Linux has no "select" verb
/// common to all file managers, so it opens the containing folder.
pub fn reveal_command(os: &str, path: &Path) -> (String, Vec<String>) {
    let p = path.to_string_lossy().into_owned();
    match os {
        "macos" => ("open".into(), vec!["-R".into(), p]),
        "windows" => ("explorer".into(), vec![format!("/select,{p}")]),
        _ => {
            let dir = path.parent().unwrap_or(path).to_string_lossy().into_owned();
            ("xdg-open".into(), vec![dir])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("overcut-desktop-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn projects_default_to_app_data_until_a_folder_is_chosen() {
        let app = tmp("root");
        assert_eq!(projects_root(&app), app.join("projects"));
        let chosen = app.join("My Videos");
        set_projects_root(&app, &chosen).unwrap();
        assert_eq!(projects_root(&app), chosen);
        let p = project_dir(&app, "demo-1").unwrap();
        p.write_atomic("project.json", b"{}").unwrap();
        assert!(chosen.join("demo-1").join("project.json").is_file());
        // The chosen folder vanishing (drive unplugged) falls back instead of failing the app.
        fs::remove_dir_all(&chosen).unwrap();
        assert_eq!(projects_root(&app), app.join("projects"));
        assert!(set_projects_root(&app, Path::new("relative/dir")).is_err());
        assert!(project_dir(&app, "../evil").is_err());
        assert!(project_dir(&app, "").is_err());
    }

    #[test]
    fn autosave_survives_a_restart_in_the_chosen_folder() {
        let app = tmp("restart");
        let chosen = app.join("projects-elsewhere");
        set_projects_root(&app, &chosen).unwrap();
        let first = project_dir(&app, "p").unwrap();
        first.write_atomic("project.json", b"base").unwrap();
        first.append("journal.jsonl", b"{\"n\":1}\n").unwrap();
        first.append("journal.jsonl", b"{\"n\":2}\n").unwrap();
        drop(first);
        // A new run of the app: same folder, same files.
        let again = project_dir(&app, "p").unwrap();
        assert_eq!(again.read("project.json").unwrap().unwrap(), b"base");
        assert_eq!(
            again.read("journal.jsonl").unwrap().unwrap(),
            b"{\"n\":1}\n{\"n\":2}\n"
        );
        assert_eq!(again.read("nope").unwrap(), None);
    }

    #[test]
    fn only_media_files_are_taken_from_a_drop() {
        let d = tmp("drop");
        for n in ["a.MP4", "b.wav", "c.txt", "d.mkv"] {
            fs::write(d.join(n), b"x").unwrap();
        }
        fs::create_dir(d.join("folder.mp4")).unwrap();
        let got = media_paths(
            [
                "a.MP4",
                "b.wav",
                "c.txt",
                "folder.mp4",
                "missing.mp4",
                "d.mkv",
            ]
            .map(|n| d.join(n)),
        );
        let names: Vec<_> = got
            .iter()
            .map(|p| p.file_name().unwrap().to_str().unwrap().to_string())
            .collect();
        assert_eq!(names, ["a.MP4", "b.wav", "d.mkv"]);
    }

    #[test]
    fn range_reads_stop_at_the_end_of_the_file() {
        let d = tmp("range");
        let f = d.join("x.mp4");
        fs::write(&f, b"0123456789").unwrap();
        assert_eq!(file_size(&f).unwrap(), 10);
        assert_eq!(read_range(&f, 2, 3).unwrap(), b"234");
        assert_eq!(read_range(&f, 8, 100).unwrap(), b"89");
        assert_eq!(read_range(&f, 50, 4).unwrap(), b"");
        assert!(file_size(&d).is_err());
    }

    #[test]
    fn export_is_delivered_whole_or_not_at_all() {
        let d = tmp("deliver");
        let src = d.join("job.mp4");
        fs::write(&src, vec![7u8; 100_000]).unwrap();
        let dest = d.join("OverCut export.mp4");
        assert_eq!(deliver_export(&src, &dest).unwrap(), 100_000);
        assert_eq!(fs::read(&dest).unwrap().len(), 100_000);
        assert!(!d.join("OverCut export.mp4.part").exists());
        // Wrong type, missing folder, missing source: refused, and nothing is left behind.
        assert!(deliver_export(&src, &d.join("x.exe")).is_err());
        assert!(deliver_export(&src, &d.join("nofolder").join("x.mp4")).is_err());
        assert!(deliver_export(&d.join("gone.mp4"), &d.join("y.mp4")).is_err());
        assert!(!d.join("y.mp4").exists() && !d.join("y.mp4.part").exists());
    }

    #[test]
    fn show_in_folder_uses_each_systems_own_verb() {
        let p = Path::new("/home/me/Videos/out.mp4");
        assert_eq!(
            reveal_command("macos", p),
            (
                "open".into(),
                vec!["-R".into(), "/home/me/Videos/out.mp4".into()]
            )
        );
        assert_eq!(
            reveal_command("linux", p),
            ("xdg-open".into(), vec!["/home/me/Videos".into()])
        );
        let (prog, args) = reveal_command("windows", Path::new(r"C:\Videos\out.mp4"));
        assert_eq!(
            (prog.as_str(), args),
            ("explorer", vec![r"/select,C:\Videos\out.mp4".to_string()])
        );
    }
}
