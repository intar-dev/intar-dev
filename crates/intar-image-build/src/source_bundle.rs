//! Scenario bundle compilation shared by intar-image-cli and intar-builder.
//!
//! It loads the Markdown curriculum, validates each course scenario against
//! the base image catalog, and assembles the deterministic bundle archive and
//! its upload metadata.

use std::collections::{BTreeMap, HashSet};
use std::ffi::OsStr;
use std::fs;
use std::io::Cursor;
use std::path::{Component, Path, PathBuf};

use anyhow::{Context as _, Result, anyhow, bail};
use flate2::{Compression, GzBuilder};
use intar_contracts::catalog::{
    CourseCatalogCourseV2, CourseCatalogLectureV2, CourseCatalogSnapshotV2, ScenarioDifficulty,
};
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
    let selected_sources = selected_course_scenarios(&curriculum, input.scenario)?;
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
        &curriculum,
        &compiled_catalog_path,
    )?;
    let archive = write_bundle_archive(&source_files)?;

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
    let options = serde_saphyr::options! {
        budget: serde_saphyr::budget! {
            max_documents: 1,
            max_events: 512,
            max_nodes: 128,
            max_depth: 16,
            max_total_scalar_bytes: MAX_FRONTMATTER_BYTES,
            max_reader_input_bytes: Some(MAX_FRONTMATTER_BYTES),
        },
        duplicate_keys: DuplicateKeyPolicy::Error,
        merge_keys: MergeKeyPolicy::Error,
        strict_booleans: true,
    };
    let value = serde_saphyr::from_str_with_options(frontmatter, options)
        .map_err(|error| anyhow!("invalid YAML frontmatter: {error}"))?;
    Ok((value, body_markdown.to_owned()))
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

fn write_bundle_archive(source_files: &[BundleSourceFile]) -> Result<Vec<u8>> {
    if source_files.is_empty() {
        bail!("bundle archive requires at least one file");
    }
    let tar_bytes = bundle_tar_size_bytes(source_files)?;
    if tar_bytes > MAX_BUNDLE_TAR_BYTES {
        bail!(
            "bundle archive would expand to {tar_bytes} bytes, exceeding the {MAX_BUNDLE_TAR_BYTES} byte limit"
        );
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

    use super::{
        BUNDLE_BASE_IMAGES_PATH, CURRICULUM_CATALOG_ARCHIVE_PATH, CompileBundleInput,
        PreparedBundleScenario, collect_bundle_source_files, compile_bundle, load_curriculum,
        write_bundle_archive,
    };

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
        // mismatch must be a deliberate format change.
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

        let archive = write_bundle_archive(&files).unwrap();
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

        let archive = write_bundle_archive(&files).unwrap();

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
