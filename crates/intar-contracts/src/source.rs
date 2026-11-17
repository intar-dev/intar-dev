//! Wire shapes shared by the scenario source compiler (CLI and builder) and
//! the Worker's source routes.

use std::collections::BTreeSet;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::catalog::CourseCatalogSnapshotV2;
use crate::oci::IMAGE_FORMAT;
use crate::scenario::{ImageV1, ScenarioV1, validate, validate_images};

/// OIDC-authenticated push upload of a compiled source bundle.
pub const SOURCE_BUNDLES_PATH: &str = "/registry/v1/sources/bundles";
/// Public descriptor of the CLI release that compiles source bundles.
pub const SOURCE_COMPILER_PATH: &str = "/registry/v1/sources/compiler";
/// Builder prefix. Both routes are fenced on the `attempt` query parameter:
/// - `GET <prefix>/<compile_id>?attempt=<n>` returns the snapshot;
/// - `POST <prefix>/<compile_id>/result?attempt=<n>` takes the result. A
///   success is `multipart/form-data` with the meta and bundle fields, and a
///   failure is an `application/json` `SourceCompileFailureV1` whose
///   `compile_id` and `attempt` match the path and query. The route tells
///   the two apart by `Content-Type`.
pub const AGENT_SOURCES_PATH: &str = "/agent/registry/sources";

/// Multipart field carrying the bundle meta JSON.
pub const SOURCE_META_FIELD: &str = "meta";
/// Multipart field carrying the compiled bundle archive.
pub const SOURCE_BUNDLE_FIELD: &str = "bundle";

/// Epoch of the `intar.hcl` source compiler. Bump it whenever the compiled
/// [`SourceBundleV2`] changes for an unchanged repository tree.
pub const SOURCE_COMPILER_VERSION_V2: &str = "intar-source-compiler-v2";
/// The most a gzipped [`SourceBundleV2`] may weigh.
pub const MAX_SOURCE_BUNDLE_GZIP_BYTES: usize = 2 * 1024 * 1024;

/// `p` plus the first 8 hex characters of the sha256 of
/// `<image_format>\n<compiler_version>`. Every rev a v2 compiler uploads ends
/// in it, and the Worker refuses one that differs from its own.
#[must_use]
pub fn source_compile_digest(image_format: &str, compiler_version: &str) -> String {
    let hash = Sha256::digest(format!("{image_format}\n{compiler_version}"));
    let hex: String = hash[..4].iter().map(|byte| format!("{byte:02x}")).collect();
    format!("p{hex}")
}

/// One compiled repository: the `bundle` field of an upload, gzipped JSON.
/// Every script is lowered and every `file()` and `markdown()` inlined; no
/// HCL and no author path survives.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SourceBundleV2 {
    /// [`SOURCE_COMPILER_VERSION_V2`] of the compiler that wrote it.
    pub compiler: String,
    /// `IMAGE_FORMAT` the compiler targets.
    pub image_format: String,
    pub scenarios: Vec<ScenarioV1>,
    pub images: Vec<ImageV1>,
    /// Lecture `scenario_id`s are bare scenario slugs of this bundle; the
    /// Worker namespaces them from the repository's binding.
    pub course_catalog: CourseCatalogSnapshotV2,
}

/// The `meta` field of a [`SourceBundleV2`] upload.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SourceBundleMetaV2 {
    pub rev: String,
}

/// Content type of the `bundle` part.
pub const SOURCE_BUNDLE_MIME: &str = "application/gzip";

impl SourceBundleMetaV2 {
    /// The `meta` field's text: the CLI and the builder send the same.
    #[must_use]
    pub fn field(&self) -> String {
        // A struct of one string always serializes.
        serde_json::to_string(self).unwrap_or_default()
    }

    /// The `bundle` part's file name.
    #[must_use]
    pub fn bundle_file_name(&self) -> String {
        format!("{}.json.gz", self.rev)
    }
}

/// Every rule a bundle must keep, for the compiler, the Worker's ingest and
/// the builder alike; the result lists every problem found.
pub fn validate_bundle(bundle: &SourceBundleV2) -> Result<(), Vec<String>> {
    let mut problems = Vec::new();
    if bundle.compiler != SOURCE_COMPILER_VERSION_V2 {
        problems.push(format!("compiler `{}` is not current", bundle.compiler));
    }
    if bundle.image_format != IMAGE_FORMAT {
        problems.push(format!(
            "image format `{}` is not current",
            bundle.image_format
        ));
    }
    if let Err(found) = validate_images(&bundle.images) {
        problems.extend(found);
    }
    let mut slugs = BTreeSet::new();
    for scenario in &bundle.scenarios {
        if !slugs.insert(scenario.slug.as_str()) {
            problems.push(format!("scenario `{}`: declared twice", scenario.slug));
        }
        if let Err(found) = validate(scenario, &bundle.images) {
            let prefix = format!("scenario `{}`: ", scenario.slug);
            problems.extend(found.into_iter().map(|problem| {
                // Image problems are already listed once.
                if problem.starts_with("image `") {
                    problem
                } else {
                    format!("{prefix}{problem}")
                }
            }));
        }
    }
    let catalog = &bundle.course_catalog;
    if catalog.version != 2 {
        problems.push(format!(
            "course catalog version {} is not 2",
            catalog.version
        ));
    }
    let mut courses = BTreeSet::new();
    for course in &catalog.courses {
        if !courses.insert(course.course_id.as_str()) {
            problems.push(format!("course `{}`: declared twice", course.course_id));
        }
        let mut lectures = BTreeSet::new();
        for lecture in &course.lectures {
            let at = format!("lecture `{}/{}`", course.course_id, lecture.lecture_id);
            if !lectures.insert(lecture.lecture_id.as_str()) {
                problems.push(format!("{at}: declared twice"));
            }
            if let Some(slug) = &lecture.scenario_id
                && !slugs.contains(slug.as_str())
            {
                problems.push(format!("{at}: scenario `{slug}` is not in this repository"));
            }
        }
    }
    let mut seen = BTreeSet::new();
    problems.retain(|problem| seen.insert(problem.clone()));
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceRefusalCode {
    CompilerOutdated,
    Superseded,
    Fenced,
    BindingInactive,
    IssuerUnsupported,
}

/// The body of a refusal named by a `SourceRefusalCode`: the Worker's
/// `AppErrorResponseBody` shape, with a mandatory code. Every other non-2xx
/// answer from a source route is a plain `AppErrorResponseBody` whose `code`
/// is absent or outside this enum, so clients decode it leniently and still
/// print its `error`.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SourceRefusalV1 {
    pub error: String,
    pub code: SourceRefusalCode,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceCompileErrorCode {
    ManifestMissing,
    ManifestInvalid,
    CoursesRootMissing,
    SubmoduleUnsupported,
    LfsUnsupported,
    BundleTooLarge,
    MetaTooLarge,
    TooManyScenarios,
    CompileFailed,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_compile_digest_matches_a_fixed_vector() {
        // printf 'intar-image-3\nintar-source-compiler-v2' | shasum -a 256
        assert_eq!(
            source_compile_digest(IMAGE_FORMAT, SOURCE_COMPILER_VERSION_V2),
            "pefcf1cdb"
        );
    }

    fn bundle() -> SourceBundleV2 {
        let scenario: ScenarioV1 = serde_json::from_value(serde_json::json!({
            "slug": "broken-nginx", "title": "t", "summary": "s", "difficulty": "easy",
            "minutes": 10, "tags": [], "play": false, "briefing": "b", "solution": "s",
            "hints": [],
            "machines": [{
                "name": "web", "cpu_millis": 1000, "memory_mib": 512, "disk_mib": 4096,
                "from": "trixie", "defer": [], "terminal": true, "egress": false,
                "env": {}, "setup": [], "ready": []
            }],
            "tasks": [{
                "id": "nginx-up", "title": "t", "machine": "web", "needs": [],
                "optional": false, "check": "true", "solve": "true", "hints": []
            }]
        }))
        .expect("the scenario parses");
        let course_catalog =
            serde_json::from_str(include_str!("../fixtures/catalog/course-catalog-v2.json"))
                .expect("the catalog parses");
        SourceBundleV2 {
            compiler: SOURCE_COMPILER_VERSION_V2.to_owned(),
            image_format: IMAGE_FORMAT.to_owned(),
            scenarios: vec![scenario],
            images: Vec::new(),
            course_catalog,
        }
    }

    #[test]
    fn a_sound_bundle_passes_and_round_trips_strictly() {
        let bundle = bundle();
        assert_eq!(validate_bundle(&bundle), Ok(()));
        let mut json = serde_json::to_value(&bundle).expect("serializes");
        assert_eq!(
            serde_json::from_value::<SourceBundleV2>(json.clone()).ok(),
            Some(bundle)
        );
        json["extra"] = serde_json::json!(1);
        assert!(serde_json::from_value::<SourceBundleV2>(json).is_err());
    }

    #[test]
    fn validate_bundle_refuses_each_broken_rule() {
        type Break = fn(&mut SourceBundleV2);
        let broken: [(&str, Break); 7] = [
            ("compiler `old` is not current", |b| {
                b.compiler = "old".to_owned()
            }),
            ("image format `x` is not current", |b| {
                b.image_format = "x".to_owned()
            }),
            ("scenario `broken-nginx`: declared twice", |b| {
                b.scenarios.push(b.scenarios[0].clone())
            }),
            ("image `k3s`: declared twice", |b| {
                let image: ImageV1 = serde_json::from_value(serde_json::json!({
                    "name": "k3s", "from": "trixie", "disk_mib": 8192,
                    "defer": [], "setup": []
                }))
                .expect("the image parses");
                b.images = vec![image.clone(), image];
            }),
            (
                "scenario `broken-nginx`: task `nginx-up`: needs a check",
                |b| b.scenarios[0].tasks[0].check = String::new(),
            ),
            (
                "lecture `linux-operations/01-nginx`: scenario `rawkode-academy/x` is not in this repository",
                |b| {
                    b.course_catalog.courses[0].lectures[0].scenario_id =
                        Some("rawkode-academy/x".to_owned())
                },
            ),
            (
                "lecture `linux-operations/02-processes`: declared twice",
                |b| {
                    let lectures = &mut b.course_catalog.courses[0].lectures;
                    lectures.push(lectures[1].clone());
                },
            ),
        ];
        for (expected, mutate) in broken {
            let mut bundle = bundle();
            mutate(&mut bundle);
            let found = validate_bundle(&bundle).err().unwrap_or_default();
            assert!(
                found.iter().any(|problem| problem == expected),
                "expected `{expected}` in {found:?}"
            );
            // Each problem is listed once.
            let unique: BTreeSet<_> = found.iter().collect();
            assert_eq!(unique.len(), found.len(), "{found:?}");
        }
    }
}
