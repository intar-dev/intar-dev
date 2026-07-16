use super::*;

pub(super) fn derived_topology(
    request: &EnsureRunNetworkRequest,
) -> Result<(RunNetworkResult, String)> {
    let digest = Sha256::digest(request.run_id.as_str().as_bytes());
    let mut suffix = String::with_capacity(12);
    for byte in &digest[..6] {
        use std::fmt::Write as _;
        let _ = write!(suffix, "{byte:02x}");
    }
    let slot = u16::from_be_bytes([digest[6], digest[7]]) & 0x7fff;
    let base = u32::from_be_bytes([198, 18, 0, 0]) + u32::from(slot) * 4;
    let host = std::net::Ipv4Addr::from(base + 1);
    let namespace = std::net::Ipv4Addr::from(base + 2);
    Ok((
        RunNetworkResult {
            run_id: request.run_id.clone(),
            namespace_name: format!("intar-ns-{suffix}"),
            namespace_inode: 0,
            bridge_name: format!("ibr{suffix}"),
            host_veth_name: format!("ivh{suffix}"),
            namespace_veth_name: format!("ivn{suffix}"),
            host_transit_cidr: format!("{host}/30"),
            namespace_transit_cidr: format!("{namespace}/30"),
        },
        format!("intar_{suffix}"),
    ))
}

pub(super) fn derived_tap_mac(guest_mac: &str) -> Result<String> {
    let octets = parse_mac(guest_mac).context("parse guest MAC")?;
    if octets[0] & 0x01 != 0 {
        bail!("guest MAC must be unicast")
    }
    // Toggle a non-domain bit first, then force the host identity back into
    // the locally administered unicast domain. This maps every protocol-valid
    // guest MAC to a distinct host MAC and preserves recovery for legacy
    // global and non-02 local guest addresses. New 02 guests map to 06.
    let tap_prefix = ((octets[0] ^ 0x04) & 0xfe) | 0x02;
    Ok(format_mac(tap_prefix, &octets[1..]))
}

pub(super) fn derived_bridge_mac(request: &EnsureRunNetworkRequest) -> String {
    let digest = Sha256::digest(request.run_id.as_str().as_bytes());
    format_mac(0x0a, &digest[..5])
}

pub(super) fn parse_mac(value: &str) -> Result<[u8; 6]> {
    if value.len() != 17 || value != value.to_ascii_lowercase() {
        bail!("MAC must be 6 lowercase hexadecimal octets")
    }
    let mut octets = [0_u8; 6];
    let mut parts = value.split(':');
    for octet in &mut octets {
        let part = parts.next().context("MAC has fewer than 6 octets")?;
        if part.len() != 2 {
            bail!("MAC octets must contain exactly 2 hexadecimal digits")
        }
        *octet = u8::from_str_radix(part, 16).context("MAC contains a non-hexadecimal octet")?;
    }
    if parts.next().is_some() {
        bail!("MAC has more than 6 octets")
    }
    Ok(octets)
}

pub(super) fn format_mac(prefix: u8, tail: &[u8]) -> String {
    debug_assert_eq!(tail.len(), 5);
    format!(
        "{prefix:02x}:{:02x}:{:02x}:{:02x}:{:02x}:{:02x}",
        tail[0], tail[1], tail[2], tail[3], tail[4]
    )
}

pub(super) fn link_address_command(namespace: &str, interface: &str, mac: &str) -> Vec<String> {
    [
        "-n", namespace, "link", "set", "dev", interface, "address", mac,
    ]
    .map(str::to_owned)
    .into()
}

pub(super) fn tap_link_commands(
    network: &RunNetworkResult,
    attachment: &VmNetworkAttachment,
) -> [Vec<String>; 3] {
    [
        link_address_command(
            &network.namespace_name,
            &attachment.tap_name,
            &attachment.tap_mac_address,
        ),
        [
            "-n",
            &network.namespace_name,
            "link",
            "set",
            "dev",
            &attachment.tap_name,
            "master",
            &network.bridge_name,
        ]
        .map(str::to_owned)
        .into(),
        [
            "-n",
            &network.namespace_name,
            "link",
            "set",
            "dev",
            &attachment.tap_name,
            "up",
        ]
        .map(str::to_owned)
        .into(),
    ]
}

pub(super) fn verify_link_mac(output: &str, expected_mac: &str) -> Result<()> {
    let fields = output.split_whitespace().collect::<Vec<_>>();
    let actual = fields
        .windows(2)
        .find_map(|pair| (pair[0] == "link/ether").then_some(pair[1]))
        .context("link inspection did not report an Ethernet MAC")?;
    if actual != expected_mac {
        bail!("link MAC differs after reconciliation: expected {expected_mac}, found {actual}")
    }
    Ok(())
}

pub(super) fn attachment_macs_conflict(
    existing: &VmNetworkAttachment,
    guest_mac: &str,
    tap_mac: &str,
) -> bool {
    existing.guest_mac_address == guest_mac
        || existing.guest_mac_address == tap_mac
        || existing.tap_mac_address == guest_mac
        || existing.tap_mac_address == tap_mac
}

pub(super) fn mac_conflicts_with_bridge(bridge_mac: &str, guest_mac: &str, tap_mac: &str) -> bool {
    bridge_mac == guest_mac || bridge_mac == tap_mac
}

pub(super) fn render_nft_rules(state: &RunState) -> Result<String> {
    let host_transit = cidr_address(&state.result.host_transit_cidr)?;
    // A destination owned by the host is routed through the input hook, not
    // the forward hook, so the forward-chain `fib daddr type local` guard
    // cannot protect host services by itself. Permit only conntrack-established
    // replies from this run's guest CIDR so root-owned host readiness checks can
    // complete, then drop every other packet entering from the run veth. New
    // guest-to-host flows remain blocked, and all other host interfaces and the
    // run's forwarded traffic stay untouched.
    let mut rules = format!(
        "table inet {} {{\n  chain input {{\n    type filter hook input priority filter; policy accept;\n    iifname \"{}\" ip saddr {} ct state established,related accept\n    iifname \"{}\" counter drop\n  }}\n  chain forward {{\n    type filter hook forward priority filter; policy accept;\n    iifname \"{}\" meta nfproto ipv6 drop\n    iifname \"{}\" ip saddr != {} drop\n    iifname \"{}\" ct state established,related accept\n    iifname \"{}\" fib daddr type local drop\n",
        state.nft_table,
        state.result.host_veth_name,
        state.request.guest_cidr,
        state.result.host_veth_name,
        state.result.host_veth_name,
        state.result.host_veth_name,
        state.request.guest_cidr,
        state.result.host_veth_name,
        state.result.host_veth_name
    );
    // The root-owned guest pool is constrained to 10.77.0.0/16, so the 10/8
    // guard isolates every other run without embedding the mutable active-run
    // set in each table. Adding or removing a run can therefore update exactly
    // one nftables table.
    for blocked in [
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "168.63.129.16/32",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "198.18.0.0/15",
        "224.0.0.0/4",
    ] {
        rules.push_str(&format!(
            "    iifname \"{}\" ip daddr {blocked} drop\n",
            state.result.host_veth_name
        ));
    }
    rules.push_str(&format!(
        "    iifname \"{}\" ip daddr {host_transit} drop\n",
        state.result.host_veth_name
    ));
    rules.push_str(&format!(
        "    iifname \"{}\" accept\n  }}\n  chain prerouting {{\n    type nat hook prerouting priority dstnat; policy accept;\n",
        state.result.host_veth_name
    ));
    for attachment in state.attachments.values() {
        if attachment.ssh_forward_active
            && let Some(port) = attachment.ssh_public_port
        {
            let guest = cidr_address(&attachment.guest_ip_cidr)?;
            rules.push_str(&format!(
                "    iifname != \"{}\" fib daddr type local tcp dport {port} dnat ip to {guest}:22\n",
                state.result.host_veth_name
            ));
        }
    }
    rules.push_str(&format!(
        "  }}\n  chain postrouting {{\n    type nat hook postrouting priority srcnat; policy accept;\n    ip saddr {} oifname != \"{}\" masquerade\n  }}\n}}\n",
        state.request.guest_cidr, state.result.host_veth_name
    ));
    Ok(rules)
}

pub(super) fn run_checked<'a>(
    program: &Path,
    args: impl IntoIterator<Item = &'a OsStr>,
    stdin: Option<&[u8]>,
) -> Result<()> {
    let mut child = Command::new(program);
    child
        .args(args)
        .env_clear()
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = child
        .spawn()
        .with_context(|| format!("execute trusted helper {}", program.display()))?;
    if let Some(bytes) = stdin {
        child
            .stdin
            .take()
            .context("helper stdin missing")?
            .write_all(bytes)
            .context("write helper input")?;
    }
    let output = child
        .wait_with_output()
        .context("wait for trusted helper")?;
    if !output.status.success() {
        bail!(
            "trusted helper {} failed with {}: {}",
            program.display(),
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )
    }
    Ok(())
}

pub(super) fn run_status<'a>(program: &Path, args: impl IntoIterator<Item = &'a OsStr>) -> bool {
    Command::new(program)
        .args(args)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

pub(super) fn enable_namespace_forwarding(namespace: PathBuf) -> Result<()> {
    std::thread::Builder::new()
        .name("jailerd-netns-sysctl".to_owned())
        .spawn(move || -> Result<()> {
            let fd = open(
                &namespace,
                OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                Mode::empty(),
            )
            .with_context(|| format!("open network namespace {}", namespace.display()))?;
            move_into_link_name_space(fd.as_fd(), Some(LinkNameSpaceType::Network))
                .context("enter run network namespace")?;
            std::fs::write("/proc/sys/net/ipv4/ip_forward", b"1\n")
                .context("enable forwarding in run network namespace")
        })
        .context("spawn network namespace configuration thread")?
        .join()
        .map_err(|_| anyhow::anyhow!("network namespace configuration thread panicked"))?
}

pub(super) fn trusted_tool(candidates: &[&str]) -> Option<PathBuf> {
    candidates
        .iter()
        .map(PathBuf::from)
        .find(|path| trusted_regular_file(path))
}

pub(super) fn namespace_inode_path(path: &Path) -> Result<u64> {
    let fd = open(
        path,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .with_context(|| format!("open run network namespace {}", path.display()))?;
    let metadata =
        fstat(&fd).with_context(|| format!("stat run network namespace {}", path.display()))?;
    let filesystem =
        fstatfs(&fd).with_context(|| format!("statfs run network namespace {}", path.display()))?;
    if metadata.st_uid != 0 || metadata.st_nlink != 1 || filesystem.f_type != NSFS_MAGIC {
        bail!("run network namespace handle is not a root-owned nsfs entry")
    }
    Ok(metadata.st_ino)
}

pub(super) fn path_entry_exists(path: &Path) -> Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error).with_context(|| format!("inspect path entry {}", path.display())),
    }
}

pub(super) fn validate_host_netns_root(local_root: &Path, host_root: &Path) -> Result<()> {
    let local = trusted_directory_identity(local_root, "configured network namespace root")?;
    let host = trusted_directory_identity(host_root, "PID-1-view network namespace root")?;
    validate_netns_root_identities(local, host)
}

pub(crate) fn validate_initial_network_namespace() -> Result<()> {
    let current = std::fs::metadata("/proc/self/ns/net")
        .context("stat jailerd network namespace identity")?;
    let initial =
        std::fs::metadata("/proc/1/ns/net").context("stat PID 1 network namespace identity")?;
    if (current.dev(), current.ino()) != (initial.dev(), initial.ino()) {
        bail!("jailerd must remain in PID 1's network namespace")
    }
    Ok(())
}

pub(super) fn trusted_directory_identity(path: &Path, label: &str) -> Result<DirectoryIdentity> {
    let fd = open(
        path,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .with_context(|| format!("open {label} {}", path.display()))?;
    let stat = fstat(&fd).with_context(|| format!("stat {label} {}", path.display()))?;
    let identity = DirectoryIdentity {
        device: stat.st_dev as u64,
        inode: stat.st_ino,
        uid: stat.st_uid,
        gid: stat.st_gid,
        mode: stat.st_mode,
    };
    validate_netns_root_identity(identity, label)?;
    Ok(identity)
}

pub(super) fn validate_netns_root_identity(identity: DirectoryIdentity, label: &str) -> Result<()> {
    if rustix::fs::FileType::from_raw_mode(identity.mode) != rustix::fs::FileType::Directory
        || identity.uid != 0
        || identity.gid != 0
        || identity.mode & 0o022 != 0
    {
        bail!("{label} must be a root-owned, non-writable directory")
    }
    Ok(())
}

pub(super) fn validate_netns_root_identities(
    local: DirectoryIdentity,
    host: DirectoryIdentity,
) -> Result<()> {
    validate_netns_root_identity(local, "configured network namespace root")?;
    validate_netns_root_identity(host, "PID-1-view network namespace root")?;
    if (local.device, local.inode) != (host.device, host.inode) {
        bail!("network namespace root differs across jailerd and PID 1 mount namespaces")
    }
    Ok(())
}

pub(crate) fn initial_mount_namespace_entry(root: &Path, name: &str) -> Result<PathBuf> {
    Ok(initial_mount_namespace_root(root)?.join(name))
}

pub(crate) fn initial_mount_namespace_root(root: &Path) -> Result<PathBuf> {
    let relative = root
        .strip_prefix("/")
        .context("network namespace root is not absolute")?;
    Ok(Path::new(INITIAL_ROOT).join(relative))
}

pub(super) fn trusted_regular_file(path: &Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    metadata.file_type().is_file()
        && metadata.uid() == 0
        && metadata.mode() & 0o022 == 0
        && metadata.nlink() == 1
        && trusted_ancestors(path)
}

pub(super) fn trusted_directory(path: &Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    metadata.file_type().is_dir()
        && metadata.uid() == 0
        && metadata.mode() & 0o022 == 0
        && trusted_ancestors(path)
}

pub(super) fn trusted_ancestors(path: &Path) -> bool {
    let mut current = path.parent();
    while let Some(ancestor) = current {
        let Ok(metadata) = std::fs::symlink_metadata(ancestor) else {
            return false;
        };
        if !metadata.file_type().is_dir() || metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
            return false;
        }
        current = ancestor.parent();
    }
    true
}

pub(super) fn cidr_address(cidr: &str) -> Result<String> {
    cidr.split_once('/')
        .map(|(address, _)| address.to_owned())
        .context("validated CIDR lost its prefix")
}

pub(super) fn cidr_prefix(cidr: &str) -> Result<u8> {
    cidr.split_once('/')
        .context("validated CIDR lost its prefix")?
        .1
        .parse()
        .context("validated CIDR has invalid prefix")
}

pub(super) fn ipv4_cidr_contains(network: &str, address: &str) -> Result<bool> {
    let (network_address, prefix) = parse_ipv4_cidr(network)?;
    let (address, _) = parse_ipv4_cidr(address)?;
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - u32::from(prefix))
    };
    Ok(u32::from(network_address) & mask == u32::from(address) & mask)
}

pub(super) fn ipv4_cidrs_overlap(left: &str, right: &str) -> Result<bool> {
    let (left_address, left_prefix) = parse_ipv4_cidr(left)?;
    let (right_address, right_prefix) = parse_ipv4_cidr(right)?;
    let prefix = left_prefix.min(right_prefix);
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - u32::from(prefix))
    };
    Ok(u32::from(left_address) & mask == u32::from(right_address) & mask)
}

pub(super) fn validate_guest_address(
    run: &EnsureRunNetworkRequest,
    request: &VmLaunchRequest,
) -> Result<()> {
    let (network, prefix) = parse_ipv4_cidr(&run.guest_cidr)?;
    let (address, address_prefix) = parse_ipv4_cidr(&request.guest_ip_cidr)?;
    if prefix != address_prefix {
        bail!("VM guest address prefix differs from its run network")
    }
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - u32::from(prefix))
    };
    let network = u32::from(network) & mask;
    let address = u32::from(address);
    let broadcast = network | !mask;
    let gateway: std::net::Ipv4Addr = run.gateway.parse().context("parse run gateway")?;
    if address == network || address == broadcast || address == u32::from(gateway) {
        bail!("VM guest address is reserved by the run topology")
    }
    Ok(())
}

pub(super) fn parse_ipv4_cidr(value: &str) -> Result<(std::net::Ipv4Addr, u8)> {
    let (address, prefix) = value
        .split_once('/')
        .context("validated IPv4 CIDR lost its prefix")?;
    let address = address
        .parse()
        .context("validated IPv4 address is invalid")?;
    let prefix: u8 = prefix.parse().context("validated IPv4 prefix is invalid")?;
    if prefix > 32 {
        bail!("IPv4 prefix exceeds 32")
    }
    Ok((address, prefix))
}

pub(super) fn route_is_owned(output: &str, cidr: &str, via: &str, device: &str) -> bool {
    output.lines().map(str::split_whitespace).any(|fields| {
        let fields = fields.collect::<Vec<_>>();
        fields.first() == Some(&cidr)
            && fields.windows(2).any(|pair| pair == ["via", via])
            && fields.windows(2).any(|pair| pair == ["dev", device])
            && fields.windows(2).any(|pair| pair == ["proto", "242"])
    })
}
