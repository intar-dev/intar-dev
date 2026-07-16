use super::*;

#[test]
fn startup_resume_only_applies_to_booting_or_running_vms() {
    assert!(should_resume_live_vm_on_startup(
        VmLifecycleState::BootingVm
    ));
    assert!(should_resume_live_vm_on_startup(VmLifecycleState::Running));
    assert!(!should_resume_live_vm_on_startup(VmLifecycleState::Queued));
    assert!(!should_resume_live_vm_on_startup(
        VmLifecycleState::DeletingVm
    ));
    assert!(!should_resume_live_vm_on_startup(
        VmLifecycleState::ArchivingArtifacts
    ));
    assert!(!should_resume_live_vm_on_startup(VmLifecycleState::Failed));
    assert!(!should_resume_live_vm_on_startup(
        VmLifecycleState::DeleteFailed
    ));
}

#[test]
fn startup_resume_reenters_booting_only_for_booting_vms() {
    assert!(startup_resume_reenters_booting(VmLifecycleState::BootingVm));
    assert!(!startup_resume_reenters_booting(VmLifecycleState::Running));
    assert!(!startup_resume_reenters_booting(
        VmLifecycleState::DeletingVm
    ));
}

#[test]
fn startup_cleanup_mode_archives_delete_path_states() {
    let mut running = test_vm_status("vm-running", Some("run-1"));
    running.state = VmLifecycleState::Running;
    assert_eq!(startup_cleanup_mode(&running), StartupCleanupMode::Archive);

    let mut deleting = test_vm_status("vm-deleting", Some("run-1"));
    deleting.state = VmLifecycleState::DeletingVm;
    assert_eq!(startup_cleanup_mode(&deleting), StartupCleanupMode::Archive);

    let mut archiving = test_vm_status("vm-archiving", Some("run-1"));
    archiving.state = VmLifecycleState::ArchivingArtifacts;
    assert_eq!(
        startup_cleanup_mode(&archiving),
        StartupCleanupMode::Archive
    );

    let mut delete_failed = test_vm_status("vm-delete-failed", Some("run-1"));
    delete_failed.state = VmLifecycleState::DeleteFailed;
    assert_eq!(
        startup_cleanup_mode(&delete_failed),
        StartupCleanupMode::Archive
    );

    let mut failed = test_vm_status("vm-failed", Some("run-1"));
    failed.state = VmLifecycleState::Failed;
    assert_eq!(startup_cleanup_mode(&failed), StartupCleanupMode::DropLocal);
}

#[test]
fn vm_status_from_row_backfills_running_at_for_delete_path_states() {
    for state in [
        VmLifecycleState::DeletingVm,
        VmLifecycleState::ArchivingArtifacts,
        VmLifecycleState::DeleteFailed,
    ] {
        let mut status = test_vm_status("vm-delete-path", Some("run-1"));
        status.state = state;
        status.updated_at_s = 42;
        status.updated_at = format_rfc3339_s(42);
        status.running_at_s = None;

        let parsed = vm_status_from_row(status.to_db_row()).expect("parsed vm row");
        assert_eq!(parsed.running_at_s, Some(42));
    }
}

#[test]
fn scenario_runtime_ready_timeout_scales_with_fractional_quota() -> Result<()> {
    assert_eq!(
        scenario_runtime_ready_timeout(2_000)?,
        Duration::from_secs(45)
    );
    assert_eq!(
        scenario_runtime_ready_timeout(1_000)?,
        Duration::from_secs(45)
    );
    assert_eq!(
        scenario_runtime_ready_timeout(999)?,
        Duration::from_secs(46)
    );
    assert_eq!(
        scenario_runtime_ready_timeout(500)?,
        Duration::from_secs(90)
    );
    assert_eq!(
        scenario_runtime_ready_timeout(125)?,
        Duration::from_secs(360)
    );
    assert_eq!(
        scenario_runtime_ready_timeout(124)?,
        Duration::from_secs(360)
    );
    assert_eq!(
        scenario_runtime_ready_timeout(126)?,
        Duration::from_secs(358)
    );
    assert_eq!(scenario_runtime_ready_timeout(1)?, Duration::from_secs(360));
    assert_eq!(
        scenario_runtime_ready_timeout(u32::MAX)?,
        Duration::from_secs(45)
    );
    assert!(scenario_runtime_ready_timeout(0).is_err());
    Ok(())
}

#[test]
fn scenario_runtime_proc_stat_parser_handles_parentheses_in_process_name() {
    let value = concat!(
        "42 (cloud hyper)visor) S ",
        "1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 ",
        "987654 20 21"
    );

    assert_eq!(parse_linux_proc_stat(value), Some(('S', 987_654)));
    assert_eq!(parse_linux_proc_stat("not a proc stat record"), None);
}

#[test]
fn scenario_runtime_liveness_fails_only_on_definitive_process_loss() {
    let alive = ScenarioRuntimeProcessObservation::Present {
        state: 'S',
        start_time_ticks: 123,
    };
    assert_eq!(
        classify_scenario_runtime_process_liveness(42, Some(123), alive),
        ScenarioRuntimeProcessLiveness::Alive
    );

    let disappeared = classify_scenario_runtime_process_liveness(
        42,
        Some(123),
        ScenarioRuntimeProcessObservation::Missing,
    );
    assert!(matches!(
        disappeared,
        ScenarioRuntimeProcessLiveness::Dead(ref reason) if reason.contains("pid 42 exited")
    ));

    let zombie = classify_scenario_runtime_process_liveness(
        42,
        Some(123),
        ScenarioRuntimeProcessObservation::Present {
            state: 'Z',
            start_time_ticks: 123,
        },
    );
    assert!(matches!(
        zombie,
        ScenarioRuntimeProcessLiveness::Dead(ref reason) if reason.contains("process state Z")
    ));

    let reused = classify_scenario_runtime_process_liveness(
        42,
        Some(123),
        ScenarioRuntimeProcessObservation::Present {
            state: 'S',
            start_time_ticks: 124,
        },
    );
    assert!(matches!(
        reused,
        ScenarioRuntimeProcessLiveness::Dead(ref reason) if reason.contains("was reused")
    ));

    assert_eq!(
        classify_scenario_runtime_process_liveness(
            42,
            None,
            ScenarioRuntimeProcessObservation::Present {
                state: 'S',
                start_time_ticks: 123,
            },
        ),
        ScenarioRuntimeProcessLiveness::Inconclusive
    );
}

#[test]
fn scenario_runtime_liveness_keeps_transient_observation_errors_inconclusive() {
    assert_eq!(
        classify_scenario_runtime_process_liveness(
            42,
            Some(123),
            ScenarioRuntimeProcessObservation::Unavailable,
        ),
        ScenarioRuntimeProcessLiveness::Inconclusive
    );
}

#[test]
fn hidden_proc_entry_is_missing_only_when_pid_probe_reports_esrch() {
    assert_eq!(
        classify_missing_proc_entry(Some(Err(rustix::io::Errno::SRCH))),
        ScenarioRuntimeProcessObservation::Missing
    );
    assert_eq!(
        classify_missing_proc_entry(Some(Err(rustix::io::Errno::PERM))),
        ScenarioRuntimeProcessObservation::Unavailable
    );
    assert_eq!(
        classify_missing_proc_entry(Some(Ok(()))),
        ScenarioRuntimeProcessObservation::Unavailable
    );
    assert_eq!(
        classify_missing_proc_entry(None),
        ScenarioRuntimeProcessObservation::Unavailable
    );
}

#[test]
fn scenario_runtime_timeout_context_reports_missing_vsock_socket() {
    let message = scenario_runtime_timeout_context(
        Path::new("/var/cache/intar-agent/vms/demo/kino.vsock"),
        false,
        Duration::from_secs(360),
    );

    assert!(message.contains("timed out after 360s"));
    assert!(message.contains("never created the Kino vsock socket"));
    assert!(message.contains("cloud-hypervisor.stderr.log"));
}

#[test]
fn scenario_runtime_timeout_context_reports_existing_vsock_socket() {
    let message = scenario_runtime_timeout_context(
        Path::new("/var/cache/intar-agent/vms/demo/kino.vsock"),
        true,
        Duration::from_secs(360),
    );

    assert!(message.contains("timed out after 360s"));
    assert!(message.contains("created the Kino vsock socket"));
    assert!(!message.contains("cloud-hypervisor.stderr.log"));
}

#[test]
fn cloud_hypervisor_config_uses_direct_boot_payload_and_stable_disks() {
    let cached_image = image_cache::CachedImage {
        image_key: "broken".to_string(),
        image_sha256: "a".repeat(64),
        raw_path: PathBuf::from("/cache/images/broken.raw"),
        raw_sha256: "d".repeat(64),
        kernel_path: PathBuf::from("/cache/artifacts/vmlinuz"),
        initrd_path: PathBuf::from("/cache/artifacts/initrd.img"),
        kernel_sha256: "b".repeat(64),
        initrd_sha256: "c".repeat(64),
        cmdline: "root=/dev/vda rw console=ttyS0 quiet loglevel=4".to_string(),
        virtual_size_bytes: 2 * 1024 * 1024 * 1024,
    };
    let paths = JailPathMap {
        host_jail_root: PathBuf::from("/work/jails/vm-demo/root"),
        host_api_socket: PathBuf::from("/work/jails/vm-demo/root/run/cloud-hypervisor.sock"),
        host_vsock_socket: PathBuf::from("/work/jails/vm-demo/root/run/kino.vsock"),
        host_kernel: cached_image.kernel_path.clone(),
        host_initrd: Some(cached_image.initrd_path.clone()),
        host_root_disk: PathBuf::from("/work/vms/vm-demo/root.raw"),
        host_runtime_disk: PathBuf::from("/work/vms/vm-demo/runtime.vfat"),
        host_recording_disk: PathBuf::from("/work/runs/run-1/vm-demo/recordings.vfat"),
        jailed_api_socket: PathBuf::from("/run/cloud-hypervisor.sock"),
        jailed_vsock_socket: PathBuf::from("/run/kino.vsock"),
        jailed_kernel: PathBuf::from("/boot/kernel"),
        jailed_initrd: Some(PathBuf::from("/boot/initrd")),
        jailed_root_disk: PathBuf::from("/disks/root.raw"),
        jailed_runtime_disk: PathBuf::from("/disks/runtime.vfat"),
        jailed_recording_disk: PathBuf::from("/disks/recordings.vfat"),
        host_serial_log: PathBuf::from("/work/jails/vm-demo/root/logs/serial.log"),
        host_console_log: PathBuf::from("/work/jails/vm-demo/root/logs/console.log"),
        host_stderr_log: PathBuf::from("/work/jails/vm-demo/root/logs/cloud-hypervisor.stderr.log"),
        jailed_serial_log: PathBuf::from("/logs/serial.log"),
        jailed_console_log: PathBuf::from("/logs/console.log"),
    };

    let cfg = build_cloud_hypervisor_vm_config(CloudHypervisorVmConfigInput {
        name: "vm-demo",
        cmdline: &cached_image.cmdline,
        paths: &paths,
        vcpus: 2,
        memory_mib: 768,
        tap: "intar-tap0",
        mac: "02:00:00:00:00:01",
        kino_vsock_cid: 10_042,
    })
    .expect("vm config should render");

    assert_eq!(cfg.landlock_enable, Some(true));
    assert_eq!(cfg.payload.firmware, None);
    assert_eq!(cfg.payload.kernel.as_deref(), Some("/boot/kernel"));
    assert_eq!(cfg.payload.initramfs.as_deref(), Some("/boot/initrd"));
    assert_eq!(
        cfg.payload.cmdline.as_deref(),
        Some("root=/dev/vda rw console=ttyS0 quiet loglevel=4")
    );

    let cpus = cfg.cpus.as_ref().expect("cpus");
    assert_eq!(cpus.boot_vcpus, 2);
    assert_eq!(cpus.max_vcpus, 2);
    assert_eq!(
        cfg.memory.as_ref().expect("memory").size,
        768_i64 * 1024 * 1024
    );
    assert_eq!(
        cfg.serial
            .as_ref()
            .and_then(|serial| serial.file.as_deref()),
        Some("/logs/serial.log")
    );
    assert_eq!(
        cfg.console
            .as_ref()
            .and_then(|console| console.file.as_deref()),
        Some("/logs/console.log")
    );

    let disks = cfg.disks.as_ref().expect("disks");
    assert_eq!(disks.len(), 3);
    assert_eq!(disks[0].path, "/disks/root.raw");
    assert!(!disks[0].readonly);
    assert_eq!(disks[0].id.as_deref(), Some("vm-demo-root"));
    assert!(matches!(
        disks[0].image_type.as_ref(),
        Some(DiskImageType::Raw)
    ));
    assert_eq!(disks[1].path, "/disks/runtime.vfat");
    assert!(disks[1].readonly);
    assert_eq!(disks[1].id.as_deref(), Some("vm-demo-runtime"));
    assert!(matches!(
        disks[1].image_type.as_ref(),
        Some(DiskImageType::Raw)
    ));
    assert_eq!(disks[2].path, "/disks/recordings.vfat");
    assert!(!disks[2].readonly);
    assert_eq!(disks[2].id.as_deref(), Some("vm-demo-recordings"));
    assert!(matches!(
        disks[2].image_type.as_ref(),
        Some(DiskImageType::Raw)
    ));

    let net = cfg.net.as_ref().expect("net");
    assert_eq!(net[0].tap, "intar-tap0");
    assert_eq!(net[0].mac.as_deref(), Some("02:00:00:00:00:01"));
    let vsock = cfg.vsock.as_ref().expect("vsock");
    assert_eq!(vsock.cid, 10_042);
    assert_eq!(vsock.socket, "/run/kino.vsock");
    assert_eq!(vsock.id.as_deref(), Some("vm-demo-kino-vsock"));
}
