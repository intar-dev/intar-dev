//! The course catalog: `courses/<course>/course.md` and
//! `courses/<course>/<lecture>/lecture.md`, Markdown with YAML frontmatter.
//! A lecture links a scenario of the same repository with `scenario: <slug>`.

use super::Diagnostic;
use intar_contracts::catalog::{
    CourseCatalogCourseV2, CourseCatalogLectureV2, CourseCatalogSnapshotV2, ScenarioDifficulty,
};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_saphyr::{DuplicateKeyPolicy, MergeKeyPolicy};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

const MAX_FRONTMATTER_BYTES: usize = 64 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CourseFrontmatter {
    title: String,
    summary: String,
    sequential: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LectureFrontmatter {
    title: String,
    summary: String,
    category: String,
    tags: Vec<String>,
    difficulty: Option<ScenarioDifficulty>,
    estimated_minutes: u32,
    /// The slug of a scenario in this repository.
    scenario: Option<String>,
}

fn problem(path: &Path, line: usize, message: impl Into<String>) -> Diagnostic {
    Diagnostic {
        path: path.to_owned(),
        line,
        column: usize::from(line > 0),
        message: message.into(),
    }
}

/// The sorted entries of a directory, as (name, is a directory). Symlinks
/// and special entries are left out: the repository walk reports them.
fn entries(root: &Path, directory: &Path) -> Vec<(String, bool)> {
    let Ok(read) = std::fs::read_dir(root.join(directory)) else {
        return Vec::new();
    };
    let mut found: Vec<(String, bool)> = read
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let kind = entry.file_type().ok()?;
            let name = entry.file_name().to_string_lossy().into_owned();
            (!name.starts_with('.') && (kind.is_dir() || kind.is_file()))
                .then_some((name, kind.is_dir()))
        })
        .collect();
    found.sort();
    found
}

/// Course and lecture IDs are directory names.
fn is_source_id(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-_".contains(&byte))
}

/// Not shipped and not linted, as beside scenarios and images.
fn exempt(name: &str) -> bool {
    name == "README.md" || name.contains("LICENSE") || name.ends_with(".hcl")
}

/// The catalog of `root/courses`, empty when there is none. Every lecture
/// link must name one of `scenarios`.
pub(super) fn load_courses(
    root: &Path,
    scenarios: &BTreeSet<&str>,
) -> Result<CourseCatalogSnapshotV2, Vec<Diagnostic>> {
    let mut problems = Vec::new();
    let mut courses = Vec::new();
    let top = Path::new("courses");
    for (course_id, is_dir) in entries(root, top) {
        let path = top.join(&course_id);
        if !is_dir {
            if !exempt(&course_id) {
                problems.push(problem(&path, 0, "courses/ holds only course directories"));
            }
            continue;
        }
        if !is_source_id(&course_id) {
            problems.push(problem(&path, 0, "not a valid course ID"));
            continue;
        }
        match course(root, &path, &course_id, scenarios, &mut problems) {
            Some(course) => courses.push(course),
            None => continue,
        }
    }
    if problems.is_empty() {
        Ok(CourseCatalogSnapshotV2 {
            version: 2,
            courses,
        })
    } else {
        Err(problems)
    }
}

fn course(
    root: &Path,
    path: &Path,
    course_id: &str,
    scenarios: &BTreeSet<&str>,
    problems: &mut Vec<Diagnostic>,
) -> Option<CourseCatalogCourseV2> {
    let mut lectures = Vec::new();
    let mut has_course_md = false;
    for (name, is_dir) in entries(root, path) {
        let entry = path.join(&name);
        if !is_dir {
            if name == "course.md" {
                has_course_md = true;
            } else if !exempt(&name) {
                problems.push(problem(
                    &entry,
                    0,
                    "a course holds course.md and lecture directories; nothing else ships",
                ));
            }
            continue;
        }
        if !is_source_id(&name) {
            problems.push(problem(&entry, 0, "not a valid lecture ID"));
            continue;
        }
        if let Some(lecture) = lecture(root, &entry, &name, scenarios, problems) {
            lectures.push(lecture);
        }
    }
    let course_md = path.join("course.md");
    if !has_course_md {
        problems.push(problem(&course_md, 0, "is missing"));
        return None;
    }
    let (frontmatter, body_markdown) = markdown::<CourseFrontmatter>(root, &course_md)
        .map_err(|found| problems.push(found))
        .ok()?;
    if lectures.is_empty() {
        problems.push(problem(path, 0, "a course needs at least one lecture"));
    }
    Some(CourseCatalogCourseV2 {
        course_id: course_id.to_owned(),
        title: required(&course_md, "title", frontmatter.title, problems)?,
        summary: required(&course_md, "summary", frontmatter.summary, problems)?,
        body_markdown,
        sequential: frontmatter.sequential,
        lectures,
    })
}

fn lecture(
    root: &Path,
    path: &Path,
    lecture_id: &str,
    scenarios: &BTreeSet<&str>,
    problems: &mut Vec<Diagnostic>,
) -> Option<CourseCatalogLectureV2> {
    let lecture_md = path.join("lecture.md");
    let mut has_lecture_md = false;
    for (name, is_dir) in entries(root, path) {
        if name == "lecture.md" && !is_dir {
            has_lecture_md = true;
        } else if is_dir || !exempt(&name) {
            problems.push(problem(
                &path.join(&name),
                0,
                "a lecture holds lecture.md; nothing else ships",
            ));
        }
    }
    if !has_lecture_md {
        problems.push(problem(&lecture_md, 0, "is missing"));
        return None;
    }
    let (frontmatter, body_markdown) = markdown::<LectureFrontmatter>(root, &lecture_md)
        .map_err(|found| problems.push(found))
        .ok()?;
    if let Some(slug) = &frontmatter.scenario
        && !scenarios.contains(slug.as_str())
    {
        let text = std::fs::read_to_string(root.join(&lecture_md)).unwrap_or_default();
        let line = text
            .lines()
            .position(|line| line.starts_with("scenario:"))
            .map_or(0, |index| index + 1);
        problems.push(problem(
            &lecture_md,
            line,
            format!("scenario `{slug}` is not in this repository (scenarios/{slug}/scenario.hcl)"),
        ));
    }
    if frontmatter.estimated_minutes == 0 {
        problems.push(problem(&lecture_md, 0, "estimated_minutes must be above 0"));
    }
    let mut seen = BTreeSet::new();
    for tag in &frontmatter.tags {
        if tag.trim().is_empty() || !seen.insert(tag.trim()) {
            problems.push(problem(
                &lecture_md,
                0,
                format!("tag `{tag}` is empty or repeated"),
            ));
        }
    }
    Some(CourseCatalogLectureV2 {
        lecture_id: lecture_id.to_owned(),
        title: required(&lecture_md, "title", frontmatter.title, problems)?,
        summary: required(&lecture_md, "summary", frontmatter.summary, problems)?,
        body_markdown,
        category: required(&lecture_md, "category", frontmatter.category, problems)?,
        tags: frontmatter
            .tags
            .iter()
            .map(|tag| tag.trim().to_owned())
            .collect(),
        difficulty: frontmatter.difficulty,
        estimated_minutes: frontmatter.estimated_minutes,
        scenario_id: frontmatter.scenario,
    })
}

fn required(
    path: &Path,
    field: &str,
    value: String,
    problems: &mut Vec<Diagnostic>,
) -> Option<String> {
    let value = value.trim().to_owned();
    if value.is_empty() {
        problems.push(problem(path, 0, format!("`{field}` must not be empty")));
        return None;
    }
    Some(value)
}

/// The frontmatter and the body of a Markdown file.
fn markdown<T: DeserializeOwned>(root: &Path, path: &PathBuf) -> Result<(T, String), Diagnostic> {
    let text = std::fs::read_to_string(root.join(path))
        .map_err(|error| problem(path, 0, error.to_string()))?;
    let (frontmatter, body) = split_frontmatter(&text).ok_or_else(|| {
        problem(
            path,
            1,
            "starts with a `---` line, YAML frontmatter and another `---` line",
        )
    })?;
    if frontmatter.len() > MAX_FRONTMATTER_BYTES {
        return Err(problem(path, 0, "the frontmatter is over 64 KiB"));
    }
    if body.trim().is_empty() {
        return Err(problem(path, 0, "the body is empty"));
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
        .map_err(|error| problem(path, 2, format!("frontmatter: {error}")))?;
    Ok((value, body.to_owned()))
}

/// `---\n<frontmatter>---\n<body>`.
fn split_frontmatter(text: &str) -> Option<(&str, &str)> {
    let rest = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))?;
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        if line.trim_end_matches(['\r', '\n']) == "---" {
            return Some((&rest[..offset], &rest[offset + line.len()..]));
        }
        offset += line.len();
    }
    None
}
