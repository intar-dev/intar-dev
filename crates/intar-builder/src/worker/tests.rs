#![allow(clippy::unwrap_used)]

use std::path::Path;

use intar_contracts::bridge_v9::{BuildTargetV1, DesiredBuildV2};
use intar_contracts::oci::OciDigest;
use intar_contracts::source::SourceBundleV2;
use intar_image_build::{BuildTarget, plan_build};
use intar_image_scenario::loader::{compile, encode_bundle};

use super::{checked_target, decode_bundle};

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
