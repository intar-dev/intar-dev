//! wasm-bindgen shim over `intar-image-scenario` for the in-app authoring
//! validator. Mirrors `intar-image-cli validate` exactly: same scenario
//! validation, same base-image catalog (embedded at compile time from the
//! repo's content/scenarios/base-images.hcl), same per-VM kino-config derivation, and the same
//! content hash as the fs build pipeline (via the shared in-memory core).

use std::collections::BTreeMap;

use intar_image_scenario::{
    BaseImageCatalog, BuildTools, Scenario, ScenarioContentHashParams,
    scenario_content_hash_from_entries,
};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

/// The same catalog `intar-image-cli validate` loads from the repo root.
const BASE_IMAGES_HCL: &str = include_str!("../../../content/scenarios/base-images.hcl");
/// The same tool pins the CI bundle upload uses (kino version).
const BUILD_TOOLS_HCL: &str = include_str!("../../../content/scenarios/build-tools.hcl");

/// Matches builder.sample.amd64.hcl / the CI bundle upload.
const TARGET_ARCH: &str = "amd64";
/// Contract image-architecture slug for TARGET_ARCH.
const IMAGE_ARCH: &str = "x86_64";

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

#[derive(Serialize)]
struct PrepareBuildOutput {
    ok: bool,
    errors: Vec<String>,
    scenario_id: Option<String>,
    content_hash: Option<String>,
    kino_version: Option<String>,
    target_arch: &'static str,
    image_arch: &'static str,
}

/// Port of intar-image-cli's `scenario_base_definition_identity`: the
/// content-hash input describing the base images a scenario builds on.
fn base_definition_identity(
    scenario: &Scenario,
    catalog: &BaseImageCatalog,
    target_arch: &str,
) -> Result<String, String> {
    let mut definitions = BTreeMap::new();
    for image in scenario.images.values() {
        let base_image = catalog
            .base_image_by_name(&image.base)
            .ok_or_else(|| format!("base image '{}' not found in catalog", image.base))?;
        let definition = base_image.definition_for_arch(target_arch).ok_or_else(|| {
            format!(
                "base image '{}' has no {target_arch} mmdebstrap definition",
                image.base
            )
        })?;
        definitions.insert(image.base.clone(), definition.content_identity());
    }

    Ok(definitions
        .iter()
        .map(|(name, definition)| format!("{name}\n{definition}"))
        .collect::<Vec<_>>()
        .join("\n---\n"))
}

fn prepare_build_impl(scenario_hcl: &str) -> PrepareBuildOutput {
    let validation = validate_impl(scenario_hcl);
    if !validation.ok {
        return PrepareBuildOutput {
            ok: false,
            errors: validation.errors,
            scenario_id: None,
            content_hash: None,
            kino_version: None,
            target_arch: TARGET_ARCH,
            image_arch: IMAGE_ARCH,
        };
    }

    let fail = |message: String| PrepareBuildOutput {
        ok: false,
        errors: vec![message],
        scenario_id: None,
        content_hash: None,
        kino_version: None,
        target_arch: TARGET_ARCH,
        image_arch: IMAGE_ARCH,
    };

    let scenario = match Scenario::parse(scenario_hcl) {
        Ok(scenario) => scenario,
        Err(error) => return fail(error.to_string()),
    };
    let catalog = match BaseImageCatalog::parse(BASE_IMAGES_HCL) {
        Ok(catalog) => catalog,
        Err(error) => return fail(format!("base image catalog: {error}")),
    };
    let build_tools = match BuildTools::parse(BUILD_TOOLS_HCL) {
        Ok(tools) => tools,
        Err(error) => return fail(format!("build tools: {error}")),
    };
    let base_definition = match base_definition_identity(&scenario, &catalog, TARGET_ARCH) {
        Ok(identity) => identity,
        Err(error) => return fail(error),
    };

    let entries = vec![("scenario.hcl".to_string(), scenario_hcl.as_bytes().to_vec())];
    let content_hash = match scenario_content_hash_from_entries(
        &ScenarioContentHashParams {
            scenario_id: &scenario.name,
            base_definition: &base_definition,
            kino_version: &build_tools.kino.version,
            target_arch: TARGET_ARCH,
        },
        &entries,
    ) {
        Ok(hash) => hash,
        Err(error) => return fail(error.to_string()),
    };

    PrepareBuildOutput {
        ok: true,
        errors: Vec::new(),
        scenario_id: Some(scenario.name),
        content_hash: Some(content_hash),
        kino_version: Some(build_tools.kino.version),
        target_arch: TARGET_ARCH,
        image_arch: IMAGE_ARCH,
    }
}

/// Validate a scenario and compute everything a source-bundle upload needs:
/// `{ ok, errors, scenario_id, content_hash, kino_version, target_arch,
/// image_arch }`. The hash covers exactly one file, `scenario.hcl`, matching
/// how the in-app build endpoint assembles its bundle.
#[wasm_bindgen]
pub fn prepare_build(scenario_hcl: &str) -> String {
    let output = prepare_build_impl(scenario_hcl);
    serde_json::to_string(&output)
        .unwrap_or_else(|_| r#"{"ok":false,"errors":["serialization failed"]}"#.to_string())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::{prepare_build_impl, validate_impl};

    #[test]
    fn rejects_garbage_hcl() {
        let output = validate_impl("this is not hcl {{{");
        assert!(!output.ok);
        assert!(!output.errors.is_empty());
        assert!(output.preview.is_none());
    }

    #[test]
    fn prepare_build_yields_cli_parity_hashes_for_repo_scenarios() {
        // Every repo scenario is a single scenario.hcl, so these hashes must
        // equal `intar-image-cli hash --config builder.sample.amd64.hcl`.
        let scenarios_dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../content/scenarios");
        let mut checked = 0;
        for entry in scenarios_dir.read_dir().unwrap().filter_map(Result::ok) {
            let path = entry.path().join("scenario.hcl");
            if !path.is_file() {
                continue;
            }
            let hcl = std::fs::read_to_string(&path).unwrap();
            let output = prepare_build_impl(&hcl);
            assert!(output.ok, "{}: {:?}", path.display(), output.errors);
            let hash = output.content_hash.unwrap();
            assert_eq!(hash.len(), 64);
            println!(
                "{}\t{}\t{}",
                output.scenario_id.unwrap(),
                output.target_arch,
                hash
            );
            assert_eq!(output.kino_version.as_deref(), Some("0.2.5"));
            checked += 1;
        }
        assert!(checked > 0, "expected at least one repo scenario");
    }

    #[test]
    fn validates_a_repo_scenario() {
        let hcl = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../content/scenarios")
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
