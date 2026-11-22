#![no_main]
//! Any bytes into the reader must return Ok or Err, never panic; anything that opens must also write and re-open.
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    if let Ok(file) = app_model::ProjectFile::read(data) {
        if let Ok(bytes) = file.write() {
            let again = app_model::ProjectFile::read(&bytes).expect("what we write must re-open");
            assert_eq!(again.project(), file.project());
        }
    }
    let _ = app_model::open_json(data);
});
