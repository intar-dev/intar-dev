use super::*;

#[test]
fn run_bridge_name_is_stable_and_fits_linux_interface_limit() {
    let first = run_bridge_name("run-alpha");
    let second = run_bridge_name("run-alpha");
    let other = run_bridge_name("run-beta");

    assert_eq!(first, second);
    assert_ne!(first, other);
    assert!(first.starts_with("intar"));
    assert!(first.len() <= 15);
}

#[test]
fn gateway_for_guest_cidr_uses_first_host_in_subnet() {
    assert_eq!(
        gateway_for_guest_cidr("10.77.12.8/28").expect("gateway"),
        "10.77.12.1"
    );
}

#[test]
fn peer_vm_topology_keeps_runtime_names_and_validates_logical_aliases() {
    let db_runtime_name = "pair-ping-db-abc123-2".to_string();
    let (peer_vm_names, peer_vm_aliases) = normalize_peer_vm_topology(
        "pair-ping-web-abc123-1",
        vec![db_runtime_name.clone()],
        BTreeMap::from([(db_runtime_name.clone(), "db".to_string())]),
    )
    .expect("peer topology");

    assert_eq!(peer_vm_names, vec![db_runtime_name.clone()]);
    assert_eq!(
        peer_vm_aliases.get(&db_runtime_name).map(String::as_str),
        Some("db")
    );

    for aliases in [
        BTreeMap::from([("../runtime-db".to_string(), "db".to_string())]),
        BTreeMap::from([(db_runtime_name.clone(), "../db".to_string())]),
    ] {
        let error = normalize_peer_vm_topology(
            "pair-ping-web-abc123-1",
            vec![db_runtime_name.clone()],
            aliases,
        )
        .expect_err("unsafe alias topology must fail");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert!(error.message.contains("must match [A-Za-z0-9_-]+"));
    }

    let error = normalize_peer_vm_topology(
        "pair-ping-web-abc123-1",
        vec![db_runtime_name],
        BTreeMap::from([("pair-ping-cache-abc123-3".to_string(), "cache".to_string())]),
    )
    .expect_err("unknown runtime peer alias must fail");
    assert!(error.message.contains("does not name a runtime peer"));
}

#[test]
fn peer_vm_topology_rejects_duplicate_and_fallback_alias_collisions() {
    let db_runtime_name = "pair-ping-db-abc123-2".to_string();
    let cache_runtime_name = "pair-ping-cache-abc123-3".to_string();
    let error = normalize_peer_vm_topology(
        "pair-ping-web-abc123-1",
        vec![db_runtime_name.clone(), cache_runtime_name.clone()],
        BTreeMap::from([
            (db_runtime_name, "backend".to_string()),
            (cache_runtime_name, "backend".to_string()),
        ]),
    )
    .expect_err("duplicate logical aliases must fail");
    assert!(
        error
            .message
            .contains("duplicate logical peer name \"backend\"")
    );

    let db_runtime_name = "pair-ping-db-abc123-2".to_string();
    let error = normalize_peer_vm_topology(
        "pair-ping-web-abc123-1",
        vec!["db".to_string(), db_runtime_name.clone()],
        BTreeMap::from([(db_runtime_name, "db".to_string())]),
    )
    .expect_err("alias colliding with a fallback runtime name must fail");
    assert!(error.message.contains("duplicate logical peer name \"db\""));
}

#[test]
fn peer_vm_topology_rejects_duplicate_normalized_alias_keys() {
    let runtime_name = "pair-ping-db-abc123-2".to_string();
    let error = normalize_peer_vm_topology(
        "pair-ping-web-abc123-1",
        vec![runtime_name.clone()],
        BTreeMap::from([
            (runtime_name.clone(), "db".to_string()),
            (format!(" {runtime_name} "), "database".to_string()),
        ]),
    )
    .expect_err("duplicate normalized alias keys must fail");
    assert!(error.message.contains("duplicate normalized key"));
}

#[test]
fn peer_vm_topology_rejects_lossy_environment_alias_collisions() {
    let redis_dash_runtime_name = "pair-ping-redis-dash-abc123-2".to_string();
    let redis_underscore_runtime_name = "pair-ping-redis-underscore-abc123-3".to_string();
    let error = normalize_peer_vm_topology(
        "pair-ping-web-abc123-1",
        vec![
            redis_dash_runtime_name.clone(),
            redis_underscore_runtime_name.clone(),
        ],
        BTreeMap::from([
            (redis_dash_runtime_name, "redis-cache".to_string()),
            (redis_underscore_runtime_name, "redis_cache".to_string()),
        ]),
    )
    .expect_err("aliases that render the same environment key must fail");

    assert!(
        error
            .message
            .contains("duplicate environment peer name \"REDIS_CACHE\"")
    );
}

#[test]
fn allocate_guest_ip_in_subnet_skips_gateway_and_used_ips() {
    let subnet = u32::from(Ipv4Addr::new(10, 77, 12, 0));
    let gateway = Ipv4Addr::new(10, 77, 12, 1);
    let first = allocate_guest_ip_in_subnet(subnet, 28, "web", &BTreeSet::new(), gateway)
        .expect("first guest ip");
    let mut used = BTreeSet::new();
    used.insert(u32::from(first));

    let second =
        allocate_guest_ip_in_subnet(subnet, 28, "web", &used, gateway).expect("second guest ip");

    assert_ne!(first, gateway);
    assert_ne!(second, gateway);
    assert_ne!(first, second);
}

#[test]
fn allocate_run_guest_ips_reserves_existing_peer_addresses() {
    let subnet = u32::from(Ipv4Addr::new(10, 77, 12, 0));
    let gateway = Ipv4Addr::new(10, 77, 12, 1);
    let existing_db = Ipv4Addr::new(10, 77, 12, 3);
    let used = BTreeSet::from([u32::from(gateway), u32::from(existing_db)]);
    let web_runtime_name = "pair-ping-web-abc123-1";
    let db_runtime_name = "pair-ping-db-abc123-2".to_string();
    let redis_runtime_name = "pair-ping-redis-cache-abc123-3".to_string();
    let peer_vm_names = vec![db_runtime_name.clone(), redis_runtime_name.clone()];
    let peer_vm_aliases = BTreeMap::from([
        (db_runtime_name.clone(), "db".to_string()),
        (redis_runtime_name.clone(), "redis-cache".to_string()),
    ]);
    let existing = BTreeMap::from([(db_runtime_name.clone(), existing_db)]);
    let names = run_allocation_vm_names(web_runtime_name, &peer_vm_names);

    let allocations = allocate_run_guest_ips(subnet, 28, gateway, &used, &existing, &names)
        .expect("run addresses");

    assert_eq!(allocations.get(&db_runtime_name), Some(&existing_db));
    assert_ne!(
        allocations.get(web_runtime_name),
        allocations.get(&db_runtime_name)
    );
    assert_ne!(
        allocations.get(&redis_runtime_name),
        allocations.get(&db_runtime_name)
    );
    assert_eq!(
        peer_guest_ip_strings(
            &peer_vm_names,
            web_runtime_name,
            &allocations,
            &peer_vm_aliases,
        )
        .expect("logical peer map")
        .keys()
        .cloned()
        .collect::<Vec<_>>(),
        vec!["db".to_string(), "redis-cache".to_string()]
    );
}

#[test]
fn ch_not_created_error_matches_only_404() {
    let e404 = ChError::HttpStatus {
        status: 404,
        body: "not found".to_string(),
    };
    assert!(ch_is_not_created_error(&e404));

    let e500 = ChError::HttpStatus {
        status: 500,
        body: r#"["Error from API","The VM info is not available","VM is not created"]"#
            .to_string(),
    };
    assert!(!ch_is_not_created_error(&e500));
}

#[test]
fn ch_not_started_error_matches_only_405() {
    let e405 = ChError::HttpStatus {
        status: 405,
        body: "vm not started".to_string(),
    };
    assert!(ch_is_not_started_error(&e405));

    let e500 = ChError::HttpStatus {
        status: 500,
        body: r#"["Error from API","The VM could not shutdown","VM is not running"]"#.to_string(),
    };
    assert!(!ch_is_not_started_error(&e500));
}

#[test]
fn vm_info_status_classification() {
    assert!(ch_vm_info_is_absent_status(404));
    assert!(!ch_vm_info_is_absent_status(500));

    assert!(ch_vm_info_is_ambiguous_status(500));
    assert!(ch_vm_info_is_ambiguous_status(503));
    assert!(!ch_vm_info_is_ambiguous_status(404));
    assert!(!ch_vm_info_is_ambiguous_status(405));
}

#[test]
fn pinned_v53_shutdown_proof_requires_created_or_definitively_absent_vm() {
    let created = cloud_hypervisor_client::VmInfo {
        config: cloud_hypervisor_client::VmConfig::default(),
        state: cloud_hypervisor_client::VmState::Created,
        memory_actual_size: None,
    };
    assert!(v53_post_shutdown_state_is_proven(&created));

    for state in [
        cloud_hypervisor_client::VmState::Running,
        cloud_hypervisor_client::VmState::Paused,
        cloud_hypervisor_client::VmState::Shutdown,
    ] {
        assert!(
            !v53_post_shutdown_state_is_proven(&cloud_hypervisor_client::VmInfo {
                state,
                ..created.clone()
            }),
            "only pinned-v53 Created proves a completed shutdown"
        );
    }

    let absent = ChError::HttpStatus {
        status: 404,
        body: "VM is not created".to_string(),
    };
    assert!(vm_info_confirms_vm_absent(&absent));

    let inconclusive = ChError::HttpStatus {
        status: 500,
        body: "temporary API failure".to_string(),
    };
    assert!(!vm_info_confirms_vm_absent(&inconclusive));
}

#[tokio::test(start_paused = true)]
async fn post_shutdown_grace_only_skips_the_two_definitive_v53_proofs() {
    let grace = Duration::from_secs(DELETE_SHUTDOWN_GRACE_SECONDS);
    let created = cloud_hypervisor_client::VmInfo {
        config: cloud_hypervisor_client::VmConfig::default(),
        state: cloud_hypervisor_client::VmState::Created,
        memory_actual_size: None,
    };

    let created_classified = Arc::new(Notify::new());
    let created_classified_for_probe = Arc::clone(&created_classified);
    let created_for_fast_path = created.clone();
    let created_started_at = tokio::time::Instant::now();
    let created_deadline = created_started_at + grace;
    let created_task = tokio::spawn(async move {
        wait_for_post_shutdown_probe_grace(
            created_deadline,
            async move { Ok::<_, ChError>(created_for_fast_path) },
            move |probe_result| {
                let proven = post_shutdown_vm_info_proves_stopped(probe_result);
                created_classified_for_probe.notify_one();
                proven
            },
        )
        .await
    });
    created_classified.notified().await;
    assert!(
        created_task.is_finished(),
        "Created must skip the post-response shutdown grace"
    );
    assert_eq!(tokio::time::Instant::now(), created_started_at);
    assert!(
        created_task
            .await
            .expect("Created grace task must not panic")
            .is_ok()
    );

    let absent_classified = Arc::new(Notify::new());
    let absent_classified_for_probe = Arc::clone(&absent_classified);
    let absent_started_at = tokio::time::Instant::now();
    let absent_deadline = absent_started_at + grace;
    let absent_task = tokio::spawn(async move {
        wait_for_post_shutdown_probe_grace(
            absent_deadline,
            async move {
                Err::<cloud_hypervisor_client::VmInfo, _>(ChError::HttpStatus {
                    status: 404,
                    body: "VM is not created".to_string(),
                })
            },
            move |probe_result| {
                let proven = post_shutdown_vm_info_proves_stopped(probe_result);
                absent_classified_for_probe.notify_one();
                proven
            },
        )
        .await
    });
    absent_classified.notified().await;
    assert!(
        absent_task.is_finished(),
        "a definitive vm.info 404 must skip the post-response shutdown grace"
    );
    assert_eq!(tokio::time::Instant::now(), absent_started_at);
    assert!(
        absent_task
            .await
            .expect("absent-VM grace task must not panic")
            .is_ok()
    );

    let running_classified = Arc::new(Notify::new());
    let running_classified_for_probe = Arc::clone(&running_classified);
    let running_started_at = tokio::time::Instant::now();
    let running_deadline = running_started_at + grace;
    let running_task = tokio::spawn(async move {
        wait_for_post_shutdown_probe_grace(
            running_deadline,
            async move {
                Ok::<_, ChError>(cloud_hypervisor_client::VmInfo {
                    state: cloud_hypervisor_client::VmState::Running,
                    ..created.clone()
                })
            },
            move |probe_result| {
                let proven = post_shutdown_vm_info_proves_stopped(probe_result);
                running_classified_for_probe.notify_one();
                proven
            },
        )
        .await
    });
    running_classified.notified().await;
    assert!(
        !running_task.is_finished(),
        "Running must not pass the shutdown grace early"
    );
    tokio::time::advance(grace - Duration::from_secs(1)).await;
    tokio::task::yield_now().await;
    assert!(
        !running_task.is_finished(),
        "Running must retain the entire five-second shutdown grace"
    );
    tokio::time::advance(Duration::from_secs(1)).await;
    tokio::task::yield_now().await;
    assert!(running_task.is_finished());
    assert_eq!(tokio::time::Instant::now(), running_started_at + grace);
    assert!(
        running_task
            .await
            .expect("Running grace task must not panic")
            .is_ok()
    );

    let failure_classified = Arc::new(Notify::new());
    let failure_classified_for_probe = Arc::clone(&failure_classified);
    let failure_started_at = tokio::time::Instant::now();
    let failure_deadline = failure_started_at + grace;
    let failure_task = tokio::spawn(async move {
        wait_for_post_shutdown_probe_grace(
            failure_deadline,
            async move {
                Err::<cloud_hypervisor_client::VmInfo, _>(ChError::HttpStatus {
                    status: 500,
                    body: "temporary API failure".to_string(),
                })
            },
            move |probe_result| {
                let proven = post_shutdown_vm_info_proves_stopped(probe_result);
                failure_classified_for_probe.notify_one();
                proven
            },
        )
        .await
    });
    failure_classified.notified().await;
    assert!(
        !failure_task.is_finished(),
        "a 500 vm.info response must not pass the shutdown grace early"
    );
    tokio::time::advance(grace - Duration::from_secs(1)).await;
    tokio::task::yield_now().await;
    assert!(
        !failure_task.is_finished(),
        "a 500 vm.info response must retain the entire five-second shutdown grace"
    );
    tokio::time::advance(Duration::from_secs(1)).await;
    tokio::task::yield_now().await;
    assert!(failure_task.is_finished());
    assert_eq!(tokio::time::Instant::now(), failure_started_at + grace);
    assert!(
        failure_task
            .await
            .expect("500 grace task must not panic")
            .is_ok()
    );

    let timeout_probe_started = Arc::new(Notify::new());
    let timeout_probe_started_for_probe = Arc::clone(&timeout_probe_started);
    let timeout_started_at = tokio::time::Instant::now();
    let timeout_deadline = timeout_started_at + grace;
    let timeout_task = tokio::spawn(async move {
        wait_for_post_shutdown_probe_grace(
            timeout_deadline,
            async move {
                timeout_probe_started_for_probe.notify_one();
                std::future::pending::<
                    std::result::Result<cloud_hypervisor_client::VmInfo, ChError>,
                >()
                .await
            },
            post_shutdown_vm_info_proves_stopped,
        )
        .await
    });
    timeout_probe_started.notified().await;
    assert!(
        !timeout_task.is_finished(),
        "a pending vm.info probe must not pass the shutdown grace early"
    );
    tokio::time::advance(grace - Duration::from_secs(1)).await;
    tokio::task::yield_now().await;
    assert!(
        !timeout_task.is_finished(),
        "a probe timeout must retain the entire five-second shutdown grace"
    );
    tokio::time::advance(Duration::from_secs(1)).await;
    tokio::task::yield_now().await;
    assert!(timeout_task.is_finished());
    assert_eq!(tokio::time::Instant::now(), timeout_started_at + grace);
    assert!(
        timeout_task
            .await
            .expect("timeout grace task must not panic")
            .is_err()
    );
}

#[test]
fn delete_status_confirms_absence() {
    assert!(ch_delete_confirms_absence_status(204));
    assert!(ch_delete_confirms_absence_status(404));
    assert!(!ch_delete_confirms_absence_status(500));
}

#[test]
fn run_begin_purged_remote_vm_matches_structured_payload() {
    assert!(is_run_purged_remote_response(
        StatusCode::GONE,
        r#"{"code":"run_purged","error":"remote run is gone"}"#
    ));
    assert!(is_run_purged_remote_response(
        StatusCode::NOT_FOUND,
        r#"{"code":"run_purged","error":"remote run is gone"}"#
    ));
    assert!(!is_run_purged_remote_response(
        StatusCode::NOT_FOUND,
        r#"{"error":"remote run is gone"}"#
    ));
    assert!(!is_run_purged_remote_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        r#"{"code":"run_purged","error":"remote run is gone"}"#
    ));
}

#[test]
fn vm_spool_dir_is_nested_under_run_id() {
    let work_dir = Path::new("/var/cache/intar-agent");

    assert_eq!(
        vm_spool_dir(work_dir, "run-1", "vm-1"),
        PathBuf::from("/var/cache/intar-agent/run-spool/run-1/vm-1")
    );
}

#[test]
fn matching_vm_names_for_run_id_returns_all_matches() {
    let mut states = BTreeMap::new();
    states.insert("vm-b".to_string(), test_vm_status("vm-b", Some("run-1")));
    states.insert("vm-a".to_string(), test_vm_status("vm-a", Some("run-1")));
    states.insert("vm-c".to_string(), test_vm_status("vm-c", Some("run-2")));
    states.insert("vm-d".to_string(), test_vm_status("vm-d", None));

    assert_eq!(
        matching_vm_names_for_run_id(&states, "run-1"),
        vec!["vm-a".to_string(), "vm-b".to_string()]
    );
}

#[test]
fn generationless_v6_cleanup_uses_only_typed_logical_identity() {
    let mut vm = test_vm_status("vm-prelaunch", Some("run-1"));

    for state in [
        VmLifecycleState::Queued,
        VmLifecycleState::CachingImage,
        VmLifecycleState::PreparingDisks,
        VmLifecycleState::CreatingVm,
        VmLifecycleState::BootingVm,
        VmLifecycleState::Running,
        VmLifecycleState::DeletingVm,
        VmLifecycleState::ArchivingArtifacts,
        VmLifecycleState::Failed,
        VmLifecycleState::DeleteFailed,
    ] {
        vm.state = state;
        let selector = generationless_v6_launch_cleanup_selector(&vm)
            .expect("valid selector")
            .expect("V6 generation-less row is eligible in every retry state");
        assert_eq!(selector.generation, None);
        assert_eq!(
            selector.run_id.as_ref().map(ValidatedId::as_str),
            Some("run-1")
        );
        assert_eq!(
            selector.vm_id.as_ref().map(ValidatedId::as_str),
            Some("vm-prelaunch")
        );
    }

    vm.details.as_mut().expect("details").jail_generation = Some("generation-1".to_string());
    assert!(
        generationless_v6_launch_cleanup_selector(&vm)
            .expect("generation selector check")
            .is_none(),
        "persisted generations must use generation identity"
    );

    let mut historical = test_vm_status("vm-historical", Some("run-1"));
    let details = historical.details.as_mut().expect("details");
    details.cpu_millis = None;
    details.vcpu_count = None;
    assert!(
        generationless_v6_launch_cleanup_selector(&historical)
            .expect("historical selector check")
            .is_none(),
        "pre-V6 generation-less rows must remain local-only"
    );
}

#[test]
fn generationless_v6_cleanup_rejects_missing_or_invalid_logical_ids() {
    let mut missing_run = test_vm_status("vm-prelaunch", None);
    missing_run.state = VmLifecycleState::CreatingVm;
    assert!(generationless_v6_launch_cleanup_selector(&missing_run).is_err());

    let invalid_vm = test_vm_status("vm/invalid", Some("run-1"));
    assert!(generationless_v6_launch_cleanup_selector(&invalid_vm).is_err());
}

#[test]
fn logical_cleanup_treats_not_found_stop_and_destroy_as_idempotent_success() {
    for operation in [
        JailerIdentityOperation::Stop,
        JailerIdentityOperation::Destroy,
    ] {
        let response = JailerResponse::Error(intar_jailer_protocol::ProtocolError::new(
            "not_found",
            "logical VM is already absent",
        ));
        assert!(
            classify_jailer_identity_response(operation, response)
                .expect("not-found cleanup is successful")
                .is_none()
        );
    }
}

#[test]
fn logical_cleanup_failure_is_not_misclassified_as_absence() {
    let response = JailerResponse::Error(intar_jailer_protocol::ProtocolError::new(
        "resource_busy",
        "unit still populated",
    ));
    assert!(classify_jailer_identity_response(JailerIdentityOperation::Destroy, response).is_err());
}

#[test]
fn provisional_state_reservation_is_atomic_and_rollback_preserves_siblings() {
    let first = test_vm_status("vm-1", Some("run-1"));
    let duplicate = first.clone();
    let sibling = test_vm_status("vm-2", Some("run-1"));
    let replacement = {
        let mut replacement = first.clone();
        replacement.created_at_s = replacement.created_at_s.saturating_add(1);
        replacement
    };
    let mut states = BTreeMap::new();

    assert!(reserve_vm_state(&mut states, first.clone()));
    assert!(!reserve_vm_state(&mut states, duplicate));
    assert!(reserve_vm_state(&mut states, sibling.clone()));
    assert!(remove_matching_vm_state(&mut states, &first));
    assert!(states.contains_key(&sibling.name));

    assert!(reserve_vm_state(&mut states, replacement));
    assert!(!remove_matching_vm_state(&mut states, &first));
    assert!(states.contains_key(&first.name));
}
