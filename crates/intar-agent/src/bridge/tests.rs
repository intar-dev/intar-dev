use intar_contracts::bridge::DesiredCachedImageV1;

use crate::vm::VmTerminalTarget;

use super::*;

fn desired_vm() -> DesiredVmV2 {
    DesiredVmV2 {
        run_id: "run-1".to_string(),
        vm_name: "web".to_string(),
        desired_phase: DesiredVmPhase::Running,
        image_key: ImageKey {
            scenario: "broken-nginx".to_string(),
            vm: "web".to_string(),
            arch: ImageArchitecture::X86_64,
        },
        image_sha256: "a".repeat(64),
        resources: VmResourcesV2 {
            cpu_millis: 125,
            vcpu_count: 1,
            memory_mib: Mib(512),
            disk_mib: Mib(4096),
        },
        ssh_authorized_keys_openssh: vec!["ssh-ed25519 AAAATEST run".to_string()],
        lease_expires_at_unix_ms: now_ms() + 60_000,
    }
}

fn empty_desired_state(version: u64) -> HostDesiredStateV2 {
    HostDesiredStateV2 {
        schema_version: HOST_DESIRED_STATE_SCHEMA_VERSION,
        host_id: "host-1".to_string(),
        version,
        generated_at_unix_ms: 123,
        cached_images: Vec::new(),
        vms: Vec::new(),
        builds: Vec::new(),
    }
}

#[test]
fn char_device_probe_rejects_missing_and_regular_files() {
    let regular = tempfile::NamedTempFile::new().expect("tempfile");

    assert!(!can_open_char_device(Path::new(
        "/tmp/intar-agent-missing-char-device"
    )));
    assert!(!can_open_char_device(regular.path()));
}

#[cfg(unix)]
#[test]
fn char_device_probe_accepts_openable_char_devices() {
    assert!(can_open_char_device(Path::new("/dev/null")));
}

#[test]
fn parses_only_v6_bridge_messages() {
    let message = BridgeMessageV6::SyncRequest(SyncRequestV6 {
        protocol_version: BRIDGE_PROTOCOL_VERSION,
        host_id: "host-1".to_string(),
        reason: SyncRequestReason::Connect,
    });
    let raw = serde_json::to_string(&message).expect("serialize");

    assert!(parse_bridge_json(&raw).is_ok());

    let raw_v5 = raw.replace("\"protocol_version\":6", "\"protocol_version\":5");
    let error = parse_bridge_json(&raw_v5).expect_err("v5 should fail");
    assert!(error.to_string().contains("expected v6"));
}

#[tokio::test]
async fn terminal_subscription_retains_transition_during_initial_snapshot() {
    let (terminal_tx, _) = tokio::sync::broadcast::channel(1);
    // connect_once establishes this receiver before it starts building the
    // initial state report. The send below models readiness becoming
    // durable while that report still contains the preceding Pending view.
    let mut terminal_updates = terminal_tx.subscribe();
    let state = VmTerminalState {
        run_id: "run-1".to_string(),
        vm_name: "web".to_string(),
        state: VmTerminalStateKind::Ready,
        terminal_target: Some(VmTerminalTarget {
            host: Some("203.0.113.7".to_string()),
            port: 22_001,
            username: "ubuntu".to_string(),
            checked_at: 2_000,
        }),
        reason: None,
        observed_at: 2_000,
        runtime_constraints: Some(VmRuntimeConstraintsV1 {
            generation: "generation-1".to_string(),
            phase: VmRuntimeConstraintPhaseV1::Steady,
            steady_cpu_millis: 1_000,
            effective_cpu_millis: 1_000,
            quota_verified_at_unix_ms: Some(1_999),
            lease_expires_at_unix_ms: None,
        }),
    };

    terminal_tx
        .send(state.clone())
        .expect("pre-snapshot subscription retains readiness transition");

    assert_eq!(
        timeout(
            Duration::from_millis(INVENTORY_DELIVERY_TARGET_MS),
            terminal_updates.recv(),
        )
        .await
        .expect("readiness transition stays inside delivery target")
        .expect("terminal channel stays open"),
        state
    );
}

#[tokio::test]
async fn fresh_terminal_subscription_drops_lagged_retained_tail() {
    let state = |observed_at| VmTerminalState {
        run_id: "run-1".to_string(),
        vm_name: "web".to_string(),
        state: VmTerminalStateKind::Pending,
        terminal_target: None,
        reason: Some(format!("revision-{observed_at}")),
        observed_at,
        runtime_constraints: None,
    };
    let (terminal_tx, _) = tokio::sync::broadcast::channel(1);
    let mut lagged = terminal_tx.subscribe();
    terminal_tx.send(state(1)).expect("first transition");
    terminal_tx.send(state(2)).expect("second transition");
    assert!(matches!(
        lagged.recv().await,
        Err(tokio::sync::broadcast::error::RecvError::Lagged(1))
    ));

    // The bridge replaces a lagged receiver and uses cached inventory as
    // authority, so the retained revision 2 must not enter the urgent FIFO.
    let mut fresh = terminal_tx.subscribe();
    terminal_tx.send(state(3)).expect("future transition");
    assert_eq!(fresh.recv().await.expect("fresh transition"), state(3));
}

#[tokio::test]
async fn outbound_writer_prioritizes_urgent_terminal_reports() {
    let (urgent_tx, mut urgent_rx) = mpsc::channel(1);
    let (inventory_tx, mut inventory_rx) = mpsc::channel(1);
    let (normal_tx, mut normal_rx) = mpsc::channel(1);
    normal_tx
        .send(BridgeMessageV6::SyncRequest(SyncRequestV6 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: "normal".to_string(),
            reason: SyncRequestReason::Connect,
        }))
        .await
        .expect("queue normal message");
    inventory_tx
        .send(BridgeMessageV6::SyncRequest(SyncRequestV6 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: "inventory".to_string(),
            reason: SyncRequestReason::Reconnect,
        }))
        .await
        .expect("queue inventory message");
    urgent_tx
        .send(BridgeMessageV6::SyncRequest(SyncRequestV6 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: "terminal".to_string(),
            reason: SyncRequestReason::Reconnect,
        }))
        .await
        .expect("queue urgent terminal message");

    let next = timeout(
        Duration::from_millis(INVENTORY_DELIVERY_TARGET_MS),
        next_outbound_message(&mut urgent_rx, &mut inventory_rx, &mut normal_rx),
    )
    .await
    .expect("priority dequeue stays inside terminal budget")
    .expect("queued message");

    assert_eq!(bridge_message_host_id(&next), "terminal");
}

#[tokio::test]
async fn outbound_writer_prioritizes_inventory_reports() {
    let (_urgent_tx, mut urgent_rx) = mpsc::channel(1);
    let (inventory_tx, mut inventory_rx) = mpsc::channel(1);
    let (normal_tx, mut normal_rx) = mpsc::channel(1);
    normal_tx
        .send(BridgeMessageV6::SyncRequest(SyncRequestV6 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: "normal".to_string(),
            reason: SyncRequestReason::Connect,
        }))
        .await
        .expect("queue normal message");
    inventory_tx
        .send(BridgeMessageV6::SyncRequest(SyncRequestV6 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: "inventory".to_string(),
            reason: SyncRequestReason::Reconnect,
        }))
        .await
        .expect("queue inventory message");

    let next = timeout(
        Duration::from_millis(INVENTORY_DELIVERY_TARGET_MS),
        next_outbound_message(&mut urgent_rx, &mut inventory_rx, &mut normal_rx),
    )
    .await
    .expect("priority dequeue stays inside inventory budget")
    .expect("queued message");

    assert_eq!(bridge_message_host_id(&next), "inventory");
}

#[test]
fn bounded_inventory_path_fits_delivery_target() {
    let worst_case_ms = INVENTORY_REPORT_JAILER_BUDGET_MS
        .saturating_add(OUTBOUND_SEND_BUDGET_MS)
        .saturating_add(OUTBOUND_SEND_BUDGET_MS);
    assert!(worst_case_ms < INVENTORY_DELIVERY_TARGET_MS);
}

#[test]
fn bounded_urgent_path_fits_delivery_target() {
    // Eight VM creates may finalize together. Include one send already in
    // flight plus the entire bounded urgent FIFO; a blocked ninth enqueue
    // cannot extend the last admitted transition past this bound.
    let worst_case_ms =
        OUTBOUND_SEND_BUDGET_MS.saturating_mul((URGENT_OUTBOUND_CAPACITY as u64).saturating_add(1));
    assert!(worst_case_ms < INVENTORY_DELIVERY_TARGET_MS);
}

#[test]
fn terminal_updates_are_run_and_generation_fenced() {
    assert!(terminal_identities_match(
        "run-1",
        Some("generation-2"),
        &VmTerminalStateKind::Ready,
        Some("run-1"),
        Some("generation-2"),
    ));
    assert!(!terminal_identities_match(
        "run-1",
        Some("generation-1"),
        &VmTerminalStateKind::Ready,
        Some("run-1"),
        Some("generation-2"),
    ));
    assert!(!terminal_identities_match(
        "run-old",
        Some("generation-2"),
        &VmTerminalStateKind::Ready,
        Some("run-new"),
        Some("generation-2"),
    ));
    assert!(!terminal_identities_match(
        "run-1",
        None,
        &VmTerminalStateKind::Ready,
        Some("run-1"),
        None,
    ));
    assert!(terminal_identities_match(
        "run-1",
        None,
        &VmTerminalStateKind::Failed,
        Some("run-1"),
        None,
    ));
}

#[test]
fn immutable_attestation_survives_transient_live_refresh_failure() {
    assert_eq!(preserve_last_attestation(None, Some(&42_u8)), Some(42));
    assert_eq!(
        preserve_last_attestation(Some(&7_u8), Some(&42_u8)),
        Some(7)
    );
    assert_eq!(preserve_last_attestation::<u8>(None, None), None);
}

#[test]
fn explicit_terminal_contract_exposes_targets_only_when_ready() {
    let ready = terminal_state_from_manager(&VmTerminalState {
        run_id: "run-1".to_string(),
        vm_name: "web".to_string(),
        state: VmTerminalStateKind::Ready,
        terminal_target: Some(VmTerminalTarget {
            host: Some("203.0.113.7".to_string()),
            port: 22_001,
            username: "ubuntu".to_string(),
            checked_at: 2_000,
        }),
        reason: None,
        observed_at: 2_000,
        runtime_constraints: None,
    });
    assert_eq!(ready.state, VmTerminalStateKindV1::Ready);
    assert_eq!(
        ready.target.as_ref().map(|target| target.port),
        Some(22_001)
    );

    let pending = terminal_state_from_manager(&VmTerminalState {
        run_id: "run-1".to_string(),
        vm_name: "web".to_string(),
        state: VmTerminalStateKind::Pending,
        terminal_target: Some(VmTerminalTarget {
            host: Some("203.0.113.7".to_string()),
            port: 22_001,
            username: "ubuntu".to_string(),
            checked_at: 2_000,
        }),
        reason: Some("sealing CPU quota".to_string()),
        observed_at: 2_000,
        runtime_constraints: None,
    });
    assert_eq!(pending.state, VmTerminalStateKindV1::Pending);
    assert_eq!(pending.target, None);
}

#[test]
fn agent_desired_state_rejects_build_assignments() {
    let mut desired = empty_desired_state(1);
    validate_desired_state("host-1", &desired).expect("empty builds should be valid");

    desired
        .builds
        .push(intar_contracts::bridge::DesiredBuildV1 {
            build_id: "build-1".to_string(),
            scenario_id: "broken-nginx".to_string(),
            arch: ImageArchitecture::X86_64,
            rev: "abc123".to_string(),
            content_hash: "f".repeat(64),
            bundle_ref: "builds/bundles/abc123.tar.gz".to_string(),
            kino_version: "0.1.24".to_string(),
        });
    let error = validate_desired_state("host-1", &desired)
        .expect_err("agents must reject builder assignments");
    assert!(format!("{error:#}").contains("must not contain build assignments"));
}

#[test]
fn desired_state_versions_never_regress() {
    let current = empty_desired_state(7);

    assert!(desired_state_is_stale(
        Some(&current),
        &empty_desired_state(6)
    ));
    assert!(!desired_state_is_stale(
        Some(&current),
        &empty_desired_state(7)
    ));
    assert!(!desired_state_is_stale(
        Some(&current),
        &empty_desired_state(8)
    ));
    assert!(!desired_state_is_stale(None, &empty_desired_state(1)));
}

#[test]
fn image_cache_key_matches_committed_catalog_format() {
    assert_eq!(
        image_cache_key(&desired_vm().image_key),
        "broken-nginx-web-x86_64"
    );
}

#[test]
fn creating_vm_is_booting_only_after_runtime_constraints_exist() {
    assert_eq!(creating_vm_report_phase(false), VmPhase::CreatingDisks);
    assert_eq!(creating_vm_report_phase(true), VmPhase::Booting);
}

#[test]
fn desired_peer_aliases_map_runtime_names_to_manifest_vm_names() {
    let mut web = desired_vm();
    web.run_id = "run-pair".to_string();
    web.vm_name = "pair-ping-web-bv1xgh-1".to_string();
    web.image_key.scenario = "pair-ping".to_string();
    web.image_key.vm = "web".to_string();

    let mut db = web.clone();
    db.vm_name = "pair-ping-db-bv1xgh-2".to_string();
    db.image_key.vm = "db".to_string();

    let mut absent = web.clone();
    absent.vm_name = "pair-ping-cache-bv1xgh-3".to_string();
    absent.image_key.vm = "cache".to_string();
    absent.desired_phase = DesiredVmPhase::Absent;

    let mut other_run = web.clone();
    other_run.run_id = "other-run".to_string();
    other_run.vm_name = "pair-ping-other-abcdef-1".to_string();
    other_run.image_key.vm = "other".to_string();

    let desired = HostDesiredStateV2 {
        schema_version: HOST_DESIRED_STATE_SCHEMA_VERSION,
        host_id: "host-1".to_string(),
        version: 1,
        generated_at_unix_ms: 123,
        cached_images: Vec::new(),
        vms: vec![web.clone(), db.clone(), absent, other_run],
        builds: Vec::new(),
    };

    assert_eq!(
        desired_peer_vm_aliases(&desired, &web),
        BTreeMap::from([(db.vm_name, "db".to_string())])
    );
}

#[tokio::test]
async fn cached_image_state_requires_verified_launch_descriptor() {
    let temp = tempfile::tempdir().expect("tempdir");
    let vm = desired_vm();
    let image_sha256 = vm.image_sha256.clone();
    let cache_key = image_cache_key(&vm.image_key);
    let image_dir = temp.path().join(&cache_key);
    std::fs::create_dir_all(&image_dir).expect("image cache dir");
    let raw_path = image_dir.join(format!("{image_sha256}.raw"));
    std::fs::write(&raw_path, b"raw").expect("raw cache file");
    let desired = HostDesiredStateV2 {
        schema_version: HOST_DESIRED_STATE_SCHEMA_VERSION,
        host_id: "host-1".to_string(),
        version: 1,
        generated_at_unix_ms: 123,
        cached_images: vec![DesiredCachedImageV1 {
            image_key: vm.image_key.clone(),
            image_sha256: image_sha256.clone(),
        }],
        vms: Vec::new(),
        builds: Vec::new(),
    };

    let unverified = cached_image_states_with_cache_root(&desired, 456, Some(temp.path()), false);
    assert_eq!(unverified[0].phase, ImageCachePhase::Missing);
    assert_eq!(unverified[0].bytes_on_disk, None);

    std::fs::write(
        image_dir.join(format!("{image_sha256}.raw.verified.json")),
        format!(
            r#"{{"schema_version":3,"image_key":"{cache_key}","image_sha256":"{image_sha256}","image_virtual_size_bytes":3,"raw_sha256":"{}","kernel_sha256":"{}","initrd_sha256":"{}","cmdline":"root=/dev/vda rw"}}"#,
            "a".repeat(64),
            "b".repeat(64),
            "c".repeat(64),
        ),
    )
    .expect("raw cache marker");

    let verified = cached_image_states_with_cache_root(&desired, 789, Some(temp.path()), false);
    assert_eq!(verified[0].phase, ImageCachePhase::Ready);
    assert_eq!(verified[0].bytes_on_disk, Some(3));

    let template_missing =
        cached_image_states_with_cache_root(&desired, 790, Some(temp.path()), true);
    assert_eq!(template_missing[0].phase, ImageCachePhase::Missing);
    let artifacts = temp.path().join("artifacts");
    std::fs::create_dir_all(&artifacts).expect("boot artifact cache");
    let kernel_sha256 = "b".repeat(64);
    let initrd_sha256 = "c".repeat(64);
    let raw_sha256 = "a".repeat(64);
    let kernel_path = artifacts.join(&kernel_sha256);
    let initrd_path = artifacts.join(&initrd_sha256);
    std::fs::write(&kernel_path, b"kernel").expect("cached kernel artifact");
    std::fs::write(&initrd_path, b"initrd").expect("cached initrd artifact");
    let prepared_source =
        |name: &str, sha256: &str, access: intar_jailer_protocol::ArtifactAccess| {
            intar_jailer_protocol::ArtifactSource {
                source_root: intar_jailer_protocol::PREPARED_IMAGE_SOURCE_ROOT,
                relative_path: PathBuf::from(&image_sha256).join(name),
                sha256: Some(
                    intar_jailer_protocol::Sha256Digest::parse(sha256.to_string())
                        .expect("prepared digest"),
                ),
                access,
            }
        };
    let cached = crate::image_cache::CachedImage {
        image_key: cache_key,
        image_sha256: image_sha256.clone(),
        raw_path,
        raw_sha256: raw_sha256.clone(),
        kernel_path,
        initrd_path,
        kernel_sha256: kernel_sha256.clone(),
        initrd_sha256: initrd_sha256.clone(),
        cmdline: "root=/dev/vda rw".to_string(),
        virtual_size_bytes: 3,
    };
    let prepared = intar_jailer_protocol::PreparedImageV2Result {
        image_sha256: intar_jailer_protocol::Sha256Digest::parse(image_sha256.clone())
            .expect("image digest"),
        virtual_size_bytes: 3,
        root_disk: prepared_source(
            "root.raw",
            &raw_sha256,
            intar_jailer_protocol::ArtifactAccess::ReadWrite,
        ),
        kernel: prepared_source(
            "kernel",
            &kernel_sha256,
            intar_jailer_protocol::ArtifactAccess::ReadOnly,
        ),
        initrd: Some(prepared_source(
            "initrd",
            &initrd_sha256,
            intar_jailer_protocol::ArtifactAccess::ReadOnly,
        )),
        fast_template_store: true,
    };
    crate::image_cache::mark_template_ready(&cached, &prepared)
        .await
        .expect("publish launch descriptor");
    let template_ready =
        cached_image_states_with_cache_root(&desired, 791, Some(temp.path()), true);
    assert_eq!(template_ready[0].phase, ImageCachePhase::Ready);
}

#[test]
fn desired_lease_duration_has_minimum_one_second() {
    let mut vm = desired_vm();
    vm.lease_expires_at_unix_ms = now_ms() - 1_000;
    assert_eq!(
        desired_lease_duration_seconds(&vm, now_ms()).expect("lease"),
        1
    );
}
