//! The opt-in Cisco OpenH264 download (issue #57, ADR 0004 "Shipping plan" item 4, `docs/features/privacy-network.md`).
//!
//! Cisco's patent cover applies only to *their* binary, fetched unmodified from their host. So OverCut never bundles or builds openh264: when a
//! computer has no hardware H.264 encoder and the person **clicks** "Enable MP4", this module downloads Cisco's file for the OS / CPU, checks its
//! SHA-256 against a pin compiled into the app, unpacks it once into the app data folder and loads it so libav's `libopenh264` encoder can open.
//!
//! Nothing here runs on its own: [`download`] is only called by the `desktop_enable_h264` command. Loading an already stored copy at start-up
//! ([`preload_installed`]) makes no network call. The network is behind the [`Fetcher`] trait so the failure paths are tested offline.
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// One Cisco release file for one OS / CPU. `sha256` is the digest of the **downloaded `.bz2`** as Cisco publishes it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pin {
    /// `std::env::consts::OS` (`linux`, `macos`, `windows`).
    pub os: &'static str,
    /// `std::env::consts::ARCH` (`x86_64`, `aarch64`, `x86`).
    pub arch: &'static str,
    /// Cisco release, e.g. `2.4.1`. The folder under the app data dir, so a new pin never reuses an old file.
    pub version: &'static str,
    /// File name on the host (`libopenh264-2.4.1-linux64.7.so.bz2`).
    pub remote: &'static str,
    /// Name of the library once unpacked (`libopenh264-2.4.1-linux64.7.so`).
    pub library: &'static str,
    /// Lower-case hex SHA-256 of the `.bz2`. An empty string means "not pinned yet": the downloader refuses (fails closed), see [`pin_for`].
    pub sha256: &'static str,
}

/// Cisco's download host (exact name; the only network host the desktop app may contact, and only after a click).
pub const HOST: &str = "ciscobinary.openh264.org";

/// The releases we can download. **The digests are deliberately empty**: they must be copied from Cisco's release page by someone who can reach it
/// (the CI sandbox this was written in cannot), and a made-up digest would defeat the point. While a pin is empty [`pin_for`] returns `None` for that
/// platform, `desktop_codecs` reports `canEnableH264: false` and the export dialog never shows the button. Filling these in (and the matching
/// `libopenh264` soname of the shipped libav build) turns the feature on; see the follow-up issue linked from `docs/features/desktop.md`.
pub const PINS: &[Pin] = &[
    Pin {
        os: "linux",
        arch: "x86_64",
        version: "2.4.1",
        remote: "libopenh264-2.4.1-linux64.7.so.bz2",
        library: "libopenh264-2.4.1-linux64.7.so",
        sha256: "",
    },
    Pin {
        os: "linux",
        arch: "aarch64",
        version: "2.4.1",
        remote: "libopenh264-2.4.1-linux-arm64.7.so.bz2",
        library: "libopenh264-2.4.1-linux-arm64.7.so",
        sha256: "",
    },
    Pin {
        os: "macos",
        arch: "x86_64",
        version: "2.4.1",
        remote: "libopenh264-2.4.1-osx64.7.dylib.bz2",
        library: "libopenh264-2.4.1-osx64.7.dylib",
        sha256: "",
    },
    Pin {
        os: "macos",
        arch: "aarch64",
        version: "2.4.1",
        remote: "libopenh264-2.4.1-osx-arm64.7.dylib.bz2",
        library: "libopenh264-2.4.1-osx-arm64.7.dylib",
        sha256: "",
    },
    Pin {
        os: "windows",
        arch: "x86_64",
        version: "2.4.1",
        remote: "openh264-2.4.1-win64.dll.bz2",
        library: "openh264-2.4.1-win64.dll",
        sha256: "",
    },
    Pin {
        os: "windows",
        arch: "x86",
        version: "2.4.1",
        remote: "openh264-2.4.1-win32.dll.bz2",
        library: "openh264-2.4.1-win32.dll",
        sha256: "",
    },
];

/// A pin usable on this platform: present in the table **and** carrying a digest.
pub fn pin_for(os: &str, arch: &str) -> Option<Pin> {
    pin_in(PINS, os, arch)
}

fn pin_in(pins: &[Pin], os: &str, arch: &str) -> Option<Pin> {
    pins.iter()
        .copied()
        .find(|p| p.os == os && p.arch == arch && is_hex_sha256(p.sha256))
}

pub fn current_pin() -> Option<Pin> {
    pin_for(std::env::consts::OS, std::env::consts::ARCH)
}

fn is_hex_sha256(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Why a download did not produce a library. `code()` is what the UI switches on; `message()` is for a human.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    /// No pinned release for this OS / CPU.
    Unsupported,
    /// The network call failed (no connection, DNS, TLS, timeout).
    Offline(String),
    /// The server answered with an HTTP error status.
    Http(u16),
    /// The digest of what arrived is not the pinned one. Nothing was stored.
    Checksum {
        expected: String,
        actual: String,
    },
    Cancelled,
    /// Disk, decompression or load failure.
    Io(String),
}

impl Failure {
    pub fn code(&self) -> &'static str {
        match self {
            Failure::Unsupported => "unsupported",
            Failure::Offline(_) | Failure::Http(_) => "offline",
            Failure::Checksum { .. } => "checksum",
            Failure::Cancelled => "cancelled",
            Failure::Io(_) => "io",
        }
    }
    pub fn message(&self) -> String {
        match self {
            Failure::Unsupported => {
                "MP4 export through the Cisco codec is not available for this computer.".into()
            }
            Failure::Offline(e) => format!("Could not reach the Cisco download server: {e}"),
            Failure::Http(s) => format!("The Cisco download server answered with an error ({s})."),
            Failure::Checksum { .. } => {
                "The downloaded codec did not match the expected checksum, so it was discarded."
                    .into()
            }
            Failure::Cancelled => "The download was cancelled.".into(),
            Failure::Io(e) => format!("Could not store the codec: {e}"),
        }
    }
    /// `{"code": ..., "message": ...}`, the shape the UI parses.
    pub fn to_json(&self) -> String {
        serde_json::json!({"code": self.code(), "message": self.message()}).to_string()
    }
}

/// Where the network is touched. The real implementation is [`HttpFetcher`]; tests pass bytes or an error.
pub trait Fetcher {
    /// Streams the body of `url` into `chunk` (return `false` to stop: the download was cancelled). Calls `total` once with the length if known.
    fn fetch(
        &self,
        url: &str,
        total: &mut dyn FnMut(Option<u64>),
        chunk: &mut dyn FnMut(&[u8]) -> bool,
    ) -> Result<(), Failure>;
}

/// Blocking HTTPS through `ureq` (rustls). No cookies, no redirects to other hosts, a connect timeout and a stall timeout.
pub struct HttpFetcher;

impl Fetcher for HttpFetcher {
    fn fetch(
        &self,
        url: &str,
        total: &mut dyn FnMut(Option<u64>),
        chunk: &mut dyn FnMut(&[u8]) -> bool,
    ) -> Result<(), Failure> {
        let agent = ureq::AgentBuilder::new()
            .redirects(0)
            .timeout_connect(std::time::Duration::from_secs(15))
            .timeout_read(std::time::Duration::from_secs(20))
            .user_agent("OverCut")
            .build();
        let resp = match agent.get(url).call() {
            Ok(r) => r,
            Err(ureq::Error::Status(code, _)) => return Err(Failure::Http(code)),
            Err(e) => return Err(Failure::Offline(e.to_string())),
        };
        total(resp.header("content-length").and_then(|v| v.parse().ok()));
        let mut body = resp.into_reader();
        let mut buf = [0u8; 16 * 1024];
        loop {
            let n = body
                .read(&mut buf)
                .map_err(|e| Failure::Offline(e.to_string()))?;
            if n == 0 {
                return Ok(());
            }
            if !chunk(&buf[..n]) {
                return Ok(());
            }
        }
    }
}

/// The download is about 1 MB; anything near this is not Cisco's file.
const MAX_DOWNLOAD: usize = 16 * 1024 * 1024;
/// A decompression bomb guard: the real library is a few MB.
const MAX_UNPACKED: u64 = 64 * 1024 * 1024;

/// Lower-case hex SHA-256.
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `Ok` only when `data` hashes to `expected` (hex, case-insensitive).
pub fn verify_sha256(data: &[u8], expected: &str) -> Result<(), Failure> {
    let actual = sha256_hex(data);
    if actual.eq_ignore_ascii_case(expected.trim()) {
        Ok(())
    } else {
        Err(Failure::Checksum {
            expected: expected.to_ascii_lowercase(),
            actual,
        })
    }
}

/// `<app data>/openh264/<version>/`.
pub fn store_dir(app_data: &Path, pin: &Pin) -> PathBuf {
    app_data.join("openh264").join(pin.version)
}

/// Where the unpacked library lives (or will live). The name comes from the pin table, never from the server, so no path can escape the folder.
pub fn library_path(app_data: &Path, pin: &Pin) -> PathBuf {
    store_dir(app_data, pin).join(pin.library)
}

pub fn is_installed(app_data: &Path, pin: &Pin) -> bool {
    library_path(app_data, pin).is_file()
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Progress {
    pub done: u64,
    pub total: Option<u64>,
}

/// Downloads, verifies, unpacks and stores the library for `pin`; returns its path. Every failure leaves nothing behind (the file appears by a
/// final rename). `cancel` is checked between network chunks. A copy that is already stored is returned without touching the network.
pub fn download(
    app_data: &Path,
    pin: &Pin,
    fetcher: &dyn Fetcher,
    cancel: &AtomicBool,
    mut progress: impl FnMut(Progress),
) -> Result<PathBuf, Failure> {
    if !is_hex_sha256(pin.sha256) {
        return Err(Failure::Unsupported);
    }
    let target = library_path(app_data, pin);
    if target.is_file() {
        return Ok(target);
    }
    let url = format!("https://{HOST}/{}", pin.remote);
    let mut data: Vec<u8> = Vec::new();
    let total = std::cell::Cell::new(None);
    let mut too_big = false;
    fetcher.fetch(&url, &mut |t| total.set(t), &mut |c| {
        if cancel.load(Ordering::Relaxed) {
            return false;
        }
        data.extend_from_slice(c);
        if data.len() > MAX_DOWNLOAD {
            too_big = true;
            return false;
        }
        progress(Progress {
            done: data.len() as u64,
            total: total.get(),
        });
        true
    })?;
    if cancel.load(Ordering::Relaxed) {
        return Err(Failure::Cancelled);
    }
    if too_big {
        return Err(Failure::Checksum {
            expected: pin.sha256.into(),
            actual: "too large".into(),
        });
    }
    verify_sha256(&data, pin.sha256)?;
    let mut unpacked = Vec::new();
    bzip2::read::BzDecoder::new(&data[..])
        .take(MAX_UNPACKED)
        .read_to_end(&mut unpacked)
        .map_err(|e| Failure::Io(format!("unpacking: {e}")))?;
    if unpacked.is_empty() {
        return Err(Failure::Io("the unpacked file is empty".into()));
    }
    let dir = store_dir(app_data, pin);
    std::fs::create_dir_all(&dir).map_err(|e| Failure::Io(e.to_string()))?;
    let part = dir.join(format!("{}.part", pin.library));
    let write = std::fs::write(&part, &unpacked).and_then(|_| std::fs::rename(&part, &target));
    if let Err(e) = write {
        let _ = std::fs::remove_file(&part);
        return Err(Failure::Io(e.to_string()));
    }
    Ok(target)
}

/// Loads the library into this process (and keeps it loaded) so libav's `libopenh264` encoder resolves it: an already loaded library satisfies a
/// later request for the same name on every OS. Call before the first encoder is opened; idempotent.
pub fn activate(path: &Path) -> Result<(), Failure> {
    use std::sync::Mutex;
    static LOADED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
    let mut loaded = LOADED.lock().unwrap_or_else(|e| e.into_inner());
    if loaded.iter().any(|p| p == path) {
        return Ok(());
    }
    // SAFETY: loading Cisco's library runs its initialisers, as any dynamic library does; it is the hash-verified file we stored ourselves.
    let lib =
        unsafe { open_global(path) }.map_err(|e| Failure::Io(format!("loading the codec: {e}")))?;
    std::mem::forget(lib); // stays loaded for the life of the process
    loaded.push(path.to_path_buf());
    Ok(())
}

#[cfg(unix)]
unsafe fn open_global(path: &Path) -> Result<libloading::Library, libloading::Error> {
    use libloading::os::unix::{Library, RTLD_GLOBAL, RTLD_NOW};
    Library::open(Some(path), RTLD_NOW | RTLD_GLOBAL).map(Into::into)
}

#[cfg(not(unix))]
unsafe fn open_global(path: &Path) -> Result<libloading::Library, libloading::Error> {
    libloading::Library::new(path)
}

/// At start-up: if the library was downloaded earlier, load it. No network, nothing happens when it is absent. Returns whether it is loaded.
pub fn preload_installed(app_data: &Path) -> bool {
    current_pin()
        .filter(|p| is_installed(app_data, p))
        .map(|p| activate(&library_path(app_data, &p)).is_ok())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::AtomicBool;

    struct Bytes(Vec<u8>);
    impl Fetcher for Bytes {
        fn fetch(
            &self,
            _: &str,
            total: &mut dyn FnMut(Option<u64>),
            chunk: &mut dyn FnMut(&[u8]) -> bool,
        ) -> Result<(), Failure> {
            total(Some(self.0.len() as u64));
            for c in self.0.chunks(7) {
                if !chunk(c) {
                    break;
                }
            }
            Ok(())
        }
    }
    struct Down;
    impl Fetcher for Down {
        fn fetch(
            &self,
            _: &str,
            _: &mut dyn FnMut(Option<u64>),
            _: &mut dyn FnMut(&[u8]) -> bool,
        ) -> Result<(), Failure> {
            Err(Failure::Offline("dns error".into()))
        }
    }

    fn bz2(data: &[u8]) -> Vec<u8> {
        let mut e = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::fast());
        e.write_all(data).unwrap();
        e.finish().unwrap()
    }
    fn pin_of(archive: &[u8]) -> Pin {
        // Leaked on purpose: a `Pin` holds `&'static str`s and these live for the test process.
        let sha: &'static str = Box::leak(sha256_hex(archive).into_boxed_str());
        Pin {
            os: "linux",
            arch: "x86_64",
            version: "9.9.9",
            remote: "lib.so.bz2",
            library: "lib.so",
            sha256: sha,
        }
    }

    #[test]
    fn sha256_known_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert!(verify_sha256(
            b"abc",
            "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD"
        )
        .is_ok());
        assert!(matches!(
            verify_sha256(
                b"abd",
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
            ),
            Err(Failure::Checksum { .. })
        ));
    }

    #[test]
    fn unpinned_platforms_are_refused_and_never_offered() {
        // The shipped table has no digests yet: nothing is offered and the downloader fails closed.
        assert!(PINS
            .iter()
            .all(|p| p.sha256.is_empty() || is_hex_sha256(p.sha256)));
        let d = tempfile::tempdir().unwrap();
        let unpinned = Pin {
            sha256: "",
            ..PINS[0]
        };
        assert_eq!(pin_in(&[unpinned], unpinned.os, unpinned.arch), None);
        let err = download(
            d.path(),
            &unpinned,
            &Bytes(vec![1]),
            &AtomicBool::new(false),
            |_| (),
        )
        .unwrap_err();
        assert_eq!(err, Failure::Unsupported);
        assert!(!d.path().join("openh264").exists());
    }

    #[test]
    fn pin_lookup_matches_os_and_arch() {
        let archive = bz2(b"x");
        let p = pin_of(&archive);
        assert_eq!(pin_in(&[p], "linux", "x86_64"), Some(p));
        assert_eq!(pin_in(&[p], "linux", "aarch64"), None);
        assert_eq!(pin_in(&[p], "windows", "x86_64"), None);
    }

    #[test]
    fn good_download_is_verified_unpacked_and_stored_once() {
        let lib = b"\x7fELF fake library bytes".repeat(50);
        let archive = bz2(&lib);
        let pin = pin_of(&archive);
        let dir = tempfile::tempdir().unwrap();
        let mut last = None;
        let path = download(
            dir.path(),
            &pin,
            &Bytes(archive.clone()),
            &AtomicBool::new(false),
            |p| last = Some(p),
        )
        .unwrap();
        assert_eq!(path, library_path(dir.path(), &pin));
        assert_eq!(std::fs::read(&path).unwrap(), lib);
        assert_eq!(last.unwrap().done, archive.len() as u64);
        assert!(is_installed(dir.path(), &pin));
        // Second call: stored already, the (now failing) network is never touched.
        assert_eq!(
            download(dir.path(), &pin, &Down, &AtomicBool::new(false), |_| ()).unwrap(),
            path
        );
        assert!(std::fs::read_dir(store_dir(dir.path(), &pin))
            .unwrap()
            .all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".part")));
    }

    #[test]
    fn checksum_mismatch_stores_nothing() {
        let archive = bz2(b"genuine");
        let pin = pin_of(&archive);
        let mut tampered = archive.clone();
        *tampered.last_mut().unwrap() ^= 0xff;
        let dir = tempfile::tempdir().unwrap();
        let err = download(
            dir.path(),
            &pin,
            &Bytes(tampered),
            &AtomicBool::new(false),
            |_| (),
        )
        .unwrap_err();
        assert!(matches!(err, Failure::Checksum { .. }), "{err:?}");
        assert_eq!(err.code(), "checksum");
        assert!(!is_installed(dir.path(), &pin));
        assert!(!store_dir(dir.path(), &pin).exists());
    }

    #[test]
    fn offline_is_reported_as_offline_and_leaves_nothing() {
        let pin = pin_of(&bz2(b"x"));
        let dir = tempfile::tempdir().unwrap();
        let err = download(dir.path(), &pin, &Down, &AtomicBool::new(false), |_| ()).unwrap_err();
        assert_eq!(err.code(), "offline");
        assert!(err.to_json().contains("\"code\":\"offline\""));
        assert!(!store_dir(dir.path(), &pin).exists());
        assert_eq!(Failure::Http(503).code(), "offline");
    }

    #[test]
    fn cancel_stops_the_download() {
        let archive = bz2(&[7u8; 4096]);
        let pin = pin_of(&archive);
        let dir = tempfile::tempdir().unwrap();
        let cancel = AtomicBool::new(false);
        let mut chunks = 0;
        let err = download(dir.path(), &pin, &Bytes(archive), &cancel, |_| {
            chunks += 1;
            if chunks == 2 {
                cancel.store(true, Ordering::Relaxed);
            }
        })
        .unwrap_err();
        assert_eq!(err, Failure::Cancelled);
        assert!(!is_installed(dir.path(), &pin));
    }

    #[test]
    fn corrupt_archive_with_matching_hash_is_an_io_failure() {
        let junk = b"this is not bzip2 data at all".to_vec();
        let pin = pin_of(&junk);
        let dir = tempfile::tempdir().unwrap();
        let err = download(
            dir.path(),
            &pin,
            &Bytes(junk),
            &AtomicBool::new(false),
            |_| (),
        )
        .unwrap_err();
        assert_eq!(err.code(), "io");
        assert!(!is_installed(dir.path(), &pin));
    }

    #[test]
    fn store_paths_stay_inside_the_app_data_folder() {
        let root = Path::new("/data");
        for p in PINS {
            let lib = library_path(root, p);
            assert!(
                lib.starts_with(root.join("openh264").join(p.version)),
                "{lib:?}"
            );
            assert!(
                !p.library.contains(['/', '\\']) && !p.library.contains(".."),
                "{}",
                p.library
            );
            assert!(!p.remote.contains(['/', '\\']), "{}", p.remote);
        }
    }

    #[test]
    fn preload_without_a_stored_library_is_a_quiet_no() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!preload_installed(dir.path()));
    }
}
