//! wasm-bindgen shim over `intar-image-scenario` for the in-app authoring
//! validator. Mirrors `intar-image-cli validate` exactly: same scenario
//! validation, same base-image catalog (embedded at compile time from the
//! repo's base-images.hcl), same per-VM kino-config derivation, and the same
//! content hash as the fs build pipeline (via the shared in-memory core).

use intar_image_scenario::{
    BaseImageCatalog, Scenario, ScenarioContentHashParams, scenario_content_hash_from_entries,
};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

/// The same catalog `intar-image-cli validate` loads from the repo root.
const BASE_IMAGES_HCL: &str = include_str!("../../../base-images.hcl");

const TARGET_ARCH: &str = "amd64";

#[derive(Serialize)]
struct ValidationOutput {
    ok: bool,
    errors: Vec<String>,
    /// serde-serialized `Scenario` when parsing succeeded (even if
    /// validation then failed) — the editor uses it for the preview.
    preview: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct HashEntry {
    path: String,
    /// File content as UTF-8 text (scenario sources are text files).
    content: String,
}

#[derive(Deserialize)]
struct HashInput {
    scenario_id: String,
    base_definition: String,
    kino_version: String,
    target_arch: Option<String>,
    entries: Vec<HashEntry>,
}

fn validate_impl(scenario_hcl: &str) -> ValidationOutput {
    let scenario = match Scenario::parse(scenario_hcl) {
        Ok(scenario) => scenario,
        Err(error) => {
            return ValidationOutput {
                ok: false,
                errors: vec![error.to_string()],
                preview: None,
            };
        }
    };

    let preview = serde_json::to_value(&scenario).ok();
    let mut errors = Vec::new();

    let catalog = match BaseImageCatalog::parse(BASE_IMAGES_HCL) {
        Ok(catalog) => Some(catalog),
        Err(error) => {
            errors.push(format!("base image catalog: {error}"));
            None
        }
    };

    if let Err(error) = scenario.validate_for_builder_arch(TARGET_ARCH) {
        errors.push(error.to_string());
    }

    if let Some(catalog) = catalog {
        if let Err(error) = catalog.validate_for_builder_arch(TARGET_ARCH) {
            errors.push(format!("base image catalog: {error}"));
        }
        if let Err(error) = catalog.validate_scenario_for_builder_arch(&scenario, TARGET_ARCH) {
            errors.push(error.to_string());
        }
    }

    for vm in &scenario.vms {
        if let Err(error) = scenario.derive_kino_config_for_vm(&vm.name) {
            errors.push(format!("vm '{}': {error}", vm.name));
        }
    }

    ValidationOutput {
        ok: errors.is_empty(),
        errors,
        preview,
    }
}

/// Validate a scenario HCL document. Returns a JSON string:
/// `{ ok, errors: string[], preview: Scenario | null }`.
#[wasm_bindgen]
pub fn validate(scenario_hcl: &str) -> String {
    let output = validate_impl(scenario_hcl);
    serde_json::to_string(&output).unwrap_or_else(|_| {
        r#"{"ok":false,"errors":["serialization failed"],"preview":null}"#.to_string()
    })
}

/// Compute the build content hash for in-memory scenario files. Input is a
/// JSON string: `{ scenario_id, base_definition, kino_version, target_arch?,
/// entries: [{ path, content }] }`. Returns the hex hash, or throws.
#[wasm_bindgen]
pub fn content_hash(input_json: &str) -> Result<String, JsError> {
    let input: HashInput = serde_json::from_str(input_json)
        .map_err(|error| JsError::new(&format!("invalid hash input: {error}")))?;
    let entries: Vec<(String, Vec<u8>)> = input
        .entries
        .into_iter()
        .map(|entry| (entry.path, entry.content.into_bytes()))
        .collect();
    scenario_content_hash_from_entries(
        &ScenarioContentHashParams {
            scenario_id: &input.scenario_id,
            base_definition: &input.base_definition,
            kino_version: &input.kino_version,
            target_arch: input.target_arch.as_deref().unwrap_or("x86_64"),
        },
        &entries,
    )
    .map_err(|error| JsError::new(&error.to_string()))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::validate_impl;

    #[test]
    fn rejects_garbage_hcl() {
        let output = validate_impl("this is not hcl {{{");
        assert!(!output.ok);
        assert!(!output.errors.is_empty());
        assert!(output.preview.is_none());
    }

    #[test]
    fn validates_a_repo_scenario() {
        let hcl = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../scenarios")
                .read_dir()
                .unwrap()
                .filter_map(Result::ok)
                .find_map(|entry| {
                    let path = entry.path().join("scenario.hcl");
                    path.is_file().then_some(path)
                })
                .expect("at least one scenario in the repo"),
        )
        .unwrap();
        let output = validate_impl(&hcl);
        assert!(
            output.ok,
            "expected repo scenario to validate: {:?}",
            output.errors
        );
        assert!(output.preview.is_some());
    }
}
