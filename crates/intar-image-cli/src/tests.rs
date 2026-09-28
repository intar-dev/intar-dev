#![allow(clippy::unwrap_used)]

use clap::{CommandFactory, Parser, error::ErrorKind};

use super::{Cli, Command, default_bundle_output_path, publish_url_from_bundle_url};

#[test]
fn derives_the_admission_route_from_a_bundle_target() {
    // A registry bundle target holds an admission session, so the uploader is
    // built from its sibling publish route.
    assert_eq!(
        publish_url_from_bundle_url("https://intar.dev/registry/v1/bundles").as_deref(),
        Some("https://intar.dev/registry/v1/publish")
    );
    assert_eq!(
        publish_url_from_bundle_url(" https://intar.dev/registry/v1/bundles/ ").as_deref(),
        Some("https://intar.dev/registry/v1/publish")
    );
    // Any other target has no admission to hold and uploads as before.
    assert_eq!(
        publish_url_from_bundle_url("https://mirror.example/upload"),
        None
    );
}

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
fn local_build_commands_accept_no_cache() {
    let command = Cli::try_parse_from(["intar-image-cli", "build", "--no-cache"]).unwrap();
    let Command::Build(args) = command.command else {
        panic!("expected build command");
    };
    assert!(args.no_cache);

    let command = Cli::try_parse_from(["intar-image-cli", "build-all", "--no-cache"]).unwrap();
    let Command::BuildAll(args) = command.command else {
        panic!("expected build-all command");
    };
    assert!(args.no_cache);
}

#[test]
fn default_bundle_path_uses_the_requested_revision() {
    assert_eq!(
        default_bundle_output_path("release-1"),
        std::path::PathBuf::from("dist/bundles/release-1.tar.gz")
    );
}
