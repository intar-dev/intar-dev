#![allow(clippy::unwrap_used)]

use std::fs;

use flate2::read::GzDecoder;

use super::{
    BundleSourceFile, TAR_BLOCK_SIZE, bundle_tar_size_bytes, bundle_url_from_publish_url,
    contract_image_arch_slug, kino_version_from_package_id, validate_bundle_rev,
    validate_scenario_arg, write_bundle_archive,
};

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
