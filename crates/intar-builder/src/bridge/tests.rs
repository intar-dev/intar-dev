#![allow(clippy::unwrap_used)]

use std::path::Path;

use intar_contracts::bridge::{HostRoleV1, HostScope};
use intar_contracts::bridge_v9::{
    BRIDGE_PROTOCOL_VERSION_9, BridgeMessageV9, BuildPhaseV2, BuildTargetV1, DesiredBuildV2,
    DesiredSourceCompileV2, DesiredStateV9, HOST_DESIRED_STATE_SCHEMA_VERSION_7,
    HostDesiredStateV3,
};
use intar_contracts::oci::{IMAGE_FORMAT, OciDigest};
use intar_contracts::source::{SOURCE_COMPILER_VERSION_V2, source_compile_digest};
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::protocol::frame::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::{Message, frame::coding::CloseCode};

use super::{
    DesiredStateSenders, RETRY_MAX_MS, RETRY_MIN_MS, UPGRADE_RETRY_MS, UpgradeRequired,
    advertised_desired_version, builder_client_hello, can_open_char_device, handle_server_message,
    parse_bridge_message, parse_meminfo_kib, retry_after_failure, validate_desired_state,
};
use crate::config::{BridgeConfig, BuilderConfig};
use crate::db::BuilderDb;

fn cfg() -> BuilderConfig {
    BuilderConfig {
        bridge: BridgeConfig {
            host_id: "builder-1".to_owned(),
            ..BridgeConfig::default()
        },
        ..BuilderConfig::default()
    }
}

fn build() -> DesiredBuildV2 {
    DesiredBuildV2 {
        build_id: "build-1".to_owned(),
        build_key: OciDigest::from_sha256(&[1; 32]),
        bundle_rev: "rev-1".to_owned(),
        target: BuildTargetV1::Image {
            name: "trixie".to_owned(),
        },
        attempt: 1,
    }
}

fn compile() -> DesiredSourceCompileV2 {
    DesiredSourceCompileV2 {
        compile_id: "compile-1".to_owned(),
        attempt: 1,
        rev: "git-1-abc".to_owned(),
        validate_only: false,
    }
}

fn desired() -> HostDesiredStateV3 {
    HostDesiredStateV3 {
        scope: HostScope::Platform,
        owner_user_id: "owner".to_owned(),
        schema_version: HOST_DESIRED_STATE_SCHEMA_VERSION_7,
        host_id: "builder-1".to_owned(),
        version: 3,
        generated_at_unix_ms: 1,
        cached_images: Vec::new(),
        kino_pin: None,
        vms: Vec::new(),
        builds: vec![build()],
        source_compiles: vec![compile()],
    }
}

#[tokio::test]
async fn an_applied_desired_state_queues_builds_and_hands_over_compiles() {
    let db = BuilderDb::open_in_memory().unwrap();
    let (ready, ready_rx) = watch::channel(0);
    let (source_compiles, source_compiles_rx) = watch::channel(Vec::new());
    let senders = DesiredStateSenders {
        ready,
        source_compiles,
    };
    let message = BridgeMessageV9::DesiredState(DesiredStateV9 {
        protocol_version: BRIDGE_PROTOCOL_VERSION_9,
        host_id: "builder-1".to_owned(),
        desired_state: desired(),
        relay: None,
    });
    let mut current = None;
    handle_server_message(
        &mut futures_util::sink::drain(),
        &cfg(),
        &db,
        &mut current,
        &senders,
        message,
    )
    .await
    .unwrap();

    assert_eq!(*source_compiles_rx.borrow(), [compile()]);
    assert_eq!(*ready_rx.borrow(), 1);
    assert_eq!(current.unwrap().version, 3);
    let report = db.report("build-1").unwrap().unwrap();
    assert_eq!(report.phase, BuildPhaseV2::Queued);
    assert!(db.load_desired_state().unwrap().is_some());
}

#[test]
fn a_desired_state_with_an_unsafe_name_or_a_vm_is_refused() {
    validate_desired_state("builder-1", &desired()).unwrap();

    let mut state = desired();
    state.builds[0].bundle_rev = "../escape".to_owned();
    let error = validate_desired_state("builder-1", &state).unwrap_err();
    assert!(
        format!("{error:#}").contains("invalid bundle rev"),
        "{error:#}"
    );

    let mut state = desired();
    state.source_compiles[0].compile_id = "a b".to_owned();
    assert!(validate_desired_state("builder-1", &state).is_err());

    assert!(validate_desired_state("builder-2", &desired()).is_err());
}

#[test]
fn the_hello_states_the_image_format_and_compile_digest() {
    let BridgeMessageV9::ClientHello(hello) = builder_client_hello(&cfg(), Some(7)) else {
        panic!("expected a client hello");
    };
    assert_eq!(hello.role, HostRoleV1::Builder);
    assert_eq!(hello.protocol_version, 9);
    assert_eq!(hello.last_applied_desired_version, Some(7));
    let builder = hello.builder.unwrap();
    assert_eq!(builder.image_format, IMAGE_FORMAT);
    assert_eq!(
        builder.source_compile_digest,
        source_compile_digest(IMAGE_FORMAT, SOURCE_COMPILER_VERSION_V2)
    );
}

#[test]
fn a_refused_protocol_waits_ten_minutes_without_a_hot_loop() {
    assert_eq!(
        retry_after_failure(RETRY_MIN_MS, false),
        (RETRY_MIN_MS, RETRY_MIN_MS * 2)
    );
    assert_eq!(
        retry_after_failure(RETRY_MAX_MS, false),
        (RETRY_MAX_MS, RETRY_MAX_MS)
    );
    assert_eq!(
        retry_after_failure(RETRY_MIN_MS, true),
        (UPGRADE_RETRY_MS, RETRY_MAX_MS)
    );
    assert_eq!(UPGRADE_RETRY_MS, 600_000);

    let close = Message::Close(Some(CloseFrame {
        code: CloseCode::from(4426),
        reason: "upgrade".into(),
    }));
    let error = parse_bridge_message(close).unwrap_err();
    assert!(error.downcast_ref::<UpgradeRequired>().is_some());
    let close = Message::Close(Some(CloseFrame {
        code: CloseCode::Normal,
        reason: "bye".into(),
    }));
    let error = parse_bridge_message(close).unwrap_err();
    assert!(error.downcast_ref::<UpgradeRequired>().is_none());
}

#[test]
fn a_restart_advertises_no_version_until_a_live_desired_state() {
    let state = desired();
    assert_eq!(advertised_desired_version(Some(&state), false), None);
    assert_eq!(advertised_desired_version(Some(&state), true), Some(3));
    assert_eq!(advertised_desired_version(None, true), None);
}

#[test]
fn parses_linux_meminfo_capacity_fields() {
    let (total, available) = parse_meminfo_kib(
        "MemTotal:       32768000 kB\nMemFree:         1024000 kB\nMemAvailable:   24576000 kB\n",
    );
    assert_eq!(total, Some(32_768_000));
    assert_eq!(available, Some(24_576_000));
}

#[test]
fn char_device_probe_rejects_missing_and_regular_files() {
    let regular = tempfile::NamedTempFile::new().unwrap();
    assert!(!can_open_char_device(Path::new(
        "/tmp/intar-builder-missing"
    )));
    assert!(!can_open_char_device(regular.path()));
    #[cfg(unix)]
    assert!(can_open_char_device(Path::new("/dev/null")));
}
