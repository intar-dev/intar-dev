use super::*;

#[tokio::test]
async fn inventory_revision_is_immediate_and_coalesces_bursts() {
    let (updates, mut receiver) = watch::channel(0_u64);

    advance_inventory_revision(&updates);
    advance_inventory_revision(&updates);

    timeout(Duration::from_millis(250), receiver.changed())
        .await
        .expect("inventory update must be observable inside the freshness budget")
        .expect("inventory update channel stays open");
    assert_eq!(*receiver.borrow(), 2, "adjacent mutations are coalesced");

    advance_inventory_revision(&updates);
    timeout(Duration::from_millis(250), receiver.changed())
        .await
        .expect("a mutation after the observed snapshot must remain pending")
        .expect("inventory update channel stays open");
    assert_eq!(*receiver.borrow(), 3);
}

#[tokio::test]
async fn terminal_ready_cache_precedes_targeted_publication() {
    let terminal_states = RwLock::new(BTreeMap::new());
    let terminal_state_fingerprints = Mutex::new(BTreeMap::new());
    let (terminal_updates, mut terminal_receiver) = broadcast::channel(4);
    let state = VmTerminalState {
        run_id: "run-1".to_string(),
        vm_name: "vm-1".to_string(),
        state: VmTerminalStateKind::Ready,
        terminal_target: Some(VmTerminalTarget {
            host: Some("bridge.example.test".to_string()),
            port: 2_200,
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

    let observe_terminal = async {
        let targeted = timeout(Duration::from_millis(250), terminal_receiver.recv())
            .await
            .expect("targeted terminal transition must be prompt")
            .expect("terminal channel stays open");
        let cached = terminal_states
            .read()
            .await
            .get("vm-1")
            .cloned()
            .expect("ready state is cached before targeted publication");
        (targeted, cached)
    };
    let ((), (targeted, cached)) = tokio::join!(
        emit_terminal_state_update_to_channels(
            &terminal_states,
            &terminal_state_fingerprints,
            &terminal_updates,
            state.clone(),
            false,
        ),
        observe_terminal,
    );

    assert_eq!(targeted, state);
    assert_eq!(cached, state);

    emit_terminal_state_update_to_channels(
        &terminal_states,
        &terminal_state_fingerprints,
        &terminal_updates,
        state,
        false,
    )
    .await;
    assert!(matches!(
        terminal_receiver.try_recv(),
        Err(broadcast::error::TryRecvError::Empty)
    ));
}

#[tokio::test]
async fn staging_rollback_removes_only_the_reserved_vm_paths() {
    let temp = tempdir().expect("temp dir");
    let vm_dir = temp.path().join("vms").join("vm-1");
    let spool_dir = temp.path().join("run-spool").join("run-1").join("vm-1");
    let sibling_dir = temp.path().join("vms").join("vm-2");
    tokio::fs::create_dir_all(&vm_dir).await.expect("vm dir");
    tokio::fs::create_dir_all(spool_dir.join("artifacts"))
        .await
        .expect("spool dir");
    tokio::fs::create_dir_all(&sibling_dir)
        .await
        .expect("sibling dir");

    remove_vm_staging_paths("vm-1", &vm_dir, &spool_dir)
        .await
        .expect("rollback paths");

    assert!(!vm_dir.exists());
    assert!(!spool_dir.exists());
    assert!(sibling_dir.exists());
}

#[test]
fn generationless_cleanup_keeps_run_network_until_sibling_row_is_removed() {
    let orphan = test_vm_status("vm-orphan", Some("run-1"));
    let sibling = test_vm_status("vm-sibling", Some("run-1"));
    let mut states = BTreeMap::from([
        (orphan.name.clone(), orphan.clone()),
        (sibling.name.clone(), sibling.clone()),
    ]);

    assert!(
        generationless_v6_launch_cleanup_selector(&orphan)
            .expect("selector")
            .is_some()
    );
    assert!(has_other_tracked_vm_for_run(&states, &orphan.name, "run-1"));

    states.remove(&sibling.name);
    assert!(!has_other_tracked_vm_for_run(
        &states,
        &orphan.name,
        "run-1"
    ));
}

#[test]
fn pending_same_run_sibling_keeps_shared_network_tracked() {
    let deleting = test_vm_status("vm-deleting", Some("run-1"));
    let mut pending = test_vm_status("vm-pending", Some("run-1"));
    pending.state = VmLifecycleState::CachingImage;
    assert_eq!(
        pending
            .details
            .as_ref()
            .and_then(|details| details.jail_generation.as_deref()),
        None,
        "fixture must represent a sibling not yet committed to jailerd"
    );
    let states = BTreeMap::from([
        (deleting.name.clone(), deleting),
        (pending.name.clone(), pending),
    ]);

    assert!(has_other_tracked_vm_for_run(
        &states,
        "vm-deleting",
        "run-1"
    ));
}

#[test]
fn ordered_same_run_cleanup_recognizes_the_last_vm_after_predecessor_removal() {
    let first = test_vm_status("vm-first", Some("run-1"));
    let last = test_vm_status("vm-last", Some("run-1"));
    let mut states = BTreeMap::from([(first.name.clone(), first), (last.name.clone(), last)]);

    assert!(has_other_tracked_vm_for_run(&states, "vm-first", "run-1"));
    states.remove("vm-first");
    assert!(!has_other_tracked_vm_for_run(&states, "vm-last", "run-1"));
}

#[tokio::test]
async fn run_lock_serializes_cleanup_and_launch_without_blocking_other_runs() {
    let locks = Arc::new(Mutex::new(BTreeMap::new()));
    let cleanup_guard = acquire_run_cleanup_lock(&locks, "run-1").await;

    let (attempting_tx, attempting_rx) = tokio::sync::oneshot::channel();
    let (acquired_tx, mut acquired_rx) = tokio::sync::oneshot::channel();
    let same_run_locks = Arc::clone(&locks);
    let launch_task = tokio::spawn(async move {
        let _ = attempting_tx.send(());
        let _launch_guard = acquire_run_cleanup_lock(&same_run_locks, "run-1").await;
        let _ = acquired_tx.send(());
    });
    attempting_rx.await.expect("same-run launch started");

    assert!(
        timeout(Duration::from_millis(25), &mut acquired_rx)
            .await
            .is_err(),
        "same-run launch acquired its lock before cleanup completed"
    );

    let other_run_guard = timeout(
        Duration::from_secs(1),
        acquire_run_cleanup_lock(&locks, "run-2"),
    )
    .await
    .expect("another run's launch must not wait behind run-1 cleanup");
    drop(other_run_guard);

    drop(cleanup_guard);
    timeout(Duration::from_secs(1), &mut acquired_rx)
        .await
        .expect("same-run launch should continue after cleanup")
        .expect("same-run launch should report lock acquisition");
    launch_task.await.expect("same-run launch completed");
}

#[tokio::test]
async fn legacy_capture_uses_the_run_lock_but_per_vm_spools_do_not() {
    let locks = Arc::new(Mutex::new(BTreeMap::new()));
    let legacy = test_vm_status("vm-legacy", Some("run-1"));
    assert!(requires_run_cleanup_lock_for_capture(&legacy));

    let legacy_capture_guard = acquire_run_cleanup_lock_for_capture(&locks, &legacy)
        .await
        .expect("legacy capture must hold the run lock");
    let (attempting_tx, attempting_rx) = tokio::sync::oneshot::channel();
    let (acquired_tx, mut acquired_rx) = tokio::sync::oneshot::channel();
    let same_run_locks = Arc::clone(&locks);
    let same_run_legacy = legacy.clone();
    let capture_task = tokio::spawn(async move {
        let _ = attempting_tx.send(());
        let _capture_guard =
            acquire_run_cleanup_lock_for_capture(&same_run_locks, &same_run_legacy)
                .await
                .expect("legacy sibling capture must use the run lock");
        let _ = acquired_tx.send(());
    });
    attempting_rx.await.expect("legacy sibling capture started");
    assert!(
        timeout(Duration::from_millis(25), &mut acquired_rx)
            .await
            .is_err(),
        "legacy sibling capture entered the shared run spool before its predecessor completed"
    );

    drop(legacy_capture_guard);
    timeout(Duration::from_secs(1), &mut acquired_rx)
        .await
        .expect("legacy sibling capture should continue after the run lock releases")
        .expect("legacy sibling capture should report lock acquisition");
    capture_task
        .await
        .expect("legacy sibling capture completed");

    let mut per_vm_spool = test_vm_status("vm-isolated", Some("run-1"));
    per_vm_spool
        .details
        .as_mut()
        .expect("fixture has VM details")
        .spool_dir = Some("/tmp/run-1/vm-isolated".to_string());
    assert!(!requires_run_cleanup_lock_for_capture(&per_vm_spool));

    let release_phase_guard = acquire_run_cleanup_lock(&locks, "run-1").await;
    let capture_guard = timeout(
        Duration::from_millis(25),
        acquire_run_cleanup_lock_for_capture(&locks, &per_vm_spool),
    )
    .await
    .expect("per-VM capture must not wait for another cleanup release phase");
    assert!(
        capture_guard.is_none(),
        "per-VM artifact spools must retain concurrent capture"
    );
    drop(release_phase_guard);
}

#[test]
#[cfg(target_os = "linux")]
fn probe_replay_preserves_stored_envelope_payload() {
    let stored = ProbeUpdateEnvelope {
        update_id: "update-1".to_string(),
        vm_name: "vm-1".to_string(),
        run_id: "run-1".to_string(),
        jail_generation: "generation-1".to_string(),
        generated_at_ms: 123,
        collection_state: ProbeCollectionState::Ok,
        collection_error: None,
        fingerprint: "fp-1".to_string(),
        summary: ProbeSummary {
            total: 1,
            pass: 1,
            fail: 0,
            unknown: 0,
        },
        ssh_host_keys_openssh: vec!["ssh-ed25519 AAAAHOST host".to_string()],
        kino_sha256: "a".repeat(64),
        guest_bootstrap_abi: 1,
        guest_phase_timings: GuestPhaseTimings {
            ready_uptime_ms: 1_000,
            ..GuestPhaseTimings::default()
        },
        probes: vec![ProbeView {
            id: "boot".to_string(),
            kind: "probe".to_string(),
            status: "pass".to_string(),
            every_seconds: 5,
            last_attempt_at_ms: Some(120),
            last_success_at_ms: Some(120),
            last_duration_ms: 10,
            error: None,
            value: json!({"ok": true}),
        }],
    };
    let row = VmProbeStateRow {
        vm_name: stored.vm_name.clone(),
        run_id: stored.run_id.clone(),
        fingerprint: stored.fingerprint.clone(),
        collection_state: "ok".to_string(),
        collection_error: None,
        summary_json: serde_json::to_string(&stored.summary).expect("summary json"),
        snapshot_json: serde_json::to_string(&stored).expect("envelope json"),
        generated_at_ms: stored.generated_at_ms,
        updated_at_ms: 125,
    };

    let replayed = probe_update_from_state_row(&row).expect("replayed envelope");

    assert_eq!(replayed.update_id, stored.update_id);
    assert_eq!(replayed.vm_name, stored.vm_name);
    assert_eq!(replayed.run_id, stored.run_id);
    assert_eq!(replayed.generated_at_ms, stored.generated_at_ms);
    assert_eq!(replayed.fingerprint, stored.fingerprint);
    assert_eq!(replayed.summary, stored.summary);
    assert_eq!(replayed.ssh_host_keys_openssh, stored.ssh_host_keys_openssh);
    assert_eq!(replayed.probes, stored.probes);
}

#[test]
#[cfg(target_os = "linux")]
fn guest_tools_readiness_fails_closed_on_sha_abi_and_timing_mismatch() {
    let ready = ProbeUpdateEnvelope {
        update_id: "update-1".to_string(),
        vm_name: "vm-1".to_string(),
        run_id: "run-1".to_string(),
        jail_generation: "generation-1".to_string(),
        generated_at_ms: 123,
        collection_state: ProbeCollectionState::Ok,
        collection_error: None,
        fingerprint: "fp-1".to_string(),
        summary: ProbeSummary {
            total: 0,
            pass: 0,
            fail: 0,
            unknown: 0,
        },
        ssh_host_keys_openssh: vec![],
        kino_sha256: "a".repeat(64),
        guest_bootstrap_abi: 1,
        guest_phase_timings: GuestPhaseTimings {
            ready_uptime_ms: 1_000,
            ..GuestPhaseTimings::default()
        },
        probes: vec![],
    };
    validate_guest_tools_readiness(&ready, &"a".repeat(64), 1).expect("matching pin");
    assert!(validate_guest_tools_readiness(&ready, &"b".repeat(64), 1).is_err());
    assert!(validate_guest_tools_readiness(&ready, &"a".repeat(64), 2).is_err());
    let mut missing_timings = ready;
    missing_timings.guest_phase_timings.ready_uptime_ms = 0;
    assert!(validate_guest_tools_readiness(&missing_timings, &"a".repeat(64), 1).is_err());
}
