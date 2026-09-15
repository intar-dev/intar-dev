use super::*;

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

#[cfg(target_os = "linux")]
#[test]
fn existing_lifecycle_directory_preserves_agent_traversal_acl() {
    use std::os::unix::{fs::MetadataExt as _, process::CommandExt as _};
    use std::process::{Command, Stdio};

    if !rustix::process::geteuid().is_root() || trusted_setfacl_binary().is_err() {
        return;
    }

    const AGENT_UID: u32 = 65_534;
    const VM_UID: u32 = 65_533;
    let jail = tempfile::tempdir_in("/tmp").expect("jail root");
    let mut config = lifecycle_test_config(jail.path());
    config.agent_uid = AGENT_UID;
    config.agent_gid = AGENT_UID;
    let generation = ValidatedId::parse("acl-generation").expect("generation ID");
    let jail_root = trusted_jail_root_fd(&config).expect("pin jail root");
    ensure_root_directory_at(&jail_root, c"cloud-hypervisor").expect("create generation parent");

    let generation_root = jail
        .path()
        .join("cloud-hypervisor")
        .join(generation.as_str())
        .join("root");
    let run = generation_root.join("run");
    let logs = generation_root.join("logs");
    std::fs::create_dir_all(&run).expect("create runtime directory");
    std::fs::create_dir(&logs).expect("create log directory");
    for directory in [
        jail.path()
            .join("cloud-hypervisor")
            .join(generation.as_str()),
        generation_root.clone(),
    ] {
        set_mode(&directory, 0o700).expect("lock root-owned lifecycle directory");
    }
    for directory in [&run, &logs] {
        set_owner(directory, VM_UID, VM_UID).expect("set VM directory owner");
        set_mode(directory, 0o700).expect("lock VM directory");
    }
    for name in ["serial.log", "console.log", "cloud-hypervisor.stderr.log"] {
        let path = logs.join(name);
        File::create(&path).expect("create VM log");
        set_owner(&path, VM_UID, VM_UID).expect("set VM log owner");
        set_mode(&path, 0o600).expect("lock VM log");
    }

    apply_agent_acls(&config, &generation, VM_UID, VM_UID).expect("grant agent traversal");
    let parent = jail.path().join("cloud-hypervisor");
    assert_eq!(
        std::fs::metadata(&parent).expect("stat ACL parent").mode() & 0o777,
        0o710
    );

    ensure_root_directory_at(&jail_root, c"cloud-hypervisor")
        .expect("validate existing ACL-bearing generation parent");
    assert_eq!(
        std::fs::metadata(&parent)
            .expect("restat ACL parent")
            .mode()
            & 0o777,
        0o710
    );
    let output = Command::new("/usr/bin/python3")
        .args([
            "-c",
            "import os, sys; os.open(sys.argv[1], os.O_PATH | os.O_DIRECTORY)",
        ])
        .arg(&run)
        .uid(AGENT_UID)
        .gid(AGENT_UID)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .expect("run agent traversal probe");
    assert!(
        output.status.success(),
        "agent lost traversal after existing-directory validation: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );

    let bad = jail.path().join("writable");
    std::fs::create_dir(&bad).expect("create bad lifecycle directory");
    set_mode(&bad, 0o720).expect("make bad lifecycle directory writable");
    assert!(ensure_root_directory_at(&jail_root, c"writable").is_err());
    assert_eq!(
        std::fs::metadata(&bad)
            .expect("restat rejected lifecycle directory")
            .mode()
            & 0o777,
        0o720
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
    assert_eq!(
        std::fs::read(&outside).expect("valid CPU test fixture"),
        b"do not delete"
    );
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
    assert_eq!(
        std::fs::read(&outside).expect("valid CPU test fixture"),
        b"shared inode"
    );
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
        std::fs::read(original.join("replacement")).expect("valid CPU test fixture"),
        b"keep"
    );
}

#[test]
fn quota_readback_rejects_excess_cpu_and_burst_credit() {
    let root = tempfile::tempdir().expect("valid CPU test fixture");
    let quota = CpuQuota::from_millis(500).expect("valid CPU test fixture");
    std::fs::write(root.path().join("cpu.max"), "50000 100000").expect("valid CPU test fixture");
    std::fs::write(root.path().join("cpu.max.burst"), "0").expect("valid CPU test fixture");
    assert_cpu_quota_at(root.path(), Path::new("/"), quota).expect("valid CPU test fixture");
    std::fs::write(root.path().join("cpu.max.burst"), "1000").expect("valid CPU test fixture");
    assert!(assert_cpu_quota_at(root.path(), Path::new("/"), quota).is_err());
    std::fs::write(root.path().join("cpu.max.burst"), "0").expect("valid CPU test fixture");
    std::fs::write(root.path().join("cpu.max"), "100000 100000").expect("valid CPU test fixture");
    assert!(assert_cpu_quota_at(root.path(), Path::new("/"), quota).is_err());
}
