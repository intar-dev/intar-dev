#![allow(clippy::unwrap_used)]

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::Read;

use clap::{CommandFactory, Parser, error::ErrorKind};
use flate2::read::GzDecoder;
use intar_image_build::{ScenarioContentHashInput, scenario_content_hash};

use super::{
    BUNDLE_BASE_IMAGES_PATH, BundleSourceFile, BundleUploadReceipt, Cli, Command,
    PreparedBundleScenario, TAR_BLOCK_SIZE, bundle_tar_size_bytes, bundle_url_from_publish_url,
    collect_bundle_source_files, contract_image_arch_slug, course_manifest_is_present,
    course_manifest_path, discover_course_scenarios, discover_legacy_scenarios,
    load_bundle_course_catalog, parse_bundle_course_catalog, parse_bundle_upload_response,
    validate_bundle_rev, validate_scenario_arg, write_bundle_archive,
};

fn write_scenario(scenario_dir: &std::path::Path, scenario_id: &str) {
    fs::create_dir_all(scenario_dir).unwrap();
    fs::write(
        scenario_dir.join("scenario.hcl"),
        format!("scenario \"{scenario_id}\" {{\n  category = \"test\"\n}}\n"),
    )
    .unwrap();
}

fn known_scenarios(ids: &[&str]) -> HashSet<String> {
    ids.iter().map(|id| (*id).to_owned()).collect()
}

fn ordered_course_hcl() -> &'static str {
    r#"
course "linux-operations" {
  title       = "  Linux operations  "
  description = "Practice diagnosing and repairing common Linux failures."
  scenarios   = ["broken-nginx", "pair-ping"]
}

course "cluster-operations" {
  title       = "Cluster operations"
  description = "Repair a small cluster."
  scenarios   = ["workshop-cluster"]
}
"#
}

#[test]
fn exposes_package_version_from_root_cli() {
    assert_eq!(
        Cli::command().get_version(),
        Some(env!("CARGO_PKG_VERSION"))
    );
    let error = Cli::try_parse_from(["intar-image-cli", "--version"]).unwrap_err();
    assert_eq!(error.kind(), ErrorKind::DisplayVersion);
    assert_eq!(
        error.to_string().trim(),
        format!("intar-image-cli {}", env!("CARGO_PKG_VERSION"))
    );
}

#[test]
fn parses_course_roots_and_explicit_catalog_paths() {
    let validate = Cli::try_parse_from([
        "intar-image-cli",
        "validate",
        "selected-scenario",
        "--courses-root",
        "/sources/courses",
        "--base-images",
        "/config/base-images.hcl",
    ])
    .unwrap();
    let Command::Validate(validate) = validate.command else {
        panic!("expected validate command");
    };
    assert_eq!(validate.scenario.as_deref(), Some("selected-scenario"));
    assert_eq!(
        validate.courses_root.unwrap(),
        std::path::PathBuf::from("/sources/courses")
    );
    assert_eq!(
        validate.base_images,
        std::path::PathBuf::from("/config/base-images.hcl")
    );

    let bundle = Cli::try_parse_from([
        "intar-image-cli",
        "bundle",
        "selected-scenario",
        "--courses-root",
        "/sources/courses",
        "--base-images",
        "/config/base-images.hcl",
    ])
    .unwrap();
    let Command::Bundle(bundle) = bundle.command else {
        panic!("expected bundle command");
    };
    assert_eq!(bundle.scenario.as_deref(), Some("selected-scenario"));
    assert_eq!(
        bundle.courses_root.unwrap(),
        std::path::PathBuf::from("/sources/courses")
    );
    assert_eq!(
        bundle.base_images,
        std::path::PathBuf::from("/config/base-images.hcl")
    );
}

#[test]
fn parses_provenance_bound_clean_base_command() {
    let parsed = Cli::try_parse_from([
        "intar-image-cli",
        "build-base",
        "--base-images",
        "/config/base-images.hcl",
        "--config",
        "/config/builder.hcl",
        "--output",
        "/artifacts/clean-base",
        "--repository",
        "intar-dev/intar-dev",
        "--source-sha",
        "0123456789abcdef0123456789abcdef01234567",
        "--production-run-id",
        "123",
        "--workflow-run-id",
        "456",
        "--workflow-run-attempt",
        "1",
    ])
    .unwrap();
    assert!(matches!(parsed.command, Command::BuildBase(_)));
}

#[test]
fn discovers_legacy_and_nested_scenarios_in_scenario_id_order() {
    let temp = tempfile::tempdir().unwrap();
    let legacy_root = temp.path().join("scenarios");
    write_scenario(&legacy_root.join("z-last"), "z-last");
    write_scenario(&legacy_root.join("a-first"), "a-first");

    let legacy = discover_legacy_scenarios(&legacy_root).unwrap();
    assert_eq!(
        legacy
            .iter()
            .map(|scenario| scenario.scenario_id.as_str())
            .collect::<Vec<_>>(),
        ["a-first", "z-last"]
    );

    let courses_root = temp.path().join("courses");
    write_scenario(&courses_root.join("course-z").join("middle"), "middle");
    write_scenario(&courses_root.join("course-a").join("first"), "first");
    fs::write(courses_root.join("README.md"), "catalog notes\n").unwrap();
    fs::write(
        courses_root.join("course-a").join("README.md"),
        "course notes\n",
    )
    .unwrap();

    let nested = discover_course_scenarios(&courses_root).unwrap();
    assert_eq!(
        nested
            .iter()
            .map(|scenario| scenario.scenario_id.as_str())
            .collect::<Vec<_>>(),
        ["first", "middle"]
    );
    assert!(
        nested[0]
            .scenario_path
            .ends_with("courses/course-a/first/scenario.hcl")
    );
}

#[test]
fn rejects_duplicate_nested_scenario_ids() {
    let temp = tempfile::tempdir().unwrap();
    let courses_root = temp.path().join("courses");
    write_scenario(&courses_root.join("course-a/demo"), "demo");
    write_scenario(&courses_root.join("course-b/demo"), "demo");

    let error = discover_course_scenarios(&courses_root).unwrap_err();
    assert!(format!("{error:#}").contains("duplicate scenario ID 'demo'"));
}

#[test]
fn rejects_scenario_directory_and_hcl_id_mismatch() {
    let temp = tempfile::tempdir().unwrap();
    let courses_root = temp.path().join("courses");
    write_scenario(&courses_root.join("course-a/wrong-name"), "actual-name");

    let error = discover_course_scenarios(&courses_root).unwrap_err();
    assert!(
        format!("{error:#}")
            .contains("basename 'wrong-name' does not match HCL scenario ID 'actual-name'")
    );
}

#[test]
fn rejects_scenario_directories_missing_scenario_hcl() {
    let temp = tempfile::tempdir().unwrap();
    let courses_root = temp.path().join("courses");
    fs::create_dir_all(courses_root.join("course-a/missing")).unwrap();

    let error = discover_course_scenarios(&courses_root).unwrap_err();
    assert!(format!("{error:#}").contains("is missing scenario.hcl"));
}

#[test]
fn rejects_unsafe_discovered_scenario_ids() {
    let temp = tempfile::tempdir().unwrap();
    let courses_root = temp.path().join("courses");
    write_scenario(&courses_root.join("course-a/bad name"), "bad name");

    let error = discover_course_scenarios(&courses_root).unwrap_err();
    assert!(format!("{error:#}").contains("is not a safe slug"));
}

#[test]
fn rejects_unsafe_course_ids() {
    let temp = tempfile::tempdir().unwrap();
    let courses_root = temp.path().join("courses");
    write_scenario(&courses_root.join("bad course/demo"), "demo");

    let error = discover_course_scenarios(&courses_root).unwrap_err();
    let message = format!("{error:#}");
    assert!(message.contains("course ID"));
    assert!(message.contains("is not a safe slug"));
}

#[cfg(target_os = "linux")]
#[test]
fn rejects_non_utf8_course_ids() {
    use std::os::unix::ffi::OsStringExt;

    let temp = tempfile::tempdir().unwrap();
    let courses_root = temp.path().join("courses");
    let course_id = std::ffi::OsString::from_vec(b"course-\xff".to_vec());
    write_scenario(&courses_root.join(course_id).join("demo"), "demo");

    let error = discover_course_scenarios(&courses_root).unwrap_err();
    assert!(format!("{error:#}").contains("course directory name is not valid UTF-8"));
}

#[cfg(unix)]
#[test]
fn rejects_symlinks_at_each_course_source_level() {
    use std::os::unix::fs::symlink;

    for level in [
        "courses-root",
        "course",
        "scenario",
        "scenario-hcl",
        "scenario-asset",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let courses_root = temp.path().join("courses");
        let course_dir = courses_root.join("course-a");
        let scenario_dir = course_dir.join("demo");
        fs::create_dir_all(&scenario_dir).unwrap();

        match level {
            "courses-root" => {
                fs::remove_dir_all(&courses_root).unwrap();
                let real_courses = temp.path().join("real-courses");
                fs::create_dir_all(&real_courses).unwrap();
                symlink(real_courses, &courses_root).unwrap();
            }
            "course" => {
                fs::remove_dir_all(&course_dir).unwrap();
                fs::create_dir_all(courses_root.join("real-course")).unwrap();
                symlink(courses_root.join("real-course"), &course_dir).unwrap();
            }
            "scenario" => {
                fs::remove_dir_all(&scenario_dir).unwrap();
                fs::create_dir_all(course_dir.join("real-scenario")).unwrap();
                symlink(course_dir.join("real-scenario"), &scenario_dir).unwrap();
            }
            "scenario-hcl" => {
                let target = temp.path().join("scenario.hcl");
                fs::write(&target, "scenario \"demo\" { category = \"test\" }\n").unwrap();
                symlink(target, scenario_dir.join("scenario.hcl")).unwrap();
            }
            "scenario-asset" => {
                write_scenario(&scenario_dir, "demo");
                let target = temp.path().join("script.sh");
                fs::write(&target, "#!/bin/sh\n").unwrap();
                symlink(target, scenario_dir.join("script.sh")).unwrap();
            }
            _ => unreachable!(),
        }

        let error = discover_course_scenarios(&courses_root).unwrap_err();
        assert!(
            format!("{error:#}").contains("symlink"),
            "unexpected error for {level}: {error:#}"
        );
    }
}

#[test]
fn flattens_nested_course_paths_with_explicit_catalog_source() {
    let temp = tempfile::tempdir().unwrap();
    let scenario_dir = temp.path().join("courses/course-a/demo");
    write_scenario(&scenario_dir, "demo");
    fs::create_dir_all(scenario_dir.join("assets")).unwrap();
    fs::write(scenario_dir.join("assets/setup.sh"), "#!/bin/sh\n").unwrap();
    let base_images = temp.path().join("release/base-images-custom.hcl");
    fs::create_dir_all(base_images.parent().unwrap()).unwrap();
    fs::write(&base_images, "base images\n").unwrap();

    let files = collect_bundle_source_files(
        &[PreparedBundleScenario {
            scenario_id: "demo".to_owned(),
            scenario_dir,
            content_hash: "unused".to_owned(),
        }],
        &base_images,
        None,
    )
    .unwrap();
    assert_eq!(
        files
            .iter()
            .map(|file| file.archive_path.as_str())
            .collect::<Vec<_>>(),
        [
            BUNDLE_BASE_IMAGES_PATH,
            "scenarios/demo/assets/setup.sh",
            "scenarios/demo/scenario.hcl",
        ]
    );
    assert!(
        files
            .iter()
            .all(|file| !file.archive_path.contains("course-a"))
    );
}

#[test]
fn accepts_only_strict_bundle_upload_receipts() {
    let receipt = parse_bundle_upload_response(
        reqwest::StatusCode::ACCEPTED,
        r#"{
          "ok": true,
          "rev": "release-1",
          "bundle_key": "bundles/release-1.tar.gz",
          "queued": 2,
          "assigned": [
            {"buildId": "build-1", "hostId": "host-1"},
            {"buildId": "build-2", "hostId": "host-2"}
          ]
        }"#,
        "release-1",
    )
    .unwrap();
    assert_eq!(
        receipt,
        BundleUploadReceipt {
            queued: 2,
            assigned: 2,
        }
    );

    let invalid = [
        (
            reqwest::StatusCode::OK,
            r#"{"ok":true,"rev":"release-1","queued":0,"assigned":[]}"#,
        ),
        (reqwest::StatusCode::ACCEPTED, "not-json"),
        (reqwest::StatusCode::ACCEPTED, "[]"),
        (
            reqwest::StatusCode::ACCEPTED,
            r#"{"ok":false,"rev":"release-1","queued":0,"assigned":[]}"#,
        ),
        (
            reqwest::StatusCode::ACCEPTED,
            r#"{"ok":true,"rev":"other","queued":0,"assigned":[]}"#,
        ),
        (
            reqwest::StatusCode::ACCEPTED,
            r#"{"ok":true,"rev":"release-1","assigned":[]}"#,
        ),
        (
            reqwest::StatusCode::ACCEPTED,
            r#"{"ok":true,"rev":"release-1","queued":-1,"assigned":[]}"#,
        ),
        (
            reqwest::StatusCode::ACCEPTED,
            r#"{"ok":true,"rev":"release-1","queued":1.0,"assigned":[]}"#,
        ),
        (
            reqwest::StatusCode::ACCEPTED,
            r#"{"ok":true,"rev":"release-1","queued":0}"#,
        ),
        (
            reqwest::StatusCode::ACCEPTED,
            r#"{"ok":true,"rev":"release-1","queued":0,"assigned":{}}"#,
        ),
    ];
    for (status, body) in invalid {
        assert!(
            parse_bundle_upload_response(status, body, "release-1").is_err(),
            "unexpectedly accepted status {status} with body {body}"
        );
    }
}

#[test]
fn derives_bundle_url_from_publish_url() {
    assert_eq!(
        bundle_url_from_publish_url("https://intar.dev/registry/v1/publish"),
        "https://intar.dev/registry/v1/bundles"
    );
    assert_eq!(
        bundle_url_from_publish_url("https://intar.dev/registry/v1/bundles"),
        "https://intar.dev/registry/v1/bundles"
    );
}

#[test]
fn normalizes_contract_arch_slug() {
    assert_eq!(contract_image_arch_slug("amd64").unwrap(), "x86_64");
    assert_eq!(contract_image_arch_slug("aarch64").unwrap(), "aarch64");
    assert!(contract_image_arch_slug("ppc64le").is_err());
}

#[test]
fn rejects_dot_bundle_revisions() {
    assert!(validate_bundle_rev("abc.123").is_ok());
    assert!(validate_bundle_rev(".").is_err());
    assert!(validate_bundle_rev("..").is_err());
    assert!(validate_bundle_rev("../escape").is_err());
}

#[test]
fn rejects_unsafe_scenario_arguments() {
    assert!(validate_scenario_arg("broken-nginx").is_ok());
    assert!(validate_scenario_arg(".").is_err());
    assert!(validate_scenario_arg("..").is_err());
    assert!(validate_scenario_arg("../escape").is_err());
}

#[test]
fn parses_and_normalizes_courses_in_curriculum_order() {
    let catalog = parse_bundle_course_catalog(
        ordered_course_hcl(),
        &known_scenarios(&["broken-nginx", "pair-ping", "workshop-cluster"]),
    )
    .unwrap();

    assert_eq!(
        serde_json::to_value(catalog).unwrap(),
        serde_json::json!({
            "version": 1,
            "mode": "replace",
            "courses": [
                {
                    "course_id": "linux-operations",
                    "title": "Linux operations",
                    "description": "Practice diagnosing and repairing common Linux failures.",
                    "scenario_ids": ["broken-nginx", "pair-ping"],
                },
                {
                    "course_id": "cluster-operations",
                    "title": "Cluster operations",
                    "description": "Repair a small cluster.",
                    "scenario_ids": ["workshop-cluster"],
                },
            ],
        })
    );
}

#[test]
fn rejects_invalid_course_fields_and_ids() {
    let known = known_scenarios(&["broken-nginx"]);
    let invalid_catalogs = [
        (
            "course \"../escape\" {\n  title = \"Title\"\n  description = \"Description\"\n  scenarios = [\"broken-nginx\"]\n}",
            "invalid course id",
        ),
        (
            "course \"linux\" {\n  description = \"Description\"\n  scenarios = [\"broken-nginx\"]\n}",
            "non-empty title",
        ),
        (
            "course \"linux\" {\n  title = \"   \"\n  description = \"Description\"\n  scenarios = [\"broken-nginx\"]\n}",
            "non-empty title",
        ),
        (
            "course \"linux\" {\n  title = \"Title\"\n  scenarios = [\"broken-nginx\"]\n}",
            "non-empty description",
        ),
        (
            "course \"linux\" {\n  title = \"Title\"\n  description = \"  \"\n  scenarios = [\"broken-nginx\"]\n}",
            "non-empty description",
        ),
        (
            "course \"linux\" {\n  title = \"Title\"\n  description = \"Description\"\n}",
            "missing required scenarios",
        ),
        (
            "course \"linux\" {\n  title = \"Title\"\n  description = \"Description\"\n  scenarios = []\n}",
            "at least one scenario",
        ),
        (
            "course \"linux\" {\n  title = \"Title\"\n  description = \"Description\"\n  scenarios = [\"../escape\"]\n}",
            "invalid course scenario id",
        ),
    ];

    for (hcl, expected) in invalid_catalogs {
        let error = parse_bundle_course_catalog(hcl, &known).unwrap_err();
        assert!(
            format!("{error:#}").contains(expected),
            "expected error containing {expected:?}, got {error:#}"
        );
    }
}

#[test]
fn rejects_duplicate_courses_and_memberships() {
    let known = known_scenarios(&["broken-nginx", "pair-ping"]);
    let invalid_catalogs = [
        (
            r#"
course "linux" {
  title = "One"
  description = "One"
  scenarios = ["broken-nginx"]
}
course "linux" {
  title = "Two"
  description = "Two"
  scenarios = ["pair-ping"]
}
"#,
            "duplicate course 'linux'",
        ),
        (
            "course \"linux\" {\n  title = \"One\"\n  description = \"One\"\n  scenarios = [\"broken-nginx\", \"broken-nginx\"]\n}",
            "lists scenario 'broken-nginx' more than once",
        ),
        (
            r#"
course "linux" {
  title = "One"
  description = "One"
  scenarios = ["broken-nginx"]
}
course "networking" {
  title = "Two"
  description = "Two"
  scenarios = ["broken-nginx"]
}
"#,
            "belongs to multiple courses",
        ),
    ];

    for (hcl, expected) in invalid_catalogs {
        let error = parse_bundle_course_catalog(hcl, &known).unwrap_err();
        assert!(
            format!("{error:#}").contains(expected),
            "expected error containing {expected:?}, got {error:#}"
        );
    }
}

#[test]
fn rejects_unknown_course_scenario_references() {
    let error = parse_bundle_course_catalog(
        "course \"linux\" {\n  title = \"Linux\"\n  description = \"Linux\"\n  scenarios = [\"not-in-tree\"]\n}",
        &known_scenarios(&["broken-nginx"]),
    )
    .unwrap_err();

    assert!(format!("{error:#}").contains("references unknown scenario 'not-in-tree'"));
}

#[test]
fn distinguishes_missing_and_empty_course_manifests() {
    let temp = tempfile::tempdir().unwrap();
    let course_path = temp.path().join("courses.hcl");

    assert!(!course_manifest_is_present(&course_path).unwrap());
    assert!(
        load_bundle_course_catalog(&course_path, &[])
            .unwrap()
            .is_none()
    );

    fs::write(&course_path, "# Explicitly clear the course catalog.\n").unwrap();
    assert!(course_manifest_is_present(&course_path).unwrap());
    let catalog = load_bundle_course_catalog(&course_path, &[])
        .unwrap()
        .expect("an empty file is an explicit replacement");
    assert_eq!(
        serde_json::to_value(catalog).unwrap(),
        serde_json::json!({ "version": 1, "mode": "replace", "courses": [] })
    );
}

#[test]
fn partial_bundle_uses_complete_course_snapshot_and_archives_provenance() {
    let temp = tempfile::tempdir().unwrap();
    let base_images_path = temp.path().join("base-images.hcl");
    let course_path = temp.path().join("courses.hcl");
    let courses_root = temp.path().join("courses");
    let selected_scenario_dir = courses_root.join("linux/broken-nginx");
    let other_scenario_dir = courses_root.join("networking/pair-ping");
    fs::write(&base_images_path, "base images").unwrap();
    write_scenario(&selected_scenario_dir, "broken-nginx");
    write_scenario(&other_scenario_dir, "pair-ping");
    fs::write(
        &course_path,
        "course \"linux\" {\n  title = \"Linux\"\n  description = \"Linux\"\n  scenarios = [\"broken-nginx\", \"pair-ping\"]\n}\n",
    )
    .unwrap();

    assert_eq!(
        course_manifest_path(Some(&courses_root)).unwrap(),
        course_path
    );
    let complete_paths = discover_course_scenarios(&courses_root)
        .unwrap()
        .into_iter()
        .map(|scenario| scenario.scenario_path)
        .collect::<Vec<_>>();
    let catalog = load_bundle_course_catalog(&course_path, &complete_paths)
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_value(catalog).unwrap()["courses"][0]["scenario_ids"],
        serde_json::json!(["broken-nginx", "pair-ping"])
    );

    let selected = vec![PreparedBundleScenario {
        scenario_id: "broken-nginx".to_owned(),
        scenario_dir: selected_scenario_dir,
        content_hash: "hash".to_owned(),
    }];
    let source_files =
        collect_bundle_source_files(&selected, &base_images_path, Some(&course_path)).unwrap();
    let archive_path = temp.path().join("partial.tar.gz");
    write_bundle_archive(&archive_path, &source_files).unwrap();

    let decoder = GzDecoder::new(fs::File::open(archive_path).unwrap());
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .unwrap()
        .map(|entry| {
            let mut entry = entry.unwrap();
            let path = entry.path().unwrap().to_string_lossy().into_owned();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            (path, bytes)
        })
        .collect::<BTreeMap<_, _>>();
    assert_eq!(entries["courses.hcl"], fs::read(&course_path).unwrap());
    assert!(entries.contains_key("scenarios/broken-nginx/scenario.hcl"));
    assert!(!entries.contains_key("scenarios/pair-ping/scenario.hcl"));
}

#[test]
fn complete_source_validation_rejects_invalid_course_during_partial_selection() {
    let temp = tempfile::tempdir().unwrap();
    let scenario_dir = temp.path().join("scenarios/broken-nginx");
    fs::create_dir_all(&scenario_dir).unwrap();
    let scenario_path = scenario_dir.join("scenario.hcl");
    fs::write(
        &scenario_path,
        "scenario \"broken-nginx\" { category = \"linux\" }",
    )
    .unwrap();
    let course_path = temp.path().join("courses.hcl");
    fs::write(
        &course_path,
        "course \"linux\" {\n  title = \"Linux\"\n  description = \"Linux\"\n  scenarios = [\"pair-ping\"]\n}\n",
    )
    .unwrap();

    let error = load_bundle_course_catalog(&course_path, &[scenario_path]).unwrap_err();
    assert!(format!("{error:#}").contains("references unknown scenario 'pair-ping'"));
}

#[test]
fn course_manifest_does_not_change_scenario_content_hash() {
    let temp = tempfile::tempdir().unwrap();
    let scenario_dir = temp.path().join("scenarios/broken-nginx");
    fs::create_dir_all(&scenario_dir).unwrap();
    fs::write(scenario_dir.join("scenario.hcl"), "scenario source").unwrap();

    let hash = || {
        scenario_content_hash(&ScenarioContentHashInput {
            scenario_id: "broken-nginx",
            scenario_dir: &scenario_dir,
            base_definition: "base definition",
            target_arch: "amd64",
        })
        .unwrap()
    };
    let before = hash();
    fs::write(temp.path().join("courses.hcl"), ordered_course_hcl()).unwrap();
    let after = hash();

    assert_eq!(before, after);
}

#[test]
fn writes_deterministic_bundle_archive() {
    let temp = tempfile::tempdir().unwrap();
    let first_source = temp.path().join("scenario.hcl");
    let second_source = temp.path().join("script.sh");
    fs::write(&first_source, "scenario").unwrap();
    fs::write(&second_source, "#!/bin/sh\n").unwrap();

    let files = vec![
        BundleSourceFile {
            source_path: second_source,
            archive_path: "scenarios/demo/script.sh".to_owned(),
        },
        BundleSourceFile {
            source_path: first_source,
            archive_path: "scenarios/demo/scenario.hcl".to_owned(),
        },
    ];
    let first_archive = temp.path().join("first.tar.gz");
    let second_archive = temp.path().join("second.tar.gz");
    write_bundle_archive(&first_archive, &files).unwrap();
    write_bundle_archive(&second_archive, &files).unwrap();

    assert_eq!(
        fs::read(&first_archive).unwrap(),
        fs::read(&second_archive).unwrap()
    );

    let decoder = GzDecoder::new(fs::File::open(first_archive).unwrap());
    let mut archive = tar::Archive::new(decoder);
    let paths = archive
        .entries()
        .unwrap()
        .map(|entry| {
            entry
                .unwrap()
                .path()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        paths,
        vec!["scenarios/demo/scenario.hcl", "scenarios/demo/script.sh"]
    );
}

#[test]
fn estimates_bundle_tar_size_with_headers_padding_and_terminator() {
    let temp = tempfile::tempdir().unwrap();
    let first_source = temp.path().join("one");
    let second_source = temp.path().join("two");
    fs::write(&first_source, [1; 1]).unwrap();
    fs::write(&second_source, [2; 513]).unwrap();

    let files = vec![
        BundleSourceFile {
            source_path: first_source,
            archive_path: "one".to_owned(),
        },
        BundleSourceFile {
            source_path: second_source,
            archive_path: "two".to_owned(),
        },
    ];

    assert_eq!(
        bundle_tar_size_bytes(&files).unwrap(),
        (TAR_BLOCK_SIZE * 2)
            + TAR_BLOCK_SIZE
            + TAR_BLOCK_SIZE
            + TAR_BLOCK_SIZE
            + (TAR_BLOCK_SIZE * 2)
    );
}

#[test]
fn rejects_bundle_archives_that_exceed_inflated_tar_limit() {
    let temp = tempfile::tempdir().unwrap();
    let huge_source = temp.path().join("huge");
    fs::File::create(&huge_source)
        .unwrap()
        .set_len(super::MAX_BUNDLE_TAR_BYTES + 1)
        .unwrap();

    let files = vec![BundleSourceFile {
        source_path: huge_source,
        archive_path: "scenarios/demo/huge".to_owned(),
    }];
    let archive_path = temp.path().join("huge.tar.gz");

    let error = write_bundle_archive(&archive_path, &files).unwrap_err();
    assert!(format!("{error:#}").contains("exceeding the"));
    assert!(!archive_path.exists());
}
