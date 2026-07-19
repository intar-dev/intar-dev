#![allow(clippy::unwrap_used)]

use std::fs;

use clap::{CommandFactory, Parser, error::ErrorKind};
use flate2::read::GzDecoder;

use super::{
    BASE_IMAGES_PATH, BUILD_TOOLS_PATH, BundleSourceFile, BundleUploadReceipt, Cli, Command,
    PreparedBundleScenario, TAR_BLOCK_SIZE, bundle_tar_size_bytes, bundle_url_from_publish_url,
    collect_bundle_source_files, contract_image_arch_slug, discover_course_scenarios,
    discover_legacy_scenarios, kino_version_from_package_id, parse_bundle_upload_response,
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
        "--build-tools",
        "/config/build-tools.hcl",
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
    assert_eq!(
        bundle.build_tools,
        std::path::PathBuf::from("/config/build-tools.hcl")
    );
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
fn flattens_nested_course_paths_with_explicit_catalog_and_tool_sources() {
    let temp = tempfile::tempdir().unwrap();
    let scenario_dir = temp.path().join("courses/course-a/demo");
    write_scenario(&scenario_dir, "demo");
    fs::create_dir_all(scenario_dir.join("assets")).unwrap();
    fs::write(scenario_dir.join("assets/setup.sh"), "#!/bin/sh\n").unwrap();
    let base_images = temp.path().join("release/base-images-custom.hcl");
    let build_tools = temp.path().join("release/build-tools-custom.hcl");
    fs::create_dir_all(base_images.parent().unwrap()).unwrap();
    fs::write(&base_images, "base images\n").unwrap();
    fs::write(&build_tools, "build tools\n").unwrap();

    let files = collect_bundle_source_files(
        &[PreparedBundleScenario {
            scenario_id: "demo".to_owned(),
            scenario_dir,
            content_hash: "unused".to_owned(),
        }],
        &base_images,
        &build_tools,
    )
    .unwrap();
    assert_eq!(
        files
            .iter()
            .map(|file| file.archive_path.as_str())
            .collect::<Vec<_>>(),
        [
            BASE_IMAGES_PATH,
            BUILD_TOOLS_PATH,
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
fn parses_path_package_id_version() {
    assert_eq!(
        kino_version_from_package_id("path+file:///workspace/intar-dev/crates/kino#0.1.24")
            .expect("path package id should parse"),
        "0.1.24"
    );
}

#[test]
fn parses_registry_package_id_version() {
    assert_eq!(
        kino_version_from_package_id(
            "registry+https://github.com/rust-lang/crates.io-index#kino@0.1.24"
        )
        .expect("registry package id should parse"),
        "0.1.24"
    );
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
