//! Scenario bundle compilation shared by intar-image-cli and intar-builder.
//!
//! It loads the Markdown curriculum, validates each course scenario against
//! the base image catalog, and assembles the deterministic bundle archive and
//! its upload metadata.

use std::collections::{BTreeMap, HashSet};
use std::ffi::OsStr;
use std::fs;
use std::io::{Cursor, Read as _};
use std::path::{Component, Path, PathBuf};

use anyhow::{Context as _, Result, anyhow, bail};
use flate2::{Compression, GzBuilder};
use intar_contracts::catalog::{
    CourseCatalogCourseV2, CourseCatalogLectureV2, CourseCatalogSnapshotV2, ScenarioDifficulty,
};
use intar_contracts::source::{BundleSourceV1, SOURCE_COMPILER_VERSION, SourceCompileErrorCode};
use intar_image_scenario::{BaseImageCatalog, Scenario};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_saphyr::{DuplicateKeyPolicy, MergeKeyPolicy};

use crate::{BUILD_FORMAT_VERSION, ScenarioContentHashInput, scenario_content_hash};

pub const DEFAULT_COURSES_ROOT: &str = "content/courses";
const CURRICULUM_ARCHIVE_ROOT: &str = "curriculum";
const CURRICULUM_CATALOG_ARCHIVE_PATH: &str = "curriculum/catalog.json";

const COURSE_MARKDOWN_FILE: &str = "course.md";
const LECTURE_MARKDOWN_FILE: &str = "lecture.md";
const SCENARIO_HCL_FILE: &str = "scenario.hcl";
const MAX_FRONTMATTER_BYTES: usize = 64 * 1024;
const BUNDLE_BASE_IMAGES_PATH: &str = "base-images.hcl";
const BUNDLE_SCENARIOS_ROOT: &str = "scenarios";
const MAX_BUNDLE_TAR_BYTES: u64 = 64 * 1024 * 1024;
const TAR_BLOCK_SIZE: u64 = 512;

/// The platform base image catalog that `intar.yaml` compiles validate
/// against. Its sha256 is part of the platform compile digest.
const PLATFORM_BASE_IMAGES_HCL: &str = include_str!("../../../content/scenarios/base-images.hcl");
const INTAR_MANIFEST_FILE: &str = "intar.yaml";
const GITMODULES_FILE: &str = ".gitmodules";
/// The only loose file a git courses root may hold: an intentional empty deploy.
const KEEP_FILE: &str = ".keep";
const LFS_POINTER_LINE: &[u8] = b"version https://git-lfs.github.com/spec/v1";
const MAX_MANIFEST_BYTES: usize = 64 * 1024;
const MAX_COURSES_ROOT_COMPONENTS: usize = 8;
const MAX_SOURCE_BUNDLE_TAR_BYTES: u64 = 4 * 1024 * 1024;
const MAX_SOURCE_BUNDLE_GZIP_BYTES: usize = 2 * 1024 * 1024;
const MAX_SOURCE_META_BYTES: usize = 1_500_000;
const MAX_SOURCE_SCENARIOS: usize = 100;

/// The inputs of one bundle compilation.
#[derive(Debug)]
pub struct CompileBundleInput<'a> {
    pub courses_root: &'a Path,
    pub base_images: &'a Path,
    pub rev: &'a str,
    pub target_arch: &'a str,
    /// Bundles only this scenario. Every scenario is still validated.
    pub scenario: Option<&'a str>,
}

/// A compiled bundle: the gzip-compressed archive and its upload metadata.
#[derive(Debug)]
pub struct CompiledBundle {
    pub archive: Vec<u8>,
    pub meta: serde_json::Value,
    pub scenario_count: usize,
    pub file_count: usize,
}

#[derive(Debug, Clone)]
pub struct CurriculumSource {
    catalog: CourseCatalogSnapshotV2,
    courses: Vec<CourseSource>,
    pub scenarios: Vec<CourseScenario>,
}

#[derive(Debug, Clone)]
struct CourseSource {
    course_id: String,
    course_markdown_path: PathBuf,
    support_files: Vec<PathBuf>,
    lectures: Vec<LectureSource>,
}

#[derive(Debug, Clone)]
struct LectureSource {
    lecture_id: String,
    lecture_markdown_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct CourseScenario {
    pub scenario_id: String,
    pub scenario_path: PathBuf,
    pub scenario_dir: PathBuf,
    pub lecture: CourseCatalogLectureV2,
}

#[derive(Debug, Clone)]
struct BundleSourceFile {
    source_path: PathBuf,
    archive_path: String,
}

#[derive(Debug)]
struct PreparedBundleScenario {
    scenario_id: String,
    scenario_dir: PathBuf,
    content_hash: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CourseFrontmatter {
    title: String,
    summary: String,
    sequential: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LectureFrontmatter {
    title: String,
    summary: String,
    category: String,
    tags: Vec<String>,
    difficulty: Option<ScenarioDifficulty>,
    estimated_minutes: u32,
}

/// Compiles the curriculum under `courses_root` into a bundle archive and the
/// metadata that the registry bundle route expects.
pub fn compile_bundle(input: &CompileBundleInput<'_>) -> Result<CompiledBundle> {
    let contract_arch = contract_image_arch_slug(input.target_arch)?;
    let curriculum = load_curriculum(input.courses_root)?;
    compile_curriculum(&curriculum, contract_arch, input, MAX_BUNDLE_TAR_BYTES)
}

/// A refused `intar.yaml` compile and the code the Worker shows for it.
#[derive(Debug, thiserror::Error)]
#[error("{error:#}")]
pub struct SourceCompileError {
    pub code: SourceCompileErrorCode,
    pub error: anyhow::Error,
}

#[derive(Debug, thiserror::Error)]
#[error(
    "bundle archive would expand to {tar_bytes} bytes, exceeding the {max_tar_bytes} byte limit"
)]
struct BundleTooLarge {
    tar_bytes: u64,
    max_tar_bytes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct IntarManifestV1 {
    version: u32,
    scope: String,
    #[serde(default = "default_source_courses_root")]
    courses_root: String,
}

fn default_source_courses_root() -> String {
    "courses".to_owned()
}

/// The digest of the platform this compiler builds for: the Worker sends
/// compiles and `git-` builds only to builders that advertise it.
#[must_use]
pub fn platform_compile_digest() -> String {
    compile_digest(&crate::sha256_bytes_hex(
        PLATFORM_BASE_IMAGES_HCL.as_bytes(),
    ))
}

fn compile_digest(base_images_sha256: &str) -> String {
    intar_contracts::source::platform_compile_digest(
        BUILD_FORMAT_VERSION,
        SOURCE_COMPILER_VERSION,
        base_images_sha256,
    )
}

/// Compiles an `intar.yaml` repository tree into a bundle whose meta carries
/// `source`. Only `intar.yaml`, `.gitmodules` and the courses root are read,
/// and scenarios validate against the embedded platform base image catalog.
pub fn compile_source_tree(
    root: &Path,
    rev: &str,
    target_arch: &str,
) -> Result<CompiledBundle, SourceCompileError> {
    compile_source_tree_with_catalog(root, rev, target_arch, PLATFORM_BASE_IMAGES_HCL)
}

fn compile_source_tree_with_catalog(
    root: &Path,
    rev: &str,
    target_arch: &str,
    base_images_hcl: &str,
) -> Result<CompiledBundle, SourceCompileError> {
    let failed = refused(SourceCompileErrorCode::CompileFailed);
    let contract_arch = contract_image_arch_slug(target_arch).map_err(failed)?;
    let manifest = read_intar_manifest(root)?;
    reject_submodules(root, &manifest.courses_root)?;
    let courses_root = resolve_courses_root(root, &manifest.courses_root)?;
    if let Some(pointer) = find_lfs_pointer(&courses_root).map_err(failed)? {
        return Err(refused(SourceCompileErrorCode::LfsUnsupported)(anyhow!(
            "Git LFS pointer file is not supported: {}",
            pointer
                .strip_prefix(root)
                .unwrap_or(pointer.as_path())
                .display()
        )));
    }

    let curriculum = load_curriculum_tree(&courses_root, true).map_err(failed)?;
    // Archives hold an empty directory only at a gitlink, so an empty deploy
    // must be explicit.
    if curriculum.courses.is_empty() && !courses_root.join(KEEP_FILE).is_file() {
        return Err(refused(SourceCompileErrorCode::CoursesRootMissing)(
            anyhow!(
                "courses_root '{0}' is empty; an intentional empty deploy needs {0}/{KEEP_FILE}",
                manifest.courses_root
            ),
        ));
    }
    if curriculum.scenarios.len() > MAX_SOURCE_SCENARIOS {
        return Err(refused(SourceCompileErrorCode::TooManyScenarios)(anyhow!(
            "{} scenarios exceed the limit of {MAX_SOURCE_SCENARIOS}",
            curriculum.scenarios.len()
        )));
    }
    let catalog_dir = tempfile::tempdir()
        .context("create base image catalog directory")
        .map_err(failed)?;
    let base_images = catalog_dir.path().join(BUNDLE_BASE_IMAGES_PATH);
    fs::write(&base_images, base_images_hcl)
        .context("write base image catalog")
        .map_err(failed)?;
    let input = CompileBundleInput {
        courses_root: &courses_root,
        base_images: &base_images,
        rev,
        target_arch,
        scenario: None,
    };
    let mut compiled = compile_curriculum(
        &curriculum,
        contract_arch,
        &input,
        MAX_SOURCE_BUNDLE_TAR_BYTES,
    )
    .map_err(|error| {
        let code = if error.downcast_ref::<BundleTooLarge>().is_some() {
            SourceCompileErrorCode::BundleTooLarge
        } else {
            SourceCompileErrorCode::CompileFailed
        };
        refused(code)(error)
    })?;
    if compiled.archive.len() > MAX_SOURCE_BUNDLE_GZIP_BYTES {
        return Err(refused(SourceCompileErrorCode::BundleTooLarge)(anyhow!(
            "bundle archive is {} bytes compressed, exceeding the {MAX_SOURCE_BUNDLE_GZIP_BYTES} byte limit",
            compiled.archive.len()
        )));
    }

    compiled.meta["source"] = serde_json::to_value(BundleSourceV1 {
        scope: manifest.scope,
        courses_root: manifest.courses_root,
        compiler_version: SOURCE_COMPILER_VERSION.to_owned(),
    })
    .context("serialize bundle source")
    .map_err(failed)?;
    let meta_bytes = serde_json::to_vec(&compiled.meta)
        .context("serialize bundle meta")
        .map_err(failed)?
        .len();
    if meta_bytes > MAX_SOURCE_META_BYTES {
        return Err(refused(SourceCompileErrorCode::MetaTooLarge)(anyhow!(
            "bundle meta is {meta_bytes} bytes, exceeding the {MAX_SOURCE_META_BYTES} byte limit"
        )));
    }
    Ok(compiled)
}

fn refused(code: SourceCompileErrorCode) -> impl Fn(anyhow::Error) -> SourceCompileError + Copy {
    move |error| SourceCompileError { code, error }
}

fn read_intar_manifest(root: &Path) -> Result<IntarManifestV1, SourceCompileError> {
    let invalid = refused(SourceCompileErrorCode::ManifestInvalid);
    let path = root.join(INTAR_MANIFEST_FILE);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() && metadata.len() <= MAX_MANIFEST_BYTES as u64 => {}
        Ok(_) => {
            return Err(invalid(anyhow!(
                "{INTAR_MANIFEST_FILE} must be a regular file of at most {MAX_MANIFEST_BYTES} bytes"
            )));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(refused(SourceCompileErrorCode::ManifestMissing)(anyhow!(
                "{INTAR_MANIFEST_FILE} is missing from the repository root"
            )));
        }
        Err(error) => {
            return Err(refused(SourceCompileErrorCode::CompileFailed)(
                anyhow::Error::new(error).context(format!("failed to stat {INTAR_MANIFEST_FILE}")),
            ));
        }
    }
    let manifest = fs::read_to_string(&path)
        .map_err(anyhow::Error::new)
        .and_then(|yaml| parse_strict_yaml::<IntarManifestV1>(&yaml, MAX_MANIFEST_BYTES))
        .with_context(|| format!("invalid {INTAR_MANIFEST_FILE}"))
        .map_err(invalid)?;
    if manifest.version != 1 {
        return Err(invalid(anyhow!(
            "unsupported {INTAR_MANIFEST_FILE} version {} (expected 1)",
            manifest.version
        )));
    }
    validate_safe_cli_slug("intar.yaml scope", &manifest.scope).map_err(invalid)?;
    let components = manifest.courses_root.split('/').collect::<Vec<_>>();
    if components.len() > MAX_COURSES_ROOT_COMPONENTS
        || components
            .iter()
            .any(|component| validate_safe_cli_slug("component", component).is_err())
    {
        return Err(invalid(anyhow!(
            "courses_root '{}' must be a relative path of 1 to {MAX_COURSES_ROOT_COMPONENTS} [A-Za-z0-9._-] components other than '.' and '..'",
            manifest.courses_root
        )));
    }
    Ok(manifest)
}

/// Refuses a submodule that overlaps the courses root: repository archives
/// hold only an empty directory at a submodule's path.
fn reject_submodules(root: &Path, courses_root: &str) -> Result<(), SourceCompileError> {
    let failed = refused(SourceCompileErrorCode::CompileFailed);
    let path = root.join(GITMODULES_FILE);
    if matches!(fs::symlink_metadata(&path), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
    {
        return Ok(());
    }
    require_regular_file(&path, GITMODULES_FILE).map_err(failed)?;
    let gitmodules = fs::read_to_string(&path)
        .with_context(|| format!("failed to read {GITMODULES_FILE}"))
        .map_err(failed)?;
    let within = |path: &str, dir: &str| {
        path.strip_prefix(dir)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    };
    for line in gitmodules.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        // Git ends a value at an unquoted `#` or `;` and drops its quotes.
        let mut quoted = false;
        let submodule = value
            .chars()
            .take_while(|&c| {
                quoted ^= c == '"';
                quoted || !matches!(c, '#' | ';')
            })
            .filter(|&c| c != '"')
            .collect::<String>();
        let submodule = submodule.trim().trim_end_matches('/');
        if key.trim().eq_ignore_ascii_case("path")
            && (within(submodule, courses_root) || within(courses_root, submodule))
        {
            return Err(refused(SourceCompileErrorCode::SubmoduleUnsupported)(
                anyhow!("submodule '{submodule}' overlaps courses_root '{courses_root}'"),
            ));
        }
    }
    Ok(())
}

/// Resolves the courses root without following a symlink on the way.
fn resolve_courses_root(root: &Path, courses_root: &str) -> Result<PathBuf, SourceCompileError> {
    let mut path = root.to_path_buf();
    for component in courses_root.split('/') {
        path.push(component);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_dir() => {}
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err(refused(SourceCompileErrorCode::CompileFailed)(
                    anyhow::Error::new(error)
                        .context(format!("failed to stat courses_root '{courses_root}'")),
                ));
            }
            _ => {
                return Err(refused(SourceCompileErrorCode::CoursesRootMissing)(
                    anyhow!("courses_root '{courses_root}' is not a directory in the repository"),
                ));
            }
        }
    }
    Ok(path)
}

fn find_lfs_pointer(dir: &Path) -> Result<Option<PathBuf>> {
    for entry in sorted_directory_entries(dir)? {
        let path = entry.path();
        let file_type = entry
            .file_type()
            .with_context(|| format!("failed to stat '{}'", path.display()))?;
        if file_type.is_dir() {
            if let Some(pointer) = find_lfs_pointer(&path)? {
                return Ok(Some(pointer));
            }
        } else if file_type.is_file() {
            let mut head = Vec::new();
            fs::File::open(&path)
                .and_then(|file| {
                    file.take(LFS_POINTER_LINE.len() as u64 + 2)
                        .read_to_end(&mut head)
                })
                .with_context(|| format!("failed to read {}", path.display()))?;
            let line = head.split(|byte| *byte == b'\n').next().unwrap_or_default();
            if line.strip_suffix(b"\r").unwrap_or(line) == LFS_POINTER_LINE {
                return Ok(Some(path));
            }
        }
    }
    Ok(None)
}

fn compile_curriculum(
    curriculum: &CurriculumSource,
    contract_arch: &str,
    input: &CompileBundleInput<'_>,
    max_tar_bytes: u64,
) -> Result<CompiledBundle> {
    let selected_sources = selected_course_scenarios(curriculum, input.scenario)?;
    let base_catalog = (!curriculum.scenarios.is_empty())
        .then(|| load_base_image_catalog(input.base_images))
        .transpose()?;

    if let Some(base_catalog) = &base_catalog {
        for source in &curriculum.scenarios {
            let scenario = load_course_scenario(&source.scenario_path)?;
            validate_scenario(&scenario, base_catalog, None, input.target_arch)?;
        }
    }

    let mut prepared_scenarios = Vec::new();
    for source in selected_sources {
        let scenario = load_course_scenario(&source.scenario_path)?;
        let base_catalog = base_catalog
            .as_ref()
            .context("scenario bundle is missing a base image catalog")?;
        let base_definition =
            scenario_base_definition_identity(&scenario, base_catalog, input.target_arch)?;
        let content_hash = scenario_content_hash(&ScenarioContentHashInput {
            scenario_id: &scenario.name,
            scenario_dir: &source.scenario_dir,
            base_definition: &base_definition,
            target_arch: input.target_arch,
        })?;
        prepared_scenarios.push(PreparedBundleScenario {
            scenario_id: scenario.name,
            scenario_dir: source.scenario_dir,
            content_hash,
        });
    }

    let compiled_catalog = tempfile::tempdir().context("create compiled curriculum directory")?;
    let compiled_catalog_path = compiled_catalog.path().join("catalog.json");
    fs::write(
        &compiled_catalog_path,
        serde_json::to_vec(&curriculum.catalog).context("serialize curriculum catalog")?,
    )
    .with_context(|| format!("write {}", compiled_catalog_path.display()))?;
    let source_files = collect_bundle_source_files(
        &prepared_scenarios,
        base_catalog.as_ref().map(|_| input.base_images),
        curriculum,
        &compiled_catalog_path,
    )?;
    let archive = write_bundle_archive(&source_files, max_tar_bytes)?;

    let scenarios_meta = prepared_scenarios
        .iter()
        .map(|scenario| {
            serde_json::json!({
                "scenario_id": scenario.scenario_id,
                "arch": contract_arch,
                "content_hash": scenario.content_hash,
            })
        })
        .collect::<Vec<_>>();
    let mut meta = serde_json::json!({
        "rev": input.rev,
        "guest_bootstrap_abi": intar_contracts::catalog::GUEST_BOOTSTRAP_ABI_V2,
        "build_format_version": BUILD_FORMAT_VERSION,
        "catalog_channel": "candidate",
        "target_arch": input.target_arch,
        "scenarios": scenarios_meta,
    });
    meta["course_catalog"] = serde_json::to_value(&curriculum.catalog)?;

    Ok(CompiledBundle {
        archive,
        meta,
        scenario_count: prepared_scenarios.len(),
        file_count: source_files.len(),
    })
}

pub fn load_curriculum(courses_root: &Path) -> Result<CurriculumSource> {
    load_curriculum_tree(courses_root, false)
}

fn load_curriculum_tree(courses_root: &Path, allow_keep: bool) -> Result<CurriculumSource> {
    require_real_directory(courses_root, "courses directory")?;

    let mut courses = Vec::new();
    let mut catalog_courses = Vec::new();
    let mut scenarios = Vec::new();
    let mut scenario_ids = HashSet::new();

    for entry in sorted_directory_entries(courses_root)? {
        let course_path = entry.path();
        let file_type = entry
            .file_type()
            .with_context(|| format!("failed to stat '{}'", course_path.display()))?;
        if file_type.is_symlink() {
            bail!(
                "symlink is not allowed in course sources: {}",
                course_path.display()
            );
        }
        if allow_keep && file_type.is_file() && entry.file_name() == OsStr::new(KEEP_FILE) {
            continue;
        }
        if !file_type.is_dir() {
            bail!(
                "courses directory contains unexpected file: {}",
                course_path.display()
            );
        }

        let course_id = source_id("course", entry.file_name(), &course_path)?;
        reject_symlinks_recursively(&course_path)?;
        let course_markdown_path = course_path.join(COURSE_MARKDOWN_FILE);
        require_regular_file(&course_markdown_path, "course markdown")?;
        let (course_frontmatter, body_markdown) =
            parse_markdown::<CourseFrontmatter>(&course_markdown_path, "course")?;
        let course_title = required_text("course title", course_frontmatter.title)?;
        let course_summary = required_text("course summary", course_frontmatter.summary)?;

        let mut lectures = Vec::new();
        let mut support_files = Vec::new();
        let mut catalog_lectures = Vec::new();
        for lecture_entry in sorted_directory_entries(&course_path)? {
            let lecture_path = lecture_entry.path();
            let file_type = lecture_entry
                .file_type()
                .with_context(|| format!("failed to stat '{}'", lecture_path.display()))?;
            if lecture_entry.file_name() == OsStr::new(COURSE_MARKDOWN_FILE) {
                continue;
            }
            if file_type.is_symlink() {
                bail!(
                    "symlink is not allowed in course sources: {}",
                    lecture_path.display()
                );
            }
            if !file_type.is_dir() {
                if lecture_entry.file_name() == OsStr::new(SCENARIO_HCL_FILE) {
                    bail!(
                        "course '{}' has scenario.hcl outside a lecture directory",
                        course_id
                    );
                }
                if !file_type.is_file() {
                    bail!(
                        "course '{}' contains unsupported source: {}",
                        course_id,
                        lecture_path.display()
                    );
                }
                support_files.push(lecture_path);
                continue;
            }

            let lecture_id = source_id("lecture", lecture_entry.file_name(), &lecture_path)?;
            let lecture_markdown_path = lecture_path.join(LECTURE_MARKDOWN_FILE);
            require_regular_file(&lecture_markdown_path, "lecture markdown")?;
            let (lecture_frontmatter, body_markdown) =
                parse_markdown::<LectureFrontmatter>(&lecture_markdown_path, "lecture")?;
            let title = required_text("lecture title", lecture_frontmatter.title)?;
            let summary = required_text("lecture summary", lecture_frontmatter.summary)?;
            let category = required_text("lecture category", lecture_frontmatter.category)?;
            let tags = required_tags(lecture_frontmatter.tags)?;
            if lecture_frontmatter.estimated_minutes == 0 {
                bail!("lecture estimated_minutes must be greater than zero");
            }

            let scenario_path = lecture_path.join(SCENARIO_HCL_FILE);
            let scenario_is_present = match fs::symlink_metadata(&scenario_path) {
                Ok(_) => true,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
                Err(error) => {
                    return Err(error)
                        .with_context(|| format!("failed to stat {}", scenario_path.display()));
                }
            };
            let scenario_id = if scenario_is_present {
                require_regular_file(&scenario_path, "scenario source")?;
                let scenario = Scenario::from_course_file(&scenario_path).with_context(|| {
                    format!(
                        "failed to load course scenario from {}",
                        scenario_path.display()
                    )
                })?;
                if lecture_frontmatter.difficulty.is_none() {
                    bail!(
                        "lecture '{}:{}' requires difficulty when it has scenario.hcl",
                        course_id,
                        lecture_id
                    );
                }
                validate_safe_cli_slug("scenario id", &scenario.name)?;
                if !scenario_ids.insert(scenario.name.clone()) {
                    bail!("duplicate scenario ID '{}'", scenario.name);
                }
                scenarios.push(CourseScenario {
                    scenario_id: scenario.name.clone(),
                    scenario_path,
                    scenario_dir: lecture_path.clone(),
                    lecture: CourseCatalogLectureV2 {
                        lecture_id: lecture_id.clone(),
                        title: title.clone(),
                        summary: summary.clone(),
                        body_markdown: body_markdown.clone(),
                        category: category.clone(),
                        tags: tags.clone(),
                        difficulty: lecture_frontmatter.difficulty.clone(),
                        estimated_minutes: lecture_frontmatter.estimated_minutes,
                        scenario_id: Some(scenario.name.clone()),
                    },
                });
                Some(scenario.name)
            } else {
                None
            };

            catalog_lectures.push(CourseCatalogLectureV2 {
                lecture_id: lecture_id.clone(),
                title,
                summary,
                body_markdown,
                category,
                tags,
                difficulty: lecture_frontmatter.difficulty,
                estimated_minutes: lecture_frontmatter.estimated_minutes,
                scenario_id,
            });
            lectures.push(LectureSource {
                lecture_id,
                lecture_markdown_path,
            });
        }

        if catalog_lectures.is_empty() {
            bail!("course '{}' must contain at least one lecture", course_id);
        }
        catalog_courses.push(CourseCatalogCourseV2 {
            course_id: course_id.clone(),
            title: course_title,
            summary: course_summary,
            body_markdown,
            sequential: course_frontmatter.sequential,
            lectures: catalog_lectures,
        });
        courses.push(CourseSource {
            course_id,
            course_markdown_path,
            support_files,
            lectures,
        });
    }

    Ok(CurriculumSource {
        catalog: CourseCatalogSnapshotV2 {
            version: 2,
            courses: catalog_courses,
        },
        courses,
        scenarios,
    })
}

pub fn selected_course_scenarios(
    curriculum: &CurriculumSource,
    scenario_id: Option<&str>,
) -> Result<Vec<CourseScenario>> {
    if let Some(scenario_id) = scenario_id {
        validate_safe_cli_slug("scenario", scenario_id)?;
        let scenario = curriculum
            .scenarios
            .iter()
            .find(|scenario| scenario.scenario_id == scenario_id)
            .cloned()
            .with_context(|| format!("scenario '{scenario_id}' is not in the curriculum"))?;
        return Ok(vec![scenario]);
    }
    Ok(curriculum.scenarios.clone())
}

fn parse_markdown<T>(path: &Path, label: &str) -> Result<(T, String)>
where
    T: DeserializeOwned,
{
    let markdown = fs::read_to_string(path)
        .with_context(|| format!("failed to read {label} markdown from {}", path.display()))?;
    let (frontmatter, body_markdown) = split_frontmatter(&markdown)
        .with_context(|| format!("{label} markdown '{}'", path.display()))?;
    if frontmatter.len() > MAX_FRONTMATTER_BYTES {
        bail!(
            "{label} frontmatter in '{}' exceeds {MAX_FRONTMATTER_BYTES} bytes",
            path.display()
        );
    }
    if body_markdown.trim().is_empty() {
        bail!("{label} markdown '{}' has an empty body", path.display());
    }
    let value = parse_strict_yaml(frontmatter, MAX_FRONTMATTER_BYTES)
        .map_err(|error| anyhow!("invalid YAML frontmatter: {error}"))?;
    Ok((value, body_markdown.to_owned()))
}

fn parse_strict_yaml<T: DeserializeOwned>(yaml: &str, max_bytes: usize) -> Result<T> {
    let options = serde_saphyr::options! {
        budget: serde_saphyr::budget! {
            max_documents: 1,
            max_events: 512,
            max_nodes: 128,
            max_depth: 16,
            max_total_scalar_bytes: max_bytes,
            max_reader_input_bytes: Some(max_bytes),
        },
        duplicate_keys: DuplicateKeyPolicy::Error,
        merge_keys: MergeKeyPolicy::Error,
        strict_booleans: true,
    };
    serde_saphyr::from_str_with_options(yaml, options).map_err(|error| anyhow!("{error}"))
}

fn split_frontmatter(markdown: &str) -> Result<(&str, &str)> {
    let (first, mut offset) = next_line(markdown, 0).ok_or_else(|| anyhow!("is empty"))?;
    if first != "---" {
        bail!("must start with a YAML frontmatter delimiter");
    }
    let frontmatter_start = offset;
    while let Some((line, next_offset)) = next_line(markdown, offset) {
        if line == "---" {
            let frontmatter_end = offset;
            return Ok((
                &markdown[frontmatter_start..frontmatter_end],
                &markdown[next_offset..],
            ));
        }
        offset = next_offset;
    }
    bail!("has no closing YAML frontmatter delimiter")
}

fn next_line(value: &str, offset: usize) -> Option<(&str, usize)> {
    if offset >= value.len() {
        return None;
    }
    let rest = &value[offset..];
    let line_end = rest.find('\n').map_or(value.len(), |index| offset + index);
    let line = value[offset..line_end]
        .strip_suffix('\r')
        .unwrap_or(&value[offset..line_end]);
    Some((line, line_end.saturating_add(1).min(value.len())))
}

fn required_text(label: &str, value: String) -> Result<String> {
    let value = value.trim().to_owned();
    if value.is_empty() {
        bail!("{label} must not be empty");
    }
    Ok(value)
}

fn required_tags(tags: Vec<String>) -> Result<Vec<String>> {
    let mut seen = HashSet::new();
    tags.into_iter()
        .map(|tag| required_text("lecture tag", tag))
        .map(|tag| {
            let tag = tag?;
            if !seen.insert(tag.clone()) {
                bail!("lecture has duplicate tag '{tag}'");
            }
            Ok(tag)
        })
        .collect()
}

fn source_id(label: &str, value: std::ffi::OsString, path: &Path) -> Result<String> {
    let value = value
        .to_str()
        .with_context(|| {
            format!(
                "{label} directory name is not valid UTF-8: {}",
                path.display()
            )
        })?
        .to_owned();
    validate_safe_cli_slug(label, &value)
        .with_context(|| format!("{label} ID in {} is not a safe slug", path.display()))?;
    Ok(value)
}

fn require_real_directory(path: &Path, label: &str) -> Result<()> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("{label} '{}' does not exist", path.display()))?;
    if metadata.file_type().is_symlink() {
        bail!("{label} '{}' must not be a symlink", path.display());
    }
    if !metadata.is_dir() {
        bail!("{label} '{}' is not a directory", path.display());
    }
    Ok(())
}

fn require_regular_file(path: &Path, label: &str) -> Result<()> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("{label} '{}' does not exist", path.display()))?;
    if metadata.file_type().is_symlink() {
        bail!("{label} '{}' must not be a symlink", path.display());
    }
    if !metadata.is_file() {
        bail!("{label} '{}' is not a regular file", path.display());
    }
    Ok(())
}

fn sorted_directory_entries(path: &Path) -> Result<Vec<fs::DirEntry>> {
    let mut entries = fs::read_dir(path)
        .with_context(|| format!("failed to read {}", path.display()))?
        .collect::<std::result::Result<Vec<_>, _>>()
        .with_context(|| format!("failed to read {}", path.display()))?;
    entries.sort_by_key(fs::DirEntry::file_name);
    Ok(entries)
}

fn reject_symlinks_recursively(path: &Path) -> Result<()> {
    for entry in sorted_directory_entries(path)? {
        let entry_path = entry.path();
        let file_type = entry
            .file_type()
            .with_context(|| format!("failed to stat '{}'", entry_path.display()))?;
        if file_type.is_symlink() {
            bail!(
                "symlink is not allowed in course sources: {}",
                entry_path.display()
            );
        }
        if file_type.is_dir() {
            reject_symlinks_recursively(&entry_path)?;
        }
    }
    Ok(())
}

pub fn load_base_image_catalog(path: &Path) -> Result<BaseImageCatalog> {
    BaseImageCatalog::from_file(path)
        .with_context(|| format!("failed to load base image catalog from {}", path.display()))
}

pub fn scenario_base_definition_identity(
    scenario: &Scenario,
    base_catalog: &BaseImageCatalog,
    target_arch: &str,
) -> Result<String> {
    let mut definitions = BTreeMap::new();
    for image in scenario.images.values() {
        let base_image = base_catalog
            .base_image_by_name(&image.base)
            .with_context(|| format!("base image '{}' not found in catalog", image.base))?;
        let definition = base_image
            .definition_for_arch(target_arch)
            .with_context(|| {
                format!(
                    "base image '{}' has no {target_arch} OCI rootfs definition",
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

fn contract_image_arch_slug(target_arch: &str) -> Result<&'static str> {
    match target_arch.trim() {
        "amd64" | "x86_64" => Ok("x86_64"),
        "arm64" | "aarch64" => Ok("aarch64"),
        other => bail!("unsupported target arch '{other}' for bundle metadata"),
    }
}

pub fn validate_safe_cli_slug(label: &str, value: &str) -> Result<()> {
    if (1..=128).contains(&value.len())
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Ok(());
    }
    bail!("invalid {label} '{value}' (expected 1-128 safe slug characters)");
}

fn collect_bundle_source_files(
    scenarios: &[PreparedBundleScenario],
    base_images_path: Option<&Path>,
    curriculum: &CurriculumSource,
    compiled_catalog_path: &Path,
) -> Result<Vec<BundleSourceFile>> {
    let mut files = Vec::new();
    add_bundle_file(
        compiled_catalog_path,
        CURRICULUM_CATALOG_ARCHIVE_PATH,
        &mut files,
    )?;
    for course in &curriculum.courses {
        let course_archive_root = format!("{CURRICULUM_ARCHIVE_ROOT}/{}", course.course_id);
        add_bundle_file(
            &course.course_markdown_path,
            &format!("{course_archive_root}/course.md"),
            &mut files,
        )?;
        for support_file in &course.support_files {
            add_bundle_file(
                support_file,
                &format!(
                    "{course_archive_root}/{}",
                    archive_name(
                        support_file
                            .file_name()
                            .ok_or_else(|| anyhow!("support file has no name"))?
                    )?
                ),
                &mut files,
            )?;
        }
        for lecture in &course.lectures {
            add_bundle_file(
                &lecture.lecture_markdown_path,
                &format!("{course_archive_root}/{}/lecture.md", lecture.lecture_id),
                &mut files,
            )?;
        }
    }
    if let Some(base_images_path) = base_images_path {
        add_bundle_file(base_images_path, BUNDLE_BASE_IMAGES_PATH, &mut files)?;
    }

    for scenario in scenarios {
        collect_technical_bundle_dir(
            &scenario.scenario_dir,
            &format!("{BUNDLE_SCENARIOS_ROOT}/{}", scenario.scenario_id),
            &mut files,
        )?;
    }

    files.sort_by(|left, right| left.archive_path.cmp(&right.archive_path));
    Ok(files)
}

fn collect_technical_bundle_dir(
    source_dir: &Path,
    archive_root: &str,
    files: &mut Vec<BundleSourceFile>,
) -> Result<()> {
    let metadata = fs::symlink_metadata(source_dir)
        .with_context(|| format!("failed to stat '{}'", source_dir.display()))?;
    if metadata.file_type().is_symlink() {
        bail!(
            "symlink is not allowed in bundle sources: {}",
            source_dir.display()
        );
    }
    if !metadata.is_dir() {
        bail!(
            "bundle source directory '{}' does not exist",
            source_dir.display()
        );
    }

    for entry in fs::read_dir(source_dir)
        .with_context(|| format!("failed to read {}", source_dir.display()))?
    {
        let entry = entry.with_context(|| format!("failed to read {}", source_dir.display()))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .with_context(|| format!("failed to stat '{}'", path.display()))?;
        if file_type.is_symlink() {
            bail!(
                "symlink is not allowed in bundle sources: {}",
                path.display()
            );
        } else if file_type.is_dir() {
            collect_technical_bundle_dir(
                &path,
                &format!("{archive_root}/{}", archive_name(entry.file_name())?),
                files,
            )?;
        } else if file_type.is_file() {
            if entry.file_name() == OsStr::new("lecture.md") {
                continue;
            }
            let archive_path = format!("{archive_root}/{}", archive_name(entry.file_name())?);
            add_bundle_file(&path, &archive_path, files)?;
        } else {
            bail!("bundle source '{}' is not a regular file", path.display());
        }
    }
    Ok(())
}

fn add_bundle_file(
    source_path: &Path,
    archive_path: &str,
    files: &mut Vec<BundleSourceFile>,
) -> Result<()> {
    let metadata = fs::symlink_metadata(source_path)
        .with_context(|| format!("failed to stat {}", source_path.display()))?;
    if metadata.file_type().is_symlink() {
        bail!(
            "symlink is not allowed in bundle sources: {}",
            source_path.display()
        );
    }
    if !metadata.is_file() {
        bail!(
            "bundle source file '{}' does not exist",
            source_path.display()
        );
    }
    validate_archive_path(archive_path)?;
    files.push(BundleSourceFile {
        source_path: source_path.to_path_buf(),
        archive_path: archive_path.to_owned(),
    });
    Ok(())
}

fn archive_name(value: impl AsRef<OsStr>) -> Result<String> {
    let name = value
        .as_ref()
        .to_str()
        .ok_or_else(|| anyhow!("bundle archive path is not valid UTF-8"))?;
    validate_archive_component(name)?;
    Ok(name.to_owned())
}

fn validate_archive_path(path: &str) -> Result<()> {
    let path = Path::new(path);
    if path.is_absolute() {
        bail!("bundle archive path must be relative");
    }
    for component in path.components() {
        match component {
            Component::Normal(name) => {
                let name = name
                    .to_str()
                    .ok_or_else(|| anyhow!("bundle archive path is not valid UTF-8"))?;
                validate_archive_component(name)?;
            }
            _ => bail!("bundle archive path contains unsupported component"),
        }
    }
    Ok(())
}

fn validate_archive_component(component: &str) -> Result<()> {
    if component.is_empty() || component == "." || component == ".." || component.contains('/') {
        bail!("invalid bundle archive path component '{component}'");
    }
    Ok(())
}

fn write_bundle_archive(source_files: &[BundleSourceFile], max_tar_bytes: u64) -> Result<Vec<u8>> {
    if source_files.is_empty() {
        bail!("bundle archive requires at least one file");
    }
    let tar_bytes = bundle_tar_size_bytes(source_files)?;
    if tar_bytes > max_tar_bytes {
        return Err(BundleTooLarge {
            tar_bytes,
            max_tar_bytes,
        }
        .into());
    }

    let encoder = GzBuilder::new()
        .mtime(0)
        .write(Vec::new(), Compression::default());
    let mut builder = tar::Builder::new(encoder);
    let mut sorted_files = source_files.to_vec();
    sorted_files.sort_by(|left, right| left.archive_path.cmp(&right.archive_path));

    for source_file in sorted_files {
        let bytes = fs::read(&source_file.source_path)
            .with_context(|| format!("failed to read {}", source_file.source_path.display()))?;
        let archive_path = Path::new(&source_file.archive_path);
        let mut header = tar::Header::new_ustar();
        header.set_path(archive_path).with_context(|| {
            format!(
                "bundle archive path cannot be represented as USTAR: {}",
                source_file.archive_path
            )
        })?;
        header.set_size(bytes.len() as u64);
        header.set_mode(0o644);
        header.set_uid(0);
        header.set_gid(0);
        header.set_mtime(0);
        header.set_cksum();
        builder
            .append_data(&mut header, archive_path, Cursor::new(bytes))
            .with_context(|| {
                format!(
                    "failed to append {} to bundle archive",
                    source_file.archive_path
                )
            })?;
    }

    let encoder = builder
        .into_inner()
        .context("failed to finish tar bundle archive")?;
    encoder
        .finish()
        .context("failed to finish gzip bundle archive")
}

fn bundle_tar_size_bytes(source_files: &[BundleSourceFile]) -> Result<u64> {
    let mut total = TAR_BLOCK_SIZE * 2;
    for source_file in source_files {
        let size = fs::metadata(&source_file.source_path)
            .with_context(|| format!("failed to stat {}", source_file.source_path.display()))?
            .len();
        total = total
            .checked_add(TAR_BLOCK_SIZE)
            .and_then(|value| value.checked_add(padded_tar_entry_size(size)))
            .ok_or_else(|| anyhow!("bundle archive size overflow"))?;
    }
    Ok(total)
}

fn padded_tar_entry_size(size: u64) -> u64 {
    size.div_ceil(TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE
}

pub fn validate_scenario(
    scenario: &Scenario,
    base_catalog: &BaseImageCatalog,
    vm_filter: Option<&str>,
    target_arch: &str,
) -> Result<()> {
    scenario
        .validate_technical_for_builder_arch(target_arch)
        .with_context(|| format!("scenario '{}' failed validation", scenario.name))?;
    base_catalog
        .validate_for_builder_arch(target_arch)
        .with_context(|| format!("base image catalog failed validation for '{target_arch}'"))?;
    base_catalog
        .validate_scenario_for_builder_arch(scenario, target_arch)
        .with_context(|| format!("scenario '{}' base images failed validation", scenario.name))?;

    for vm_name in selected_vm_names(scenario, vm_filter)? {
        scenario
            .derive_kino_config_for_vm(&vm_name)
            .with_context(|| {
                format!(
                    "failed to derive kino config for {}:{}",
                    scenario.name, vm_name
                )
            })?;
    }

    Ok(())
}

pub fn selected_vm_names(scenario: &Scenario, vm_filter: Option<&str>) -> Result<Vec<String>> {
    if let Some(vm_name) = vm_filter {
        if scenario.vm_by_name(vm_name).is_none() {
            bail!("vm '{}' not found in scenario '{}'", vm_name, scenario.name);
        }
        return Ok(vec![vm_name.to_string()]);
    }

    Ok(scenario.vms.iter().map(|vm| vm.name.clone()).collect())
}

pub fn load_course_scenario(path: &Path) -> Result<Scenario> {
    Scenario::from_course_file(path)
        .with_context(|| format!("failed to load scenario from {}", path.display()))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::fs;
    use std::io::Read;

    use flate2::read::GzDecoder;
    use intar_contracts::source::{SOURCE_COMPILER_VERSION, SourceCompileErrorCode as Code};

    use super::{
        BUNDLE_BASE_IMAGES_PATH, CURRICULUM_CATALOG_ARCHIVE_PATH, CompileBundleInput,
        MAX_BUNDLE_TAR_BYTES, PreparedBundleScenario, collect_bundle_source_files, compile_bundle,
        compile_digest, compile_source_tree, compile_source_tree_with_catalog, load_curriculum,
        write_bundle_archive,
    };

    const REV: &str = "git-1-0123456789abcdef0123456789abcdef01234567-pe845f1ac";

    #[test]
    fn compile_source_tree_output_is_byte_stable() {
        // A fixed catalog keeps this golden on the compiler alone: a platform
        // catalog change already rotates the digest through its own sha256.
        let fixture =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/release-smoke");
        let compiled = compile_source_tree_with_catalog(
            &fixture,
            REV,
            "amd64",
            include_str!("../fixtures/release-smoke/base-images.hcl"),
        )
        .unwrap();
        let archive = crate::sha256_bytes_hex(&compiled.archive);
        let meta =
            crate::sha256_bytes_hex(serde_json::to_string(&compiled.meta).unwrap().as_bytes());

        assert_eq!(
            (archive.as_str(), meta.as_str()),
            (
                "a1420968b5dd17fe59ad1c274ead6576448da526039d7c97a4eaaf23e5d29390",
                "23371067a472ee9b3831110de14aed448af5202813481a24d93e9148738ee261"
            ),
            "the intar.yaml compile output changed. Bump SOURCE_COMPILER_VERSION in \
             intar-contracts (unless BUILD_FORMAT_VERSION changed), then replace these hashes"
        );
    }

    #[test]
    fn platform_compile_digest_matches_the_worker_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../apps/web/src/generated/fixtures/source/compile-digest.json"
        ))
        .unwrap();
        assert_eq!(
            serde_json::Value::from(compile_digest(
                fixture["base_images_sha256"].as_str().unwrap()
            )),
            fixture["digest"],
            "update the vector in intar-contracts-typegen and run `just generate-contracts`"
        );
    }

    #[test]
    fn refuses_invalid_intar_manifests() {
        let temp = tempfile::tempdir().unwrap();
        write_course(
            &temp.path().join("courses"),
            "linux",
            "01-theory",
            None,
            "Unit",
        );
        assert_eq!(source_refusal(temp.path()), Code::ManifestMissing);

        for manifest in [
            "version: 1\n",
            "version: 2\nscope: public\n",
            "version: 1\nscope: public\nmode: push\n",
            "version: 1\nscope: public\nscope: acme\n",
            "version: 1\nscope: ../acme\n",
            "version: 1\nscope: public\ncourses_root: ''\n",
            "version: 1\nscope: public\ncourses_root: courses/\n",
            "version: 1\nscope: public\ncourses_root: a//courses\n",
            "version: 1\nscope: public\ncourses_root: ./courses\n",
            "version: 1\nscope: public\ncourses_root: a/b/c/d/e/f/g/h/i\n",
            "[not a map]\n",
        ] {
            fs::write(temp.path().join("intar.yaml"), manifest).unwrap();
            assert_eq!(
                source_refusal(temp.path()),
                Code::ManifestInvalid,
                "{manifest}"
            );
        }

        fs::write(
            temp.path().join("intar.yaml"),
            "version: 1\nscope: public\ncourses_root: a/b/c/d/e/f/g/h\n",
        )
        .unwrap();
        assert_eq!(source_refusal(temp.path()), Code::CoursesRootMissing);
    }

    #[test]
    fn refuses_a_courses_root_outside_the_tree_before_reading_it() {
        let temp = tempfile::tempdir().unwrap();
        let tree = temp.path().join("tree");
        fs::create_dir_all(&tree).unwrap();
        write_course(&temp.path().join("x"), "linux", "01-theory", None, "Unit");
        write_course(&temp.path().join("etc"), "linux", "01-theory", None, "Unit");
        for courses_root in [temp.path().join("etc").display().to_string(), "../x".into()] {
            fs::write(
                tree.join("intar.yaml"),
                format!("version: 1\nscope: public\ncourses_root: {courses_root}\n"),
            )
            .unwrap();
            assert_eq!(
                source_refusal(&tree),
                Code::ManifestInvalid,
                "{courses_root}"
            );
        }

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(temp.path(), tree.join("link")).unwrap();
            fs::write(
                tree.join("intar.yaml"),
                "version: 1\nscope: public\ncourses_root: link/x\n",
            )
            .unwrap();
            assert_eq!(source_refusal(&tree), Code::CoursesRootMissing);
        }
    }

    #[test]
    fn compiles_keep_only_and_theory_only_trees_without_a_base_catalog() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("content/courses")).unwrap();
        fs::write(temp.path().join("content/courses/.keep"), "").unwrap();
        fs::write(
            temp.path().join("intar.yaml"),
            "version: 1\nscope: acme-x1y2z3\ncourses_root: content/courses\n",
        )
        .unwrap();
        let compiled = compile_source_tree(temp.path(), REV, "amd64").unwrap();
        assert_eq!(compiled.scenario_count, 0);
        assert_eq!(
            archive_paths(&compiled.archive),
            [CURRICULUM_CATALOG_ARCHIVE_PATH]
        );
        assert_eq!(
            compiled.meta["source"],
            serde_json::json!({
                "scope": "acme-x1y2z3",
                "courses_root": "content/courses",
                "compiler_version": SOURCE_COMPILER_VERSION,
            })
        );
        assert_eq!(
            compiled.meta["course_catalog"]["courses"],
            serde_json::json!([])
        );
        // A gitlink archives as an empty directory: only `.keep` means empty.
        fs::remove_file(temp.path().join("content/courses/.keep")).unwrap();
        assert_eq!(source_refusal(temp.path()), Code::CoursesRootMissing);

        write_course(
            &temp.path().join("content/courses"),
            "linux",
            "01-theory",
            None,
            "Unit",
        );
        let compiled = compile_source_tree(temp.path(), REV, "amd64").unwrap();
        let paths = archive_paths(&compiled.archive);
        assert!(paths.contains(&"curriculum/linux/01-theory/lecture.md".to_owned()));
        assert!(!paths.contains(&BUNDLE_BASE_IMAGES_PATH.to_owned()));
        assert_eq!(compiled.meta["scenarios"], serde_json::json!([]));
    }

    #[test]
    fn refuses_submodules_under_the_courses_root_and_lfs_pointers() {
        let temp = tempfile::tempdir().unwrap();
        write_source_tree(temp.path());
        fs::write(
            temp.path().join(".gitmodules"),
            "[submodule \"lib\"]\n\tpath = vendor/lib\n\turl = https://example.com/lib.git\n",
        )
        .unwrap();
        compile_source_tree(temp.path(), REV, "amd64").unwrap();

        for path in [
            "courses/linux/lib",
            "courses",
            "\"courses/x\"",
            "courses # vendored",
            "courses ; vendored course",
            "\"courses\"#x",
        ] {
            fs::write(
                temp.path().join(".gitmodules"),
                format!("[submodule \"lib\"]\n\tpath = {path}\n"),
            )
            .unwrap();
            assert_eq!(
                source_refusal(temp.path()),
                Code::SubmoduleUnsupported,
                "{path}"
            );
        }
        fs::write(
            temp.path().join("intar.yaml"),
            "version: 1\nscope: public\ncourses_root: courses/linux\n",
        )
        .unwrap();
        fs::write(temp.path().join(".gitmodules"), "\tPath = courses\n").unwrap();
        assert_eq!(source_refusal(temp.path()), Code::SubmoduleUnsupported);

        fs::remove_file(temp.path().join(".gitmodules")).unwrap();
        write_source_tree(temp.path());
        fs::write(
            temp.path().join("courses/linux/01-theory/diagram.png"),
            "version https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 1\n",
        )
        .unwrap();
        assert_eq!(source_refusal(temp.path()), Code::LfsUnsupported);
    }

    #[test]
    fn refuses_over_cap_source_bundles() {
        let temp = tempfile::tempdir().unwrap();
        write_source_tree(temp.path());
        let support_file = temp.path().join("courses/linux/data.bin");
        fs::write(&support_file, vec![b'x'; 5 * 1024 * 1024]).unwrap();
        let error = compile_source_tree(temp.path(), REV, "amd64").unwrap_err();
        assert_eq!(error.code, Code::BundleTooLarge);
        assert!(error.to_string().contains("would expand"), "{error}");

        let mut state = 0x2545_f491_4f6c_dd1d_u64;
        let noise = (0..3 * 1024 * 1024)
            .map(|_| {
                state = state
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1_442_695_040_888_963_407);
                state.to_be_bytes()[0]
            })
            .collect::<Vec<_>>();
        fs::write(&support_file, noise).unwrap();
        let error = compile_source_tree(temp.path(), REV, "amd64").unwrap_err();
        assert_eq!(error.code, Code::BundleTooLarge);
        assert!(error.to_string().contains("compressed"), "{error}");

        fs::remove_file(&support_file).unwrap();
        fs::write(
            temp.path().join("courses/linux/01-theory/lecture.md"),
            format!(
                "---\ntitle: Unit\nsummary: Lecture summary.\ncategory: linux\ntags: [linux]\nestimated_minutes: 5\n---\n\n{}\n",
                "x".repeat(1_600_000)
            ),
        )
        .unwrap();
        assert_eq!(source_refusal(temp.path()), Code::MetaTooLarge);

        let temp = tempfile::tempdir().unwrap();
        write_source_tree(temp.path());
        for index in 0..101 {
            write_course(
                &temp.path().join("courses"),
                "labs",
                &format!("lab-{index:03}"),
                Some(&format!("lab-{index:03}")),
                "Lab",
            );
        }
        assert_eq!(source_refusal(temp.path()), Code::TooManyScenarios);
    }

    fn write_source_tree(root: &std::path::Path) {
        fs::write(root.join("intar.yaml"), "version: 1\nscope: public\n").unwrap();
        write_course(&root.join("courses"), "linux", "01-theory", None, "Unit");
    }

    fn source_refusal(root: &std::path::Path) -> Code {
        compile_source_tree(root, REV, "amd64").unwrap_err().code
    }

    #[test]
    fn compiles_markdown_courses_in_directory_order() {
        let temp = tempfile::tempdir().unwrap();
        write_course(temp.path(), "02-linux", "02-processes", None, "Processes");
        write_course(
            temp.path(),
            "01-networking",
            "01-dns",
            Some("dns-repair"),
            "DNS",
        );

        let curriculum = load_curriculum(temp.path()).unwrap();
        assert_eq!(CURRICULUM_CATALOG_ARCHIVE_PATH, "curriculum/catalog.json");
        assert_eq!(curriculum.catalog.version, 2);
        assert_eq!(curriculum.catalog.courses[0].course_id, "01-networking");
        assert_eq!(curriculum.catalog.courses[1].course_id, "02-linux");
        assert_eq!(
            curriculum.catalog.courses[0].lectures[0].lecture_id,
            "01-dns"
        );
        assert_eq!(curriculum.scenarios[0].scenario_id, "dns-repair");
    }

    #[test]
    fn accepts_a_pure_lecture_before_a_scenario_and_requires_difficulty() {
        let temp = tempfile::tempdir().unwrap();
        write_course(temp.path(), "course", "01-theory", None, "Theory");
        write_course(temp.path(), "course", "02-lab", Some("lab"), "Lab");
        let curriculum = load_curriculum(temp.path()).unwrap();
        assert_eq!(curriculum.catalog.courses[0].lectures.len(), 2);
        assert_eq!(
            curriculum.catalog.courses[0].lectures[0].lecture_id,
            "01-theory"
        );
        assert!(
            curriculum.catalog.courses[0].lectures[0]
                .difficulty
                .is_none()
        );
        assert_eq!(curriculum.catalog.courses[0].lectures[0].scenario_id, None);
        assert_eq!(curriculum.scenarios[0].scenario_id, "lab");

        let lecture_path = temp.path().join("course/02-lab/lecture.md");
        fs::write(
            lecture_path,
            "---\ntitle: Lab\nsummary: Practice it.\ncategory: linux\ntags: [linux]\nestimated_minutes: 5\n---\n\nTheory.\n",
        )
        .unwrap();
        let error = load_curriculum(temp.path()).unwrap_err();
        assert!(format!("{error:#}").contains("requires difficulty"));
    }

    #[test]
    fn rejects_invalid_frontmatter_and_orphan_scenarios() {
        let temp = tempfile::tempdir().unwrap();
        let course = temp.path().join("course");
        fs::create_dir_all(&course).unwrap();
        fs::write(
            course.join("course.md"),
            "---\ntitle: Course\nsummary: Summary\nsequential: yes\n---\n\nBody.\n",
        )
        .unwrap();
        let error = load_curriculum(temp.path()).unwrap_err();
        assert!(format!("{error:#}").contains("invalid YAML frontmatter"));

        fs::write(
            course.join("course.md"),
            "---\ntitle: Course\nsummary: Summary\nsequential: true\n---\n\nBody.\n",
        )
        .unwrap();
        let lecture = course.join("01-lab");
        fs::create_dir_all(&lecture).unwrap();
        fs::write(lecture.join("scenario.hcl"), scenario_hcl("lab")).unwrap();
        let error = load_curriculum(temp.path()).unwrap_err();
        assert!(format!("{error:#}").contains("lecture markdown"));
    }

    #[test]
    fn rejects_unknown_duplicate_and_merged_frontmatter_fields() {
        let temp = tempfile::tempdir().unwrap();
        write_course(temp.path(), "course", "01-theory", None, "Theory");
        let course_markdown = temp.path().join("course/course.md");
        for (markdown, expected) in [
            (
                "---\ntitle: Course\nsummary: Summary\nsequential: true\nextra: no\n---\n\nBody.\n",
                "unknown field",
            ),
            (
                "---\ntitle: Course\ntitle: Duplicate\nsummary: Summary\nsequential: true\n---\n\nBody.\n",
                "duplicate",
            ),
            (
                "---\ntitle: Course\nsummary: Summary\nsequential: true\n<<: {title: Other}\n---\n\nBody.\n",
                "merge",
            ),
        ] {
            fs::write(&course_markdown, markdown).unwrap();
            let error = load_curriculum(temp.path()).unwrap_err();
            assert!(
                format!("{error:#}").to_lowercase().contains(expected),
                "expected {expected:?}, got {error:#}"
            );
        }
    }

    #[test]
    fn rejects_duplicate_global_scenario_ids_and_course_hcl_presentation() {
        let temp = tempfile::tempdir().unwrap();
        write_course(temp.path(), "course-a", "01-lab", Some("shared"), "Lab A");
        write_course(temp.path(), "course-b", "99-other", Some("shared"), "Lab B");
        let error = load_curriculum(temp.path()).unwrap_err();
        assert!(format!("{error:#}").contains("duplicate scenario ID 'shared'"));

        let scenario_path = temp.path().join("course-a/01-lab/scenario.hcl");
        fs::write(
            scenario_path,
            scenario_hcl("shared")
                .replace("  solution", "  title = \"Not allowed here\"\n  solution"),
        )
        .unwrap();
        fs::remove_dir_all(temp.path().join("course-b")).unwrap();
        let error = load_curriculum(temp.path()).unwrap_err();
        assert!(format!("{error:#}").contains("course-mode scenario must not define title"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_course_sources() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        write_course(temp.path(), "course", "01-theory", None, "Theory");
        let target = temp.path().join("target.md");
        fs::write(&target, "target\n").unwrap();
        let lecture = temp.path().join("course/01-theory/lecture.md");
        fs::remove_file(&lecture).unwrap();
        symlink(&target, &lecture).unwrap();

        let error = load_curriculum(temp.path()).unwrap_err();
        assert!(format!("{error:#}").contains("symlink"));
    }

    #[test]
    fn compile_bundle_output_is_byte_stable() {
        // Captured with intar-image-cli 0.8.2 over the release smoke fixture.
        // Every bundle the registry receives changes with this output, so a
        // mismatch must be a deliberate format change. After a deliberate
        // BUILD_FORMAT_VERSION or GUEST_BOOTSTRAP_ABI bump, replace
        // fixtures/release-smoke/meta.json with the assertion's left value
        // (unescaped from its Debug form); the archive sha256 must still match.
        let fixture =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/release-smoke");
        let compiled = compile_bundle(&CompileBundleInput {
            courses_root: &fixture.join("courses"),
            base_images: &fixture.join("base-images.hcl"),
            rev: "release-smoke",
            target_arch: "amd64",
            scenario: None,
        })
        .unwrap();

        assert_eq!((compiled.scenario_count, compiled.file_count), (1, 6));
        assert_eq!(
            crate::sha256_bytes_hex(&compiled.archive),
            "a1420968b5dd17fe59ad1c274ead6576448da526039d7c97a4eaaf23e5d29390"
        );
        assert_eq!(
            serde_json::to_string(&compiled.meta).unwrap(),
            include_str!("../fixtures/release-smoke/meta.json").trim_end()
        );
    }

    #[test]
    fn content_only_bundle_archives_the_compiled_curriculum() {
        let temp = tempfile::tempdir().unwrap();
        write_course(temp.path(), "linux", "01-theory", None, "Unit");
        fs::write(
            temp.path().join("linux/UPSTREAM-LICENSE.md"),
            "License text\n",
        )
        .unwrap();
        let curriculum = load_curriculum(temp.path()).unwrap();
        let catalog_path = write_compiled_catalog(temp.path(), &curriculum.catalog);

        let files = collect_bundle_source_files(&[], None, &curriculum, &catalog_path).unwrap();
        let paths = files
            .iter()
            .map(|file| file.archive_path.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            paths,
            vec![
                CURRICULUM_CATALOG_ARCHIVE_PATH,
                "curriculum/linux/01-theory/lecture.md",
                "curriculum/linux/UPSTREAM-LICENSE.md",
                "curriculum/linux/course.md",
            ]
        );

        let archive = write_bundle_archive(&files, MAX_BUNDLE_TAR_BYTES).unwrap();
        assert_eq!(archive_paths(&archive), paths);
    }

    #[test]
    fn long_curriculum_paths_use_ustar_headers_without_extensions() {
        let temp = tempfile::tempdir().unwrap();
        let course_id = format!("course-{}", "a".repeat(53));
        let lecture_id = format!("lecture-{}", "b".repeat(52));
        write_course(temp.path(), &course_id, &lecture_id, None, "Unit");
        let curriculum = load_curriculum(temp.path()).unwrap();
        let catalog_path = write_compiled_catalog(temp.path(), &curriculum.catalog);
        let files = collect_bundle_source_files(&[], None, &curriculum, &catalog_path).unwrap();
        let expected_paths = files
            .iter()
            .map(|file| file.archive_path.clone())
            .collect::<Vec<_>>();
        let long_lecture_path = format!("curriculum/{course_id}/{lecture_id}/lecture.md");
        assert!(long_lecture_path.len() > 100);

        let archive = write_bundle_archive(&files, MAX_BUNDLE_TAR_BYTES).unwrap();

        let mut decoder = GzDecoder::new(archive.as_slice());
        let mut tar_bytes = Vec::new();
        decoder.read_to_end(&mut tar_bytes).unwrap();
        assert!(
            !tar_bytes
                .windows(b"././@LongLink".len())
                .any(|window| window == b"././@LongLink")
        );
        assert_eq!(archive_paths(&archive), expected_paths);
    }

    #[test]
    fn archives_technical_assets_without_lecture_markdown() {
        let temp = tempfile::tempdir().unwrap();
        write_course(
            temp.path(),
            "linux",
            "01-nginx",
            Some("repair-nginx"),
            "Unit",
        );
        let lecture_dir = temp.path().join("linux/01-nginx");
        fs::create_dir_all(lecture_dir.join("assets")).unwrap();
        fs::write(lecture_dir.join("assets/setup.sh"), "#!/bin/sh\n").unwrap();
        let curriculum = load_curriculum(temp.path()).unwrap();
        let catalog_path = write_compiled_catalog(temp.path(), &curriculum.catalog);
        let base_images = temp.path().join("base-images.hcl");
        fs::write(&base_images, "base images\n").unwrap();

        let scenario = &curriculum.scenarios[0];
        let files = collect_bundle_source_files(
            &[PreparedBundleScenario {
                scenario_id: scenario.scenario_id.clone(),
                scenario_dir: scenario.scenario_dir.clone(),
                content_hash: "unused".to_string(),
            }],
            Some(&base_images),
            &curriculum,
            &catalog_path,
        )
        .unwrap();
        let paths = files
            .iter()
            .map(|file| file.archive_path.as_str())
            .collect::<Vec<_>>();
        assert!(paths.contains(&BUNDLE_BASE_IMAGES_PATH));
        assert!(paths.contains(&"scenarios/repair-nginx/scenario.hcl"));
        assert!(paths.contains(&"scenarios/repair-nginx/assets/setup.sh"));
        assert!(paths.contains(&"curriculum/linux/01-nginx/lecture.md"));
        assert!(!paths.contains(&"scenarios/repair-nginx/lecture.md"));
    }

    fn write_compiled_catalog(
        root: &std::path::Path,
        catalog: &intar_contracts::catalog::CourseCatalogSnapshotV2,
    ) -> std::path::PathBuf {
        let path = root.join("catalog.json");
        fs::write(&path, serde_json::to_vec(catalog).unwrap()).unwrap();
        path
    }

    fn archive_paths(archive: &[u8]) -> Vec<String> {
        let mut archive = tar::Archive::new(GzDecoder::new(archive));
        archive
            .entries()
            .unwrap()
            .map(|entry| {
                let mut entry = entry.unwrap();
                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes).unwrap();
                entry.path().unwrap().to_string_lossy().into_owned()
            })
            .collect()
    }

    fn write_course(
        root: &std::path::Path,
        course_id: &str,
        lecture_id: &str,
        scenario_id: Option<&str>,
        title: &str,
    ) {
        let course = root.join(course_id);
        fs::create_dir_all(course.join(lecture_id)).unwrap();
        fs::write(
            course.join("course.md"),
            "---\ntitle: Course\nsummary: Course summary.\nsequential: true\n---\n\nCourse body.\n",
        )
        .unwrap();
        let difficulty = scenario_id.map_or(String::new(), |_| "difficulty: easy\n".to_string());
        fs::write(
            course.join(lecture_id).join("lecture.md"),
            format!(
                "---\ntitle: {title}\nsummary: Lecture summary.\ncategory: linux\ntags: [linux]\n{difficulty}estimated_minutes: 5\n---\n\nLecture body.\n"
            ),
        )
        .unwrap();
        if let Some(scenario_id) = scenario_id {
            fs::write(
                course.join(lecture_id).join("scenario.hcl"),
                scenario_hcl(scenario_id),
            )
            .unwrap();
        }
    }

    fn scenario_hcl(scenario_id: &str) -> String {
        format!(
            r#"
scenario "{scenario_id}" {{
  solution {{ body = "Solve it." }}
  image "debian" {{ base = "trixie" }}
  kino {{
    probe "ready" {{
      kind = "service"
      service = "ssh"
      state = "running"
      description = "SSH is running"
    }}
  }}
  vm "vm" {{
    image = "debian"
    probes = ["ready"]
  }}
}}
"#
        )
    }
}
