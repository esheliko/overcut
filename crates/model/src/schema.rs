//! JSON Schema of the project document. The checked-in copy at `packages/engine-client/schema/project.schema.json`
//! is the source for the generated TypeScript types (`node scripts/gen-model-types.mjs`); a test here fails when it drifts.

use crate::Project;

/// The schema as pretty JSON with a trailing newline (exactly the checked-in file).
pub fn project_schema_json() -> String {
    let schema = schemars::schema_for!(Project);
    let mut s = serde_json::to_string_pretty(&schema).expect("schema serializes");
    s.push('\n');
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    const PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/engine-client/schema/project.schema.json"
    );

    /// Fails when the checked-in schema is stale. Refresh with `UPDATE_SCHEMA=1 cargo test -p app-model schema`
    /// then `npm run gen:model-types`.
    #[test]
    fn checked_in_schema_matches_the_structs() {
        let fresh = project_schema_json();
        if std::env::var_os("UPDATE_SCHEMA").is_some() {
            std::fs::write(PATH, &fresh).unwrap();
            return;
        }
        let on_disk =
            std::fs::read_to_string(PATH).expect("schema file missing: run with UPDATE_SCHEMA=1");
        assert!(
            on_disk == fresh,
            "project.schema.json is stale: run `UPDATE_SCHEMA=1 cargo test -p app-model schema` and `npm run gen:model-types`"
        );
    }
}
