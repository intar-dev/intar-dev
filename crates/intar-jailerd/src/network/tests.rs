use super::*;

#[test]
fn initial_mount_namespace_entry_stays_beneath_pid_one_root() {
    assert_eq!(
        initial_mount_namespace_root(Path::new("/run/netns")).unwrap(),
        Path::new("/proc/1/root/run/netns")
    );
    assert_eq!(
        initial_mount_namespace_entry(Path::new("/run/netns"), "intar-ns-test").unwrap(),
        Path::new("/proc/1/root/run/netns/intar-ns-test")
    );
}

#[test]
fn initial_mount_namespace_root_rejects_relative_paths() {
    let error = initial_mount_namespace_root(Path::new("run/netns")).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("network namespace root is not absolute"),
        "unexpected error: {error:#}"
    );
}

#[test]
fn iproute2_operations_enter_only_pid_one_mount_namespace() {
    let arguments = [
        OsStr::new("-n"),
        OsStr::new("intar-test"),
        OsStr::new("link"),
    ];
    let command = host_mount_ip_command(
        Path::new("/usr/bin/nsenter"),
        Path::new("/usr/sbin/ip"),
        &arguments,
    );
    assert_eq!(command.get_program(), OsStr::new("/usr/bin/nsenter"));
    assert_eq!(
        command.get_args().collect::<Vec<_>>(),
        vec![
            OsStr::new("--mount=/proc/1/ns/mnt"),
            OsStr::new("--"),
            OsStr::new("/usr/sbin/ip"),
            OsStr::new("-n"),
            OsStr::new("intar-test"),
            OsStr::new("link"),
        ]
    );
}

#[test]
fn iproute2_requires_the_compile_time_namespace_root() {
    validate_iproute2_netns_root(Path::new("/run/netns")).unwrap();
    let error = validate_iproute2_netns_root(Path::new("/var/lib/intar/netns")).unwrap_err();
    assert!(
        error.to_string().contains("must be /run/netns"),
        "unexpected error: {error:#}"
    );
}

#[test]
fn netns_root_identity_requires_matching_safe_root_directories() {
    let trusted = DirectoryIdentity {
        device: 7,
        inode: 11,
        uid: 0,
        gid: 0,
        mode: 0o040755,
    };
    validate_netns_root_identities(trusted, trusted).unwrap();

    let replaced = DirectoryIdentity {
        inode: 12,
        ..trusted
    };
    let error = validate_netns_root_identities(trusted, replaced).unwrap_err();
    assert!(
        error.to_string().contains("root differs across"),
        "unexpected error: {error:#}"
    );

    let writable = DirectoryIdentity {
        mode: 0o040777,
        ..trusted
    };
    let error = validate_netns_root_identities(trusted, writable).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("root-owned, non-writable directory"),
        "unexpected error: {error:#}"
    );
}

#[test]
fn namespace_inode_rejects_an_ordinary_file() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("not-a-namespace");
    std::fs::write(&path, b"").unwrap();
    let error = namespace_inode_path(&path).unwrap_err();
    assert!(
        error.to_string().contains("not a root-owned nsfs entry"),
        "unexpected error: {error:#}"
    );
}

#[test]
fn path_entry_probe_distinguishes_missing_dangling_and_inspection_errors() {
    let directory = tempfile::tempdir().unwrap();
    let missing = directory.path().join("missing");
    assert!(!path_entry_exists(&missing).unwrap());
    std::os::unix::fs::symlink("missing-target", directory.path().join("link")).unwrap();
    assert!(path_entry_exists(&directory.path().join("link")).unwrap());
    std::fs::write(directory.path().join("file"), b"").unwrap();
    let error = path_entry_exists(&directory.path().join("file/child")).unwrap_err();
    assert!(
        error.to_string().contains("inspect path entry"),
        "unexpected error: {error:#}"
    );
}

#[test]
fn repair_never_replaces_a_missing_tracked_namespace_identity() {
    let directory = tempfile::tempdir().unwrap();
    let request = EnsureRunNetworkRequest {
        run_id: ValidatedId::parse("run").unwrap(),
        guest_cidr: "10.77.0.0/28".to_owned(),
        gateway: "10.77.0.1".to_owned(),
    };
    let (mut result, nft_table) = derived_topology(&request).unwrap();
    result.namespace_inode = 17;
    let manager = NetworkManager {
        ip: PathBuf::from("/unreachable/ip"),
        nft: PathBuf::from("/unreachable/nft"),
        nsenter: PathBuf::from("/unreachable/nsenter"),
        netns_root: directory.path().to_path_buf(),
        host_netns_root: directory.path().to_path_buf(),
        policy: JailerdConfig::default(),
        runs: BTreeMap::new(),
    };
    let error = manager
        .construct_run(&RunState {
            request,
            result,
            nft_table,
            attachments: BTreeMap::new(),
            installed: true,
        })
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("refusing to replace a missing tracked run network namespace"),
        "unexpected error: {error:#}"
    );
}

#[test]
fn derived_interface_names_are_stable_distinct_and_fit_linux_limit() {
    let request = EnsureRunNetworkRequest {
        run_id: ValidatedId::parse("run-with-a-very-long-identifier").unwrap(),
        guest_cidr: "10.77.0.0/24".to_owned(),
        gateway: "10.77.0.1".to_owned(),
    };
    let (first, _) = derived_topology(&request).unwrap();
    let (second, _) = derived_topology(&request).unwrap();
    assert_eq!(first, second);
    assert!(first.bridge_name.len() <= 15);
    assert!(first.host_veth_name.len() <= 15);
    assert!(first.namespace_veth_name.len() <= 15);
    assert_ne!(first.bridge_name, first.host_veth_name);
}

#[test]
fn guest_tap_and_bridge_macs_are_stable_local_unicast_and_disjoint() {
    let request = EnsureRunNetworkRequest {
        run_id: ValidatedId::parse("run-a").unwrap(),
        guest_cidr: "10.77.0.0/24".to_owned(),
        gateway: "10.77.0.1".to_owned(),
    };
    let guest = "02:11:22:33:44:55";
    let tap = derived_tap_mac(guest).unwrap();
    let bridge = derived_bridge_mac(&request);

    assert_eq!(tap, "06:11:22:33:44:55");
    assert_eq!(bridge, derived_bridge_mac(&request));
    assert_ne!(guest, tap);
    assert_ne!(guest, bridge);
    assert_ne!(tap, bridge);
    for mac in [guest, tap.as_str(), bridge.as_str()] {
        let octets = parse_mac(mac).unwrap();
        assert_eq!(octets[0] & 0x01, 0, "{mac} must be unicast");
        assert_eq!(octets[0] & 0x02, 0x02, "{mac} must be local");
    }
}

#[test]
fn tap_mac_derivation_preserves_legacy_unicast_recovery() {
    assert_eq!(
        derived_tap_mac("06:11:22:33:44:55").unwrap(),
        "02:11:22:33:44:55"
    );
    assert_eq!(
        derived_tap_mac("00:11:22:33:44:55").unwrap(),
        "06:11:22:33:44:55"
    );
    assert_eq!(
        derived_tap_mac("0a:11:22:33:44:55").unwrap(),
        "0e:11:22:33:44:55"
    );
}

#[test]
fn tap_mac_derivation_rejects_malformed_and_multicast_guest_macs() {
    for invalid in [
        "03:11:22:33:44:55",
        "02:11:22:33:44",
        "02:11:22:33:44:555",
        "02:11:22:33:44:GG",
        "02:11:22:33:44:AA",
    ] {
        assert!(
            derived_tap_mac(invalid).is_err(),
            "accepted invalid guest MAC {invalid:?}"
        );
    }
}

#[test]
fn attachment_collision_checks_cover_guest_tap_cross_class_and_bridge_domains() {
    let existing = VmNetworkAttachment {
        generation: ValidatedId::parse("generation").unwrap(),
        vm_id: ValidatedId::parse("vm").unwrap(),
        tap_name: "tap0".to_owned(),
        guest_mac_address: "02:11:22:33:44:55".to_owned(),
        tap_mac_address: "06:11:22:33:44:55".to_owned(),
        guest_ip_cidr: "10.77.0.2/24".to_owned(),
        ssh_public_port: None,
        ssh_forward_active: false,
        vsock_cid: 3,
        uid: 200_000,
        gid: 200_000,
    };
    for (guest, tap) in [
        ("02:11:22:33:44:55", "06:00:00:00:00:01"),
        ("02:00:00:00:00:01", "02:11:22:33:44:55"),
        ("06:11:22:33:44:55", "06:00:00:00:00:01"),
        ("02:00:00:00:00:01", "06:11:22:33:44:55"),
    ] {
        assert!(attachment_macs_conflict(&existing, guest, tap));
    }
    assert!(!attachment_macs_conflict(
        &existing,
        "02:00:00:00:00:01",
        "06:00:00:00:00:01"
    ));
    assert!(mac_conflicts_with_bridge(
        "0a:11:22:33:44:55",
        "0a:11:22:33:44:55",
        "06:00:00:00:00:01"
    ));
    assert!(mac_conflicts_with_bridge(
        "0a:11:22:33:44:55",
        "02:00:00:00:00:01",
        "0a:11:22:33:44:55"
    ));
}

#[test]
fn create_and_recovery_tap_commands_use_only_the_derived_host_mac() {
    let request = EnsureRunNetworkRequest {
        run_id: ValidatedId::parse("run-a").unwrap(),
        guest_cidr: "10.77.0.0/24".to_owned(),
        gateway: "10.77.0.1".to_owned(),
    };
    let (network, _) = derived_topology(&request).unwrap();
    let attachment = VmNetworkAttachment {
        generation: ValidatedId::parse("generation").unwrap(),
        vm_id: ValidatedId::parse("vm").unwrap(),
        tap_name: "tap0".to_owned(),
        guest_mac_address: "02:11:22:33:44:55".to_owned(),
        tap_mac_address: derived_tap_mac("02:11:22:33:44:55").unwrap(),
        guest_ip_cidr: "10.77.0.2/24".to_owned(),
        ssh_public_port: None,
        ssh_forward_active: false,
        vsock_cid: 3,
        uid: 200_000,
        gid: 200_000,
    };

    // Fresh creation and durable recovery both execute this exact command
    // sequence through `configure_tap`.
    let commands = tap_link_commands(&network, &attachment);
    assert_eq!(
        commands[0],
        vec![
            "-n",
            network.namespace_name.as_str(),
            "link",
            "set",
            "dev",
            "tap0",
            "address",
            "06:11:22:33:44:55",
        ]
    );
    assert!(
        commands
            .iter()
            .flatten()
            .all(|argument| argument != &attachment.guest_mac_address),
        "host link commands must never assign the guest MAC"
    );
}

#[test]
fn bridge_mac_reconciliation_command_and_verification_are_exact() {
    assert_eq!(
        link_address_command("intar-ns-test", "ibrtest", "0a:11:22:33:44:55"),
        vec![
            "-n",
            "intar-ns-test",
            "link",
            "set",
            "dev",
            "ibrtest",
            "address",
            "0a:11:22:33:44:55",
        ]
    );
    verify_link_mac(
        "7: ibrtest: <BROADCAST> mtu 1500 link/ether 0a:11:22:33:44:55 brd ff:ff:ff:ff:ff:ff",
        "0a:11:22:33:44:55",
    )
    .unwrap();
    assert!(
        verify_link_mac(
            "7: ibrtest: <BROADCAST> mtu 1500 link/ether 0a:00:00:00:00:01 brd ff:ff:ff:ff:ff:ff",
            "0a:11:22:33:44:55",
        )
        .is_err()
    );
    assert!(verify_link_mac("7: ibrtest: <BROADCAST>", "0a:11:22:33:44:55").is_err());
}

#[test]
fn containment_uses_prefix_not_string_matching() {
    assert!(ipv4_cidr_contains("10.7.0.0/24", "10.7.0.25/24").unwrap());
    assert!(!ipv4_cidr_contains("10.7.0.0/24", "10.7.1.25/24").unwrap());
}

#[test]
fn overlap_detection_handles_different_prefix_lengths() {
    assert!(ipv4_cidrs_overlap("10.7.0.0/24", "10.7.0.128/25").unwrap());
    assert!(!ipv4_cidrs_overlap("10.7.0.0/24", "10.7.1.0/24").unwrap());
}

#[test]
fn guest_address_rejects_gateway_network_broadcast_and_prefix_drift() {
    let run = EnsureRunNetworkRequest {
        run_id: ValidatedId::parse("run").unwrap(),
        guest_cidr: "10.7.0.0/29".to_owned(),
        gateway: "10.7.0.1".to_owned(),
    };
    let request = |address: &str| VmLaunchRequest {
        run_id: run.run_id.clone(),
        vm_id: ValidatedId::parse("vm").unwrap(),
        cpu_millis: 125,
        vcpu_count: 1,
        memory_mib: 512,
        root_disk_size_bytes: 4 * 1024 * 1024 * 1024,
        tap_name: "tap0".to_owned(),
        mac_address: "02:00:00:00:00:01".to_owned(),
        guest_ip_cidr: address.to_owned(),
        ssh_public_port: None,
        vsock_cid: 3,
        artifacts: intar_jailer_protocol::SourceArtifacts {
            kernel: artifact("kernel", intar_jailer_protocol::ArtifactAccess::ReadOnly),
            initrd: None,
            root_disk: artifact("root.raw", intar_jailer_protocol::ArtifactAccess::ReadWrite),
            runtime_disk: artifact(
                "runtime.raw",
                intar_jailer_protocol::ArtifactAccess::ReadOnly,
            ),
            recording_disk: artifact(
                "recording.raw",
                intar_jailer_protocol::ArtifactAccess::ReadWrite,
            ),
        },
    };
    assert!(validate_guest_address(&run, &request("10.7.0.2/29")).is_ok());
    for invalid in ["10.7.0.0/29", "10.7.0.1/29", "10.7.0.7/29", "10.7.0.2/32"] {
        assert!(validate_guest_address(&run, &request(invalid)).is_err());
    }
}

#[test]
fn nft_policy_blocks_host_cross_run_private_and_metadata_destinations() {
    let request = EnsureRunNetworkRequest {
        run_id: ValidatedId::parse("run-a").unwrap(),
        guest_cidr: "10.77.0.0/29".to_owned(),
        gateway: "10.77.0.1".to_owned(),
    };
    let (result, nft_table) = derived_topology(&request).unwrap();
    let mut attachments = BTreeMap::new();
    attachments.insert(
        ValidatedId::parse("generation").unwrap(),
        VmNetworkAttachment {
            generation: ValidatedId::parse("generation").unwrap(),
            vm_id: ValidatedId::parse("vm").unwrap(),
            tap_name: "tap0".to_owned(),
            guest_mac_address: "02:00:00:00:00:01".to_owned(),
            tap_mac_address: "06:00:00:00:00:01".to_owned(),
            guest_ip_cidr: "10.77.0.2/29".to_owned(),
            ssh_public_port: Some(22_001),
            ssh_forward_active: true,
            vsock_cid: 3,
            uid: 200_000,
            gid: 200_000,
        },
    );
    let state = RunState {
        request,
        result,
        nft_table,
        attachments,
        installed: false,
    };

    let rules = render_nft_rules(&state).unwrap();

    let mut inactive = state.clone();
    inactive
        .attachments
        .values_mut()
        .next()
        .expect("attachment")
        .ssh_forward_active = false;
    let inactive_rules = render_nft_rules(&inactive).unwrap();
    assert!(
        !inactive_rules.contains("tcp dport 22001"),
        "reserved boot-phase SSH port became externally reachable"
    );

    let input_chain = format!(
        "chain input {{\n    type filter hook input priority filter; policy accept;\n    iifname \"{}\" ip saddr 10.77.0.0/29 ct state established,related accept\n    iifname \"{}\" counter drop\n  }}",
        state.result.host_veth_name, state.result.host_veth_name
    );
    assert!(
        rules.contains(&input_chain),
        "only host-initiated guest-CIDR replies may precede the run-veth input drop"
    );
    let input_position = rules.find("chain input {").unwrap();
    let forward_position = rules.find("chain forward {").unwrap();
    assert!(
        input_position < forward_position,
        "the independent input guard must be installed before the forward policy"
    );
    let input_rules = &rules[input_position..forward_position];
    let input_reply_accept = format!(
        "iifname \"{}\" ip saddr 10.77.0.0/29 ct state established,related accept",
        state.result.host_veth_name
    );
    let input_drop = format!("iifname \"{}\" counter drop", state.result.host_veth_name);
    assert!(
        input_rules.find(&input_reply_accept).unwrap() < input_rules.find(&input_drop).unwrap(),
        "established guest-CIDR replies must be accepted before the blanket input drop"
    );
    assert!(
        !input_rules.contains("ct state new accept"),
        "new guest-to-host flows must remain denied"
    );
    assert!(
        !input_rules.contains(&format!(
            "iifname \"{}\" ct state established,related accept",
            state.result.host_veth_name
        )),
        "the input reply exception must retain its guest-CIDR source constraint"
    );
    let source_guard = format!(
        "iifname \"{}\" ip saddr != 10.77.0.0/29 drop",
        state.result.host_veth_name
    );
    let established_accept = format!(
        "iifname \"{}\" ct state established,related accept",
        state.result.host_veth_name
    );
    assert!(
        rules.find(&source_guard).unwrap() < rules.find(&established_accept).unwrap(),
        "source anti-spoofing must run before the established-flow fast path"
    );
    let forward_accept = format!("iifname \"{}\" accept", state.result.host_veth_name);
    let ssh_dnat = format!(
        "iifname != \"{}\" fib daddr type local tcp dport 22001 dnat ip to 10.77.0.2:22",
        state.result.host_veth_name
    );
    let egress_masquerade = format!(
        "ip saddr 10.77.0.0/29 oifname != \"{}\" masquerade",
        state.result.host_veth_name
    );

    for required in [
        "type filter hook forward priority filter; policy accept",
        "meta nfproto ipv6 drop",
        "fib daddr type local drop",
        "ip daddr 10.0.0.0/8 drop",
        "ip daddr 100.64.0.0/10 drop",
        "ip daddr 169.254.0.0/16 drop",
        "ip daddr 168.63.129.16/32 drop",
        "ip daddr 172.16.0.0/12 drop",
        "ip daddr 192.168.0.0/16 drop",
    ] {
        assert!(rules.contains(required), "missing nft rule: {required}");
    }
    for (rule, purpose) in [
        (&forward_accept, "run forwarding"),
        (&ssh_dnat, "external SSH DNAT"),
        (&egress_masquerade, "internet egress"),
    ] {
        assert!(rules.contains(rule), "missing {purpose} rule: {rule}");
    }
    assert!(
        !rules.contains("ip daddr 10.77.0.0/29 drop"),
        "same-run L2 range must not be blocked by the host policy"
    );
}

fn artifact(
    path: &str,
    access: intar_jailer_protocol::ArtifactAccess,
) -> intar_jailer_protocol::ArtifactSource {
    intar_jailer_protocol::ArtifactSource {
        source_root: 0,
        relative_path: path.into(),
        sha256: None,
        access,
    }
}
