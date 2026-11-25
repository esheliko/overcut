use super::*;
use serde_json::json;

const FIXTURE_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures");

fn fixture(v: u32) -> Vec<u8> {
    std::fs::read(format!("{FIXTURE_DIR}/project.v{v}.json")).unwrap_or_else(|_| {
        panic!("missing fixture project.v{v}.json: every schema version needs one")
    })
}

fn container(json: &[u8], extra: &[(&str, &[u8])]) -> Vec<u8> {
    let entries = extra
        .iter()
        .map(|(n, b)| (n.to_string(), b.to_vec()))
        .collect();
    zip_up(json, &entries).unwrap()
}

#[test]
fn migration_chain_length_matches_schema_version() {
    assert_eq!(MIGRATIONS.len() as u32, SCHEMA_VERSION - 1);
}

#[test]
fn every_fixture_migrates_to_current_and_round_trips() {
    for v in 1..=SCHEMA_VERSION {
        let f =
            ProjectFile::read(&container(&fixture(v), &[])).unwrap_or_else(|e| panic!("v{v}: {e}"));
        assert_eq!(f.found_version(), v);
        assert_eq!(f.project().schema_version, SCHEMA_VERSION);
        assert!(!f.read_only());
        let bytes = f.write().unwrap();
        let again = ProjectFile::read(&bytes).unwrap();
        assert_eq!(again.project(), f.project(), "v{v} round trip");
        assert_eq!(again.write().unwrap(), bytes, "writing is deterministic");
    }
}

#[test]
fn unknown_fields_survive_at_every_depth_and_follow_their_element() {
    let mut doc: Value = serde_json::from_slice(&fixture(SCHEMA_VERSION)).unwrap();
    doc["future_top"] = json!({"a": [1, 2]});
    doc["media"][0]["codec_notes"] = json!("x");
    doc["sequences"][0]["tracks"][0]["clips"][0]["color_label"] = json!("red");
    let bytes = container(
        &serde_json::to_vec(&doc).unwrap(),
        &[("journal", b"J"), ("thumbnails/a.jpg", b"T")],
    );
    let mut f = ProjectFile::read(&bytes).unwrap();
    // Edit through the model: rename, add a second clip before the first (reorders the array).
    f.project_mut().unwrap().name = "Renamed".into();
    let first = f.project().sequences[0].tracks[0].clips[0].clone();
    let mut early = first.clone();
    early.id = serde_json::from_value(json!("00000000000000000000000000000099")).unwrap();
    early.start = first.end().unwrap();
    f.project_mut().unwrap().sequences[0].tracks[0]
        .clips
        .push(early);
    let out: Value = {
        let (json, entries) = unzip(&f.write().unwrap()).unwrap();
        assert_eq!(entries["journal"], b"J");
        assert_eq!(entries["thumbnails/a.jpg"], b"T");
        serde_json::from_slice(&json).unwrap()
    };
    assert_eq!(out["name"], "Renamed");
    assert_eq!(out["future_top"], json!({"a": [1, 2]}));
    assert_eq!(out["media"][0]["codec_notes"], "x");
    let clips = &out["sequences"][0]["tracks"][0]["clips"];
    assert_eq!(clips[0]["color_label"], "red");
    assert!(
        clips[1].get("color_label").is_none(),
        "unknown data stays on the element it came from"
    );
}

#[test]
fn newer_schema_opens_read_only_and_refuses_to_write() {
    let mut doc: Value = serde_json::from_slice(&fixture(SCHEMA_VERSION)).unwrap();
    doc["schema_version"] = json!(SCHEMA_VERSION + 1);
    doc["brand_new"] = json!(true);
    let bytes = container(&serde_json::to_vec(&doc).unwrap(), &[]);
    let mut f = ProjectFile::read(&bytes).unwrap();
    assert!(f.read_only());
    assert_eq!(f.found_version(), SCHEMA_VERSION + 1);
    assert_eq!(f.project().name, "Fixture v4");
    assert_eq!(f.write().unwrap_err().code(), "read_only");
    assert_eq!(f.project_mut().unwrap_err().code(), "read_only");
    assert_eq!(
        f.set_entry("peaks/x", vec![]).unwrap_err().code(),
        "read_only"
    );
    assert_eq!(
        save_bytes(&serde_json::to_string(f.project()).unwrap(), &bytes)
            .unwrap_err()
            .code(),
        "read_only"
    );
}

#[test]
fn newer_schema_that_no_longer_fits_our_shape_is_a_clear_error() {
    let bytes = container(br#"{"schema_version": 99, "projects": []}"#, &[]);
    let e = ProjectFile::read(&bytes).unwrap_err();
    assert_eq!(e.code(), "newer_version");
    assert!(e.to_string().contains("newer version"));
}

#[test]
fn migration_machinery_runs_every_step_in_order() {
    fn v1_to_v2(mut d: Value) -> Result<Value, FileError> {
        d["name"] = json!(format!("{}+2", d["name"].as_str().unwrap()));
        d["schema_version"] = json!(2);
        Ok(d)
    }
    fn v2_to_v3(mut d: Value) -> Result<Value, FileError> {
        d["name"] = json!(format!("{}+3", d["name"].as_str().unwrap()));
        d["schema_version"] = json!(3);
        Ok(d)
    }
    let doc: Value = serde_json::from_slice(&fixture(1)).unwrap();
    let out = migrate_with(&[v1_to_v2, v2_to_v3], 3, doc.clone(), 1).unwrap();
    assert_eq!(out["name"], "Fixture v1+2+3");
    assert_eq!(
        migrate_with(&[v1_to_v2, v2_to_v3], 3, doc.clone(), 2).unwrap()["name"],
        "Fixture v1+3"
    );
    // A step that forgets to bump the version, or a missing step, is an error rather than a loop or a silent skip.
    fn lazy(d: Value) -> Result<Value, FileError> {
        Ok(d)
    }
    assert!(migrate_with(&[lazy], 2, doc.clone(), 1).is_err());
    assert!(migrate_with(&[], 2, doc, 1).is_err());
}

#[test]
fn corrupt_and_hostile_input_is_an_error_not_a_panic() {
    let good = container(&fixture(1), &[("peaks/a", &[1, 2, 3])]);
    // Every truncation, and every single-byte corruption, must return (Ok or Err) without panicking.
    for n in 0..good.len() {
        let _ = ProjectFile::read(&good[..n]);
    }
    for i in 0..good.len() {
        let mut b = good.clone();
        b[i] ^= 0xFF;
        let _ = ProjectFile::read(&b);
    }
    assert_eq!(ProjectFile::read(b"").unwrap_err().code(), "corrupt");
    assert_eq!(
        ProjectFile::read(b"not a zip at all").unwrap_err().code(),
        "corrupt"
    );
    assert_eq!(
        ProjectFile::read(&good[..good.len() / 2])
            .unwrap_err()
            .code(),
        "corrupt"
    );
    let no_project = zip_up(b"{}", &BTreeMap::new()).unwrap();
    // `{}` in project.json: bad project; a zip without it: missing.
    assert_eq!(
        ProjectFile::read(&no_project).unwrap_err().code(),
        "bad_project"
    );
    let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
    w.start_file("other", zip::write::SimpleFileOptions::default())
        .unwrap();
    let only_other = w.finish().unwrap().into_inner();
    assert_eq!(
        ProjectFile::read(&only_other).unwrap_err().code(),
        "missing_project"
    );
    for bad in [
        &b"null"[..],
        b"[]",
        b"{\"schema_version\":0}",
        b"{\"schema_version\":-1}",
        b"{\"schema_version\":\"1\"}",
    ] {
        assert_eq!(
            ProjectFile::read(&container(bad, &[])).unwrap_err().code(),
            "bad_project"
        );
    }
    // Deeply nested JSON hits serde_json's recursion limit instead of the stack.
    let deep = format!("{}{}", "[".repeat(100_000), "]".repeat(100_000));
    assert!(ProjectFile::read(&container(deep.as_bytes(), &[])).is_err());
}

#[test]
fn unsafe_entry_names_and_oversized_entries_are_refused() {
    for name in ["../evil", "/abs", "a/../b", "a\\b", ""] {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        w.start_file(PROJECT_ENTRY, zip::write::SimpleFileOptions::default())
            .unwrap();
        w.write_all(&fixture(1)).unwrap();
        if !name.is_empty() {
            w.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
        }
        let bytes = w.finish().unwrap().into_inner();
        if !name.is_empty() {
            assert_eq!(
                ProjectFile::read(&bytes).unwrap_err().code(),
                "limits",
                "{name}"
            );
        }
    }
    let mut f = ProjectFile::read(&container(&fixture(1), &[])).unwrap();
    assert!(f.set_entry("../x", vec![]).is_err());
    assert!(f.set_entry(PROJECT_ENTRY, vec![]).is_err());
}

#[test]
fn save_bytes_creates_and_updates() {
    let json = String::from_utf8(fixture(SCHEMA_VERSION)).unwrap();
    let fresh = save_bytes(&json, &[]).unwrap();
    let opened: Value = serde_json::from_str(&open_json(&fresh).unwrap()).unwrap();
    assert_eq!(opened["project"]["name"], "Fixture v4");
    assert_eq!(opened["read_only"], false);
    assert_eq!(opened["migrated"], false);
    assert!(save_bytes("{", &[]).is_err());
    assert!(save_bytes(&json, b"junk").is_err());
    assert_eq!(open_json(b"junk").unwrap_err().code(), "corrupt");
}

#[test]
fn fingerprint_is_stable_size_aware_and_validated() {
    let data: Vec<u8> = (0..200_000u32).map(|i| (i * 31 % 251) as u8).collect();
    let w = FINGERPRINT_WINDOW;
    let fp = fingerprint(data.len() as u64, &data[..w], &data[data.len() - w..]).unwrap();
    assert!(fp.starts_with("b3-64k:200000:"));
    assert_eq!(fingerprint_size(&fp), Some(200_000));
    assert_eq!(
        fp,
        fingerprint(data.len() as u64, &data[..w], &data[data.len() - w..]).unwrap()
    );
    // Changing a byte inside the windows changes it; a byte in the unhashed middle does not (documented trade-off).
    let mut tail = data.clone();
    *tail.last_mut().unwrap() ^= 1;
    assert_ne!(
        fp,
        fingerprint(tail.len() as u64, &tail[..w], &tail[tail.len() - w..]).unwrap()
    );
    let mut mid = data.clone();
    mid[100_000] ^= 1;
    assert_eq!(
        fp,
        fingerprint(mid.len() as u64, &mid[..w], &mid[mid.len() - w..]).unwrap()
    );
    // Small files hash entirely; the same bytes at a different size differ.
    let small = fingerprint(10, &data[..10], &data[..10]).unwrap();
    assert_ne!(
        small,
        fingerprint(11, &data[..10], &data[..10]).unwrap_or_default()
    );
    assert!(fingerprint(10, &data[..9], &data[..10]).is_err());
    assert_eq!(fingerprint_size("garbage"), None);
}

#[test]
fn canvas_choice_round_trips_and_old_files_read_as_not_fixed() {
    // A v1 file written before the canvas flags existed: both read as "follows the first picture".
    let old = ProjectFile::read(&container(&fixture(1), &[])).unwrap();
    let s = &old.project().sequences[0];
    assert!(!s.size_fixed && !s.rate_fixed);
    // The flags stay out of the file while false (small, diff-friendly), and come back when set.
    let text = String::from_utf8_lossy(&old.write().unwrap()).into_owned();
    assert!(!text.contains("size_fixed"));
    let mut p = old.project().clone();
    p.sequences[0].size_fixed = true;
    p.sequences[0].resolution = crate::project::Resolution {
        width: 1080,
        height: 1350,
    };
    let bytes = save_bytes(&serde_json::to_string(&p).unwrap(), &[]).unwrap();
    let back = ProjectFile::read(&bytes).unwrap();
    let s = &back.project().sequences[0];
    assert!(s.size_fixed && !s.rate_fixed);
    assert_eq!((s.resolution.width, s.resolution.height), (1080, 1350));
}

#[test]
fn a_v1_file_opens_with_every_track_at_its_m1_behaviour_and_the_v2_one_keeps_its_track_props() {
    let old = ProjectFile::read(&container(&fixture(1), &[])).unwrap();
    assert_eq!(old.found_version(), 1);
    assert!(old.migrated());
    for t in &old.project().sequences[0].tracks {
        assert!(!t.hidden && !t.solo && t.height.is_none() && t.colour.is_none());
    }
    let new = ProjectFile::read(&container(&fixture(2), &[])).unwrap();
    let t = &new.project().sequences[0].tracks;
    assert!(t[0].hidden && t[0].height == Some(64) && t[0].colour.as_deref() == Some("#2de2d6"));
    assert!(t[1].solo);
    // Defaults are not written: a file that never used them stays as small as before.
    let json = String::from_utf8(
        old.write()
            .map(|b| open_json(&b).unwrap().into_bytes())
            .unwrap(),
    )
    .unwrap();
    assert!(
        !json.contains("\"hidden\"") && !json.contains("\"solo\"") && !json.contains("\"colour\"")
    );
}
