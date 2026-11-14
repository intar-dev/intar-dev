#![allow(clippy::unwrap_used)]

use std::path::Path;

use intar_contracts::bridge_v9::{BuildTargetV1, DesiredBuildV2};
use intar_contracts::oci::OciDigest;
use intar_contracts::source::SourceBundleV2;
use intar_image_build::{BuildTarget, plan_build};
use intar_image_scenario::loader::{compile, encode_bundle};

use intar_contracts::bridge_v9::BuildPhaseV2;
use tokio::sync::mpsc;

use super::{
    attempt_dirs, checked_target, decode_bundle, is_current, publish, push_verified, read_log_tail,
};
use crate::db::{self, BuilderDb};

/// The repository's own content, as the CLI compiles it.
fn content_bundle() -> SourceBundleV2 {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../content");
    compile(&root).unwrap().0
}

fn webserver(key: OciDigest) -> DesiredBuildV2 {
    DesiredBuildV2 {
        build_id: "build-1".to_owned(),
        build_key: key,
        bundle_rev: "rev-1".to_owned(),
        target: BuildTargetV1::Machine {
            scenario: "broken-nginx".to_owned(),
            machine: "webserver".to_owned(),
        },
        attempt: 1,
    }
}

#[test]
fn a_build_whose_key_the_bundle_does_not_build_is_refused() {
    let bundle = content_bundle();
    let target = BuildTarget::Machine {
        scenario: "broken-nginx".to_owned(),
        machine: "webserver".to_owned(),
    };
    let key = plan_build(&bundle, &target, None).unwrap().build_key;
    assert_eq!(
        checked_target(&bundle, &webserver(key.clone())).unwrap(),
        target
    );

    let wrong = OciDigest::from_sha256(&[9; 32]);
    let error = checked_target(&bundle, &webserver(wrong.clone())).unwrap_err();
    let message = format!("{error:#}");
    assert!(message.contains("desired build key mismatch"), "{message}");
    assert!(message.contains(key.as_str()), "{message}");
    assert!(message.contains(wrong.as_str()), "{message}");
}

#[test]
fn the_platform_base_is_its_own_target() {
    let bundle = content_bundle();
    let key = plan_build(&bundle, &BuildTarget::Base, None)
        .unwrap()
        .build_key;
    let mut build = webserver(key);
    build.target = BuildTargetV1::Image {
        name: "trixie".to_owned(),
    };
    assert_eq!(checked_target(&bundle, &build).unwrap(), BuildTarget::Base);
}

#[test]
fn a_bundle_of_another_image_format_is_refused() {
    let mut bundle = content_bundle();
    bundle.image_format = "intar-image-2".to_owned();
    let error = checked_target(&bundle, &webserver(OciDigest::from_sha256(&[1; 32]))).unwrap_err();
    assert!(
        format!("{error:#}").contains("image format 'intar-image-2'"),
        "{error:#}"
    );
}

#[test]
fn a_bundle_decodes_from_its_upload_bytes_and_nothing_else() {
    let bundle = content_bundle();
    let encoded = encode_bundle(&bundle).unwrap();
    assert_eq!(decode_bundle(&encoded).unwrap(), bundle);
    assert!(decode_bundle(b"not gzip").is_err());
    let oversized = vec![0; intar_contracts::source::MAX_SOURCE_BUNDLE_GZIP_BYTES + 1];
    assert!(format!("{:#}", decode_bundle(&oversized).unwrap_err()).contains("limit"));
}

#[test]
fn each_attempt_has_its_own_directories() {
    let cfg = crate::config::parse(include_str!("../../deploy/config.example.toml")).unwrap();
    let first = webserver(OciDigest::from_sha256(&[1; 32]));
    let mut second = first.clone();
    second.attempt = 2;
    let (work_1, out_1) = attempt_dirs(&cfg, &first);
    let (work_2, out_2) = attempt_dirs(&cfg, &second);
    assert_ne!(work_1, work_2);
    assert_ne!(out_1, out_2);
    assert!(work_1.ends_with("builds/build-1.1"), "{}", work_1.display());
    assert!(out_2.ends_with("outputs/build-1.2"), "{}", out_2.display());
}

#[tokio::test]
async fn a_superseded_attempt_publishes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let state_db = dir.path().join("state.sqlite3");
    let first = webserver(OciDigest::from_sha256(&[1; 32]));
    let mut second = first.clone();
    second.attempt = 2;
    let mut db = BuilderDb::open(&state_db).unwrap();
    db.reconcile(std::slice::from_ref(&first), 1).unwrap();
    db.claim_next(2).unwrap().unwrap();
    // The Worker retries while attempt 1 still runs.
    db.reconcile(std::slice::from_ref(&second), 3).unwrap();
    assert!(!is_current(&state_db, &first));
    assert!(is_current(&state_db, &second));

    let (sender, mut receiver) = mpsc::channel(4);
    let stale = db::report(&first, BuildPhaseV2::Pushing, 4);
    assert!(!publish(&state_db, &sender, stale).await);
    assert!(receiver.try_recv().is_err());
    assert_eq!(
        db.report("build-1").unwrap().unwrap().phase,
        BuildPhaseV2::Queued
    );

    let current = db::report(&second, BuildPhaseV2::FetchingSources, 5);
    assert!(publish(&state_db, &sender, current).await);
    assert_eq!(receiver.try_recv().unwrap().attempt, 2);
}

#[tokio::test]
async fn a_log_uploads_only_its_end_and_survives_invalid_utf8() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("build.log");
    let mut bytes = b"head ".repeat(100);
    bytes.extend_from_slice(b"tail \xff end");
    std::fs::write(&path, &bytes).unwrap();

    let tail = read_log_tail(&path, 12).await.unwrap();
    assert_eq!(tail, "[earlier output cut]\ntail \u{fffd} end");
    let whole = read_log_tail(&path, 1 << 20).await.unwrap();
    assert!(whole.starts_with("head head") && whole.ends_with("\u{fffd} end"));
}

#[tokio::test]
async fn a_log_tail_of_invalid_utf8_stays_within_its_limit() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("build.log");
    std::fs::write(&path, vec![0xff_u8; 4096]).unwrap();

    let tail = read_log_tail(&path, 1000).await.unwrap();
    let body = tail.strip_prefix("[earlier output cut]\n").unwrap();
    assert!(body.len() <= 1000 && body.len() > 990);
    assert!(body.chars().all(|c| c == '\u{fffd}'));
}

#[tokio::test]
async fn an_image_that_fails_verification_is_not_pushed() {
    let dir = tempfile::tempdir().unwrap();
    let raw = dir.path().join("disk.raw");
    std::fs::write(&raw, vec![7_u8; 4096]).unwrap();
    std::fs::write(dir.path().join("kernel"), b"kernel").unwrap();
    std::fs::write(dir.path().join("initrd"), b"initrd").unwrap();
    let out = dir.path().join("out");
    let image = intar_image_build::write_machine_image(
        &raw,
        &dir.path().join("kernel"),
        &dir.path().join("initrd"),
        &intar_contracts::scenario::base_key(),
        &out,
    )
    .unwrap();
    let verified = intar_image_build::verify_machine_image(&out, &image.manifest_digest).unwrap();
    let chunk = out
        .join("sha256")
        .join(verified.manifest.layers.last().unwrap().digest.hex());
    std::fs::write(&chunk, b"other").unwrap();

    // A registry that records every connection: none may come.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let error = push_verified(&url, "token", &out, &image.manifest_digest, "build-1", 1)
        .await
        .unwrap_err();
    assert!(
        format!("{error:#}").contains("fails verification"),
        "{error:#}"
    );
    assert!(listener.accept().is_err());
}
