use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result, anyhow, bail};
use intar_contracts::catalog::{
    CourseCatalogCourseV2, CourseCatalogLectureV2, CourseCatalogSnapshotV2, ScenarioDifficulty,
};
use intar_image_scenario::Scenario;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_saphyr::{DuplicateKeyPolicy, MergeKeyPolicy};

use crate::validate_safe_cli_slug;

pub(super) const DEFAULT_COURSES_ROOT: &str = "content/courses";
pub(super) const CURRICULUM_ARCHIVE_ROOT: &str = "curriculum";
pub(super) const CURRICULUM_CATALOG_ARCHIVE_PATH: &str = "curriculum/catalog.json";

const COURSE_MARKDOWN_FILE: &str = "course.md";
const LECTURE_MARKDOWN_FILE: &str = "lecture.md";
const SCENARIO_HCL_FILE: &str = "scenario.hcl";
const MAX_FRONTMATTER_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone)]
pub(super) struct CurriculumSource {
    pub(super) catalog: CourseCatalogSnapshotV2,
    pub(super) courses: Vec<CourseSource>,
    pub(super) scenarios: Vec<CourseScenario>,
}

#[derive(Debug, Clone)]
pub(super) struct CourseSource {
    pub(super) course_id: String,
    pub(super) course_markdown_path: PathBuf,
    pub(super) support_files: Vec<PathBuf>,
    pub(super) lectures: Vec<LectureSource>,
}

#[derive(Debug, Clone)]
pub(super) struct LectureSource {
    pub(super) lecture_id: String,
    pub(super) lecture_markdown_path: PathBuf,
}

#[derive(Debug, Clone)]
pub(super) struct CourseScenario {
    pub(super) scenario_id: String,
    pub(super) scenario_path: PathBuf,
    pub(super) scenario_dir: PathBuf,
    pub(super) lecture: CourseCatalogLectureV2,
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

pub(super) fn load_curriculum(courses_root: &Path) -> Result<CurriculumSource> {
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

pub(super) fn selected_course_scenarios(
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

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::fs;

    use super::{CURRICULUM_CATALOG_ARCHIVE_PATH, load_curriculum};

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
