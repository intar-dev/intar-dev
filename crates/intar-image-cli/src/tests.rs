#![allow(clippy::unwrap_used)]

use std::fs;
use std::io::Read;

use clap::{CommandFactory, Parser, error::ErrorKind};
use flate2::read::GzDecoder;

use super::{
    BUNDLE_BASE_IMAGES_PATH, Cli, Command, PreparedBundleScenario, collect_bundle_source_files,
    default_bundle_output_path, write_bundle_archive,
};
use crate::curriculum::{CURRICULUM_CATALOG_ARCHIVE_PATH, load_curriculum};

#[test]
fn exposes_package_version_from_root_cli() {
    assert_eq!(
        Cli::command().get_version(),
        Some(env!("CARGO_PKG_VERSION"))
    );
    let error = Cli::try_parse_from(["intar-image-cli", "--version"]).unwrap_err();
    assert_eq!(error.kind(), ErrorKind::DisplayVersion);
}

#[test]
fn uses_a_markdown_courses_root_for_all_course_commands() {
    let command = Cli::try_parse_from([
        "intar-image-cli",
        "hash",
        "repair-nginx",
        "--courses-root",
        "/sources/courses",
    ])
    .unwrap();
    let Command::Hash(args) = command.command else {
        panic!("expected hash command");
    };
    assert_eq!(args.scenario.as_deref(), Some("repair-nginx"));
    assert_eq!(
        args.courses_root,
        std::path::PathBuf::from("/sources/courses")
    );
}

#[test]
fn content_only_bundle_archives_the_compiled_curriculum() {
    let temp = tempfile::tempdir().unwrap();
    write_course(temp.path(), "linux", "01-theory", None);
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

    let archive = temp.path().join("content-only.tar.gz");
    write_bundle_archive(&archive, &files).unwrap();
    assert_eq!(archive_paths(&archive), paths);
}

#[test]
fn long_curriculum_paths_use_ustar_headers_without_extensions() {
    let temp = tempfile::tempdir().unwrap();
    let course_id = format!("course-{}", "a".repeat(53));
    let lecture_id = format!("lecture-{}", "b".repeat(52));
    write_course(temp.path(), &course_id, &lecture_id, None);
    let curriculum = load_curriculum(temp.path()).unwrap();
    let catalog_path = write_compiled_catalog(temp.path(), &curriculum.catalog);
    let files = collect_bundle_source_files(&[], None, &curriculum, &catalog_path).unwrap();
    let expected_paths = files
        .iter()
        .map(|file| file.archive_path.clone())
        .collect::<Vec<_>>();
    let long_lecture_path = format!("curriculum/{course_id}/{lecture_id}/lecture.md");
    assert!(long_lecture_path.len() > 100);

    let archive = temp.path().join("ustar.tar.gz");
    write_bundle_archive(&archive, &files).unwrap();

    let mut decoder = GzDecoder::new(fs::File::open(&archive).unwrap());
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
    write_course(temp.path(), "linux", "01-nginx", Some("repair-nginx"));
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

#[test]
fn default_bundle_path_uses_the_requested_revision() {
    assert_eq!(
        default_bundle_output_path("release-1"),
        std::path::PathBuf::from("dist/bundles/release-1.tar.gz")
    );
}

fn write_compiled_catalog(
    root: &std::path::Path,
    catalog: &intar_contracts::catalog::CourseCatalogSnapshotV2,
) -> std::path::PathBuf {
    let path = root.join("catalog.json");
    fs::write(&path, serde_json::to_vec(catalog).unwrap()).unwrap();
    path
}

fn archive_paths(archive_path: &std::path::Path) -> Vec<String> {
    let decoder = GzDecoder::new(fs::File::open(archive_path).unwrap());
    let mut archive = tar::Archive::new(decoder);
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
) {
    let lecture_dir = root.join(course_id).join(lecture_id);
    fs::create_dir_all(&lecture_dir).unwrap();
    fs::write(
        root.join(course_id).join("course.md"),
        "---\ntitle: Linux\nsummary: Learn Linux.\nsequential: true\n---\n\nCourse theory.\n",
    )
    .unwrap();
    let difficulty = scenario_id.map_or(String::new(), |_| "difficulty: easy\n".to_string());
    fs::write(
        lecture_dir.join("lecture.md"),
        format!(
            "---\ntitle: Unit\nsummary: Learn the unit.\ncategory: linux\ntags: [linux]\n{difficulty}estimated_minutes: 10\n---\n\nLecture theory.\n"
        ),
    )
    .unwrap();
    if let Some(scenario_id) = scenario_id {
        fs::write(lecture_dir.join("scenario.hcl"), scenario_hcl(scenario_id)).unwrap();
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
