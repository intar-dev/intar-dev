use super::*;

#[cfg(target_os = "linux")]
#[test]
fn boot_cpu_guardian_encodes_namespace_lockdown_as_systemd_uint64_mask() {
    let value = restrict_all_namespaces_dbus_value();
    assert_eq!(value.value_signature(), "t");
}

#[test]
fn hard_cpu_lease_uses_a_monotonic_deadline_and_attests_steady_quota() {
    let root = tempfile::tempdir().expect("temporary cgroup root");
    let unit_name = "intar-vm-test.service";
    let cgroup = Path::new("/intar.slice/intar-vms.slice/intar-vm-test.service");
    let directory = root
        .path()
        .join(cgroup.strip_prefix("/").expect("relative"));
    std::fs::create_dir_all(&directory).expect("fake cgroup");
    std::fs::write(directory.join("cpu.max"), "200000 100000").expect("write boot quota");
    std::fs::write(directory.join("cpu.max.burst"), "0").expect("write boot burst");
    let steady = CpuQuota::from_millis(1_000).expect("steady quota");
    let started = Instant::now();
    let deadline = started + Duration::from_millis(10);

    seal_cpu_unit_at_deadline_with(
        unit_name,
        cgroup,
        steady,
        deadline,
        |observed_unit, observed_cgroup, quota| {
            assert_eq!(observed_unit, unit_name);
            assert_eq!(observed_cgroup, cgroup);
            let relative = observed_cgroup.strip_prefix("/").expect("relative");
            let directory = root.path().join(relative);
            // Fake systemd's SetUnitProperties write. The production watchdog
            // reaches this mutation through the existing D-Bus backend so the
            // daemon can retain ProtectControlGroups=yes.
            std::fs::write(directory.join("cpu.max"), quota.cpu_max())?;
            assert_cpu_quota_at(root.path(), observed_cgroup, quota)
        },
    )
    .expect("seal fake controller through systemd callback");

    assert!(started.elapsed() >= Duration::from_millis(10));
    assert_cpu_quota_at(root.path(), cgroup, steady).expect("attest fake controller");
}

#[test]
fn guardian_uses_absolute_uptime_deadline_and_attests_fake_cgroup() {
    assert_eq!(
        parse_proc_uptime_millis("123.45 678.90\n").expect("parse uptime"),
        123_450
    );
    assert_eq!(
        parse_proc_uptime_millis("7 9\n").expect("parse whole uptime"),
        7_000
    );
    let proc = tempfile::tempdir().expect("fake proc root");
    let uptime_path = proc.path().join("uptime");
    std::fs::write(&uptime_path, "42.007 99.0\n").expect("write fake uptime");
    assert_eq!(
        proc_uptime_millis_at(&uptime_path).expect("read fake uptime"),
        42_007
    );

    let root = tempfile::tempdir().expect("temporary cgroup root");
    let cgroup = Path::new("/intar.slice/intar-vms.slice/intar-vm-generation-1.service");
    let directory = root
        .path()
        .join(cgroup.strip_prefix("/").expect("relative cgroup"));
    std::fs::create_dir_all(&directory).expect("fake cgroup");
    std::fs::write(directory.join("cpu.max"), "200000 100000").expect("write boot quota");
    std::fs::write(directory.join("cpu.max.burst"), "50000").expect("write stale burst");

    let uptime = std::cell::Cell::new(10_000_u64);
    let sleeps = std::cell::Cell::new(0_u32);
    wait_until_uptime_deadline_with(
        10_045,
        || Ok(uptime.get()),
        |duration| {
            sleeps.set(sleeps.get() + 1);
            let requested = u64::try_from(duration.as_millis()).expect("duration");
            uptime.set(uptime.get() + (requested / 2).max(1));
        },
    )
    .expect("wait for absolute deadline");
    assert!(uptime.get() >= 10_045);
    assert!(
        sleeps.get() > 1,
        "deadline must be re-read after early wakeups"
    );

    let steady = CpuQuota::from_millis(1_000).expect("steady quota");
    // Fake the successful SetUnitProperties mutation, then exercise the
    // guardian's burst reset and exact readback attestation.
    std::fs::write(directory.join("cpu.max"), steady.cpu_max()).expect("write steady quota");
    clear_cpu_burst_and_attest_at(root.path(), cgroup, steady).expect("attest fake guardian seal");
    assert_eq!(
        std::fs::read_to_string(directory.join("cpu.max.burst")).expect("read burst"),
        "0"
    );
}

#[test]
fn process_capability_parser_requires_sys_ptrace_bit() {
    let status = concat!(
        "Name:\tintar-jailerd\n",
        "CapEff:\t0000000000080000\n",
        "CapBnd:\t000001ffffffffff\n",
    );
    assert!(capability_set_contains(
        status,
        "CapEff:",
        CAP_SYS_PTRACE_BIT
    ));
    assert!(capability_set_contains(
        status,
        "CapBnd:",
        CAP_SYS_PTRACE_BIT
    ));
    assert!(!capability_set_contains(
        "CapEff:\t0000000000000000\n",
        "CapEff:",
        CAP_SYS_PTRACE_BIT
    ));
    assert!(!capability_set_contains(
        "CapEff:\tnot-hex\n",
        "CapEff:",
        CAP_SYS_PTRACE_BIT
    ));
}

#[test]
fn unit_operation_accepts_only_a_confirmed_mid_operation_disappearance() {
    assert!(is_unit_disappeared_name(
        UnitCallSite::Manager,
        "org.freedesktop.systemd1.NoSuchUnit"
    ));
    assert!(is_unit_disappeared_name(
        UnitCallSite::ObjectProperty,
        "org.freedesktop.DBus.Error.UnknownObject"
    ));
    assert!(is_unit_disappeared_name(
        UnitCallSite::ObjectProperty,
        "org.freedesktop.systemd1.NoSuchUnit"
    ));
    for name in [
        "org.freedesktop.DBus.Error.UnknownInterface",
        "org.freedesktop.DBus.Error.UnknownProperty",
        "org.freedesktop.DBus.Error.AccessDenied",
        "org.freedesktop.DBus.Error.NoReply",
        "org.freedesktop.systemd1.LoadFailed",
    ] {
        assert!(!is_unit_disappeared_name(UnitCallSite::Manager, name));
        assert!(!is_unit_disappeared_name(
            UnitCallSite::ObjectProperty,
            name
        ));
    }

    assert_eq!(
        settle_unit_operation(
            Ok(7_u8),
            UnitCallSite::Manager,
            || panic!("successful call must not recheck"),
            "stop"
        )
        .expect("successful operation"),
        Some(7)
    );
    let disappeared = || {
        zbus::Error::FDO(Box::new(zbus::fdo::Error::UnknownObject(
            "injected disappearance".to_owned(),
        )))
    };
    assert_eq!(
        settle_unit_operation(
            Err(disappeared()),
            UnitCallSite::ObjectProperty,
            || Ok(false),
            "stop",
        )
        .expect("confirmed disappearance"),
        None::<u8>
    );

    let existing = settle_unit_operation::<u8>(
        Err(disappeared()),
        UnitCallSite::ObjectProperty,
        || Ok(true),
        "stop transient unit",
    )
    .expect_err("a live unit must preserve the original error");
    assert!(format!("{existing:#}").contains("injected disappearance"));

    let unknown = settle_unit_operation::<u8>(
        Err(disappeared()),
        UnitCallSite::ObjectProperty,
        || bail!("injected recheck failure"),
        "stop transient unit",
    )
    .expect_err("an inconclusive recheck must fail closed");
    assert!(format!("{unknown:#}").contains("injected recheck failure"));

    let unrelated = settle_unit_operation::<u8>(
        Err(zbus::Error::Failure("injected D-Bus error".to_owned())),
        UnitCallSite::Manager,
        || panic!("unrelated errors must not be reclassified"),
        "stop transient unit",
    )
    .expect_err("an unrelated D-Bus failure must fail closed");
    assert!(format!("{unrelated:#}").contains("injected D-Bus error"));
}

#[test]
fn trusted_source_rejects_lexical_escape() {
    let directory = tempfile::tempdir().expect("temp directory");
    assert!(
        open_trusted_source(
            &JailerdConfig {
                allowed_source_roots: vec![directory.path().to_path_buf()],
                agent_uid: unsafe_test_uid(),
                agent_gid: unsafe_test_gid(),
                ..JailerdConfig::default()
            },
            0,
            Path::new("../outside.raw")
        )
        .is_err()
    );
}

#[test]
fn fd_relative_cleanup_rejects_symlinks_without_touching_targets() {
    use std::os::unix::fs::symlink;

    let directory = tempfile::tempdir().expect("temp directory");
    let jail = directory.path().join("jail");
    std::fs::create_dir(&jail).expect("create jail fixture");
    let outside = directory.path().join("outside-secret");
    std::fs::write(&outside, b"do not delete").expect("write outside fixture");
    symlink(&outside, jail.join("escape")).expect("create symlink attack");
    let fd = open(
        &jail,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .expect("open jail fixture");
    let config = lifecycle_test_config(directory.path());
    assert!(
        remove_directory_contents_fd_relative(&config, &fd, config.agent_uid, config.agent_gid,)
            .is_err()
    );
    assert_eq!(std::fs::read(&outside).unwrap(), b"do not delete");
}

#[test]
fn fd_relative_cleanup_rejects_hardlinked_files() {
    let directory = tempfile::tempdir().expect("temp directory");
    let jail = directory.path().join("jail");
    std::fs::create_dir(&jail).expect("create jail fixture");
    let outside = directory.path().join("outside");
    std::fs::write(&outside, b"shared inode").expect("write hardlink fixture");
    std::fs::hard_link(&outside, jail.join("linked")).expect("create hardlink attack");
    let fd = open(
        &jail,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .expect("open jail fixture");
    let config = lifecycle_test_config(directory.path());
    assert!(
        remove_directory_contents_fd_relative(&config, &fd, config.agent_uid, config.agent_gid,)
            .is_err()
    );
    assert_eq!(std::fs::read(&outside).unwrap(), b"shared inode");
    assert!(jail.join("linked").exists());
}

#[test]
fn fd_relative_cleanup_stays_on_the_pinned_directory_after_name_swap() {
    let directory = tempfile::tempdir().expect("temp directory");
    let original = directory.path().join("generation");
    let moved = directory.path().join("moved-generation");
    std::fs::create_dir(&original).expect("create original generation");
    std::fs::write(original.join("old"), b"old").expect("write original entry");
    let fd = open(
        &original,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .expect("pin original generation");
    std::fs::rename(&original, &moved).expect("move pinned generation");
    std::fs::create_dir(&original).expect("create replacement generation");
    std::fs::write(original.join("replacement"), b"keep").expect("write replacement entry");
    let config = lifecycle_test_config(directory.path());
    remove_directory_contents_fd_relative(&config, &fd, config.agent_uid, config.agent_gid)
        .expect("clean pinned generation");
    assert!(!moved.join("old").exists());
    assert_eq!(
        std::fs::read(original.join("replacement")).unwrap(),
        b"keep"
    );
}
