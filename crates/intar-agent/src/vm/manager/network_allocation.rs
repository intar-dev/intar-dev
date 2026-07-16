use super::*;

pub(super) fn peer_env_name_identity(peer_name: &str) -> String {
    peer_name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect()
}

pub(super) async fn allocate_run_network(
    inner: &Inner,
    run_id: &str,
    vm_name: &str,
    peer_vm_names: &[String],
    peer_vm_aliases: &BTreeMap<String, String>,
) -> Result<(CreateVmNetwork, String, BTreeMap<String, String>), ApiError> {
    let pool_cidr = inner.defaults.network.guest_cidr.trim();
    let (pool_ip, pool_prefix) = parse_ipv4_cidr(pool_cidr, "vm_defaults.network.guest_cidr")
        .map_err(|e| ApiError::internal(e.to_string()))?;
    if pool_prefix > RUN_SUBNET_PREFIX {
        return Err(ApiError::internal(format!(
            "vm_defaults.network.guest_cidr prefix must be <= {RUN_SUBNET_PREFIX} for per-run /{RUN_SUBNET_PREFIX} allocation"
        )));
    }

    let pool_network = ipv4_network_u32(pool_ip, pool_prefix);
    let pool_subnet_count = 1_u32 << u32::from(RUN_SUBNET_PREFIX - pool_prefix);
    let run_bridge = run_bridge_name(run_id);
    let allocation_names = run_allocation_vm_names(vm_name, peer_vm_names);

    let (used_ips, used_run_subnets, existing_run_network, existing_run_guest_ips) = {
        let states = inner.states.read().await;
        let mut used_ips = BTreeSet::new();
        let mut used_run_subnets = BTreeSet::new();
        let mut existing_run_network = None;
        let mut existing_run_guest_ips = BTreeMap::new();

        for vm in states.values() {
            let Some(details) = vm.details.as_ref() else {
                continue;
            };
            let is_same_run = details.run_id.as_deref() == Some(run_id);
            if let Some(guest_ip) = details.guest_ip.as_deref()
                && let Ok(ip) = guest_ip.parse::<Ipv4Addr>()
            {
                used_ips.insert(u32::from(ip));
                if is_same_run {
                    existing_run_guest_ips.insert(vm.name.clone(), ip);
                }
            }
            let Some(guest_ip_cidr) = details.guest_ip_cidr.as_deref() else {
                continue;
            };
            let Ok((guest_ip, guest_prefix)) = parse_ipv4_cidr(guest_ip_cidr, "vm.guest_ip_cidr")
            else {
                continue;
            };
            let run_subnet = ipv4_network_u32(guest_ip, RUN_SUBNET_PREFIX);
            if ipv4_in_prefix(run_subnet, pool_network, pool_prefix) {
                used_run_subnets.insert(run_subnet);
            }
            if is_same_run
                && let Some(gateway) = details
                    .gateway
                    .as_deref()
                    .and_then(|value| value.parse::<Ipv4Addr>().ok())
            {
                existing_run_network = Some((
                    ipv4_network_u32(guest_ip, guest_prefix),
                    guest_prefix,
                    gateway,
                ));
            }
        }

        (
            used_ips,
            used_run_subnets,
            existing_run_network,
            existing_run_guest_ips,
        )
    };

    if let Some((network, prefix, gateway)) = existing_run_network {
        let allocations = allocate_run_guest_ips(
            network,
            prefix,
            gateway,
            &used_ips,
            &existing_run_guest_ips,
            &allocation_names,
        )
        .ok_or_else(|| ApiError::conflict(format!("run {run_id} guest subnet exhausted")))?;
        let guest_ip = allocations
            .get(vm_name)
            .copied()
            .ok_or_else(|| ApiError::conflict(format!("run {run_id} guest subnet exhausted")))?;
        return Ok((
            CreateVmNetwork {
                guest_ip_cidr: format!("{guest_ip}/{prefix}"),
                gateway: gateway.to_string(),
                dns: inner.defaults.network.dns.clone(),
            },
            run_bridge,
            peer_guest_ip_strings(peer_vm_names, vm_name, &allocations, peer_vm_aliases)?,
        ));
    }

    let subnet_size = 1_u32 << u32::from(32_u8 - RUN_SUBNET_PREFIX);
    let start_index = stable_u64(&[run_id]) % u64::from(pool_subnet_count);
    for offset in 0..pool_subnet_count {
        let index = ((start_index + u64::from(offset)) % u64::from(pool_subnet_count)) as u32;
        let subnet = pool_network.saturating_add(index.saturating_mul(subnet_size));
        if used_run_subnets.contains(&subnet) {
            continue;
        }

        let gateway = Ipv4Addr::from(subnet.saturating_add(1));
        let allocations = allocate_run_guest_ips(
            subnet,
            RUN_SUBNET_PREFIX,
            gateway,
            &used_ips,
            &existing_run_guest_ips,
            &allocation_names,
        )
        .ok_or_else(|| ApiError::conflict("guest IP pool exhausted"))?;
        let guest_ip = allocations
            .get(vm_name)
            .copied()
            .ok_or_else(|| ApiError::conflict("guest IP pool exhausted"))?;
        return Ok((
            CreateVmNetwork {
                guest_ip_cidr: format!("{guest_ip}/{RUN_SUBNET_PREFIX}"),
                gateway: gateway.to_string(),
                dns: inner.defaults.network.dns.clone(),
            },
            run_bridge,
            peer_guest_ip_strings(peer_vm_names, vm_name, &allocations, peer_vm_aliases)?,
        ));
    }

    Err(ApiError::conflict("per-run guest subnet pool exhausted"))
}

pub(super) fn run_allocation_vm_names(vm_name: &str, peer_vm_names: &[String]) -> BTreeSet<String> {
    let mut names = BTreeSet::from([vm_name.to_string()]);
    names.extend(
        peer_vm_names
            .iter()
            .map(|name| name.trim())
            .filter(|name| !name.is_empty())
            .map(ToOwned::to_owned),
    );
    names
}

pub(super) fn allocate_run_guest_ips(
    network: u32,
    prefix: u8,
    gateway: Ipv4Addr,
    used_ips: &BTreeSet<u32>,
    existing_run_guest_ips: &BTreeMap<String, Ipv4Addr>,
    allocation_names: &BTreeSet<String>,
) -> Option<BTreeMap<String, Ipv4Addr>> {
    let mut allocations = BTreeMap::new();
    let mut reserved = used_ips.clone();
    for (name, ip) in existing_run_guest_ips {
        if allocation_names.contains(name) {
            allocations.insert(name.clone(), *ip);
            reserved.insert(u32::from(*ip));
        }
    }
    for name in allocation_names {
        if allocations.contains_key(name) {
            continue;
        }
        let guest_ip = allocate_guest_ip_in_subnet(network, prefix, name, &reserved, gateway)?;
        reserved.insert(u32::from(guest_ip));
        allocations.insert(name.clone(), guest_ip);
    }
    Some(allocations)
}

pub(super) fn peer_guest_ip_strings(
    peer_vm_names: &[String],
    current_vm_name: &str,
    allocations: &BTreeMap<String, Ipv4Addr>,
    peer_vm_aliases: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, ApiError> {
    let mut peers = BTreeMap::new();
    for runtime_name in peer_vm_names
        .iter()
        .filter(|name| name.as_str() != current_vm_name)
    {
        let Some(ip) = allocations.get(runtime_name) else {
            continue;
        };
        let logical_name = peer_vm_aliases
            .get(runtime_name)
            .unwrap_or(runtime_name)
            .clone();
        if peers.insert(logical_name.clone(), ip.to_string()).is_some() {
            return Err(ApiError::bad_request(format!(
                "runtime peer aliases produce duplicate logical peer name {logical_name:?}"
            )));
        }
    }
    Ok(peers)
}

pub(super) fn run_bridge_name(run_id: &str) -> String {
    format!("intar{}", stable_hex(&[run_id], 5))
}

pub(super) fn stable_hex(parts: &[&str], bytes: usize) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update([0]);
    }
    let digest = hasher.finalize();
    base16ct::lower::encode_string(&digest[..bytes])
}

pub(super) fn stable_u64(parts: &[&str]) -> u64 {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update([0]);
    }
    let digest = hasher.finalize();
    u64::from_be_bytes(
        digest[..8]
            .try_into()
            .expect("sha256 digest always has at least 8 bytes"),
    )
}

pub(super) fn parse_ipv4_cidr(cidr: &str, label: &str) -> Result<(Ipv4Addr, u8)> {
    let (ip_raw, prefix_raw) = cidr
        .trim()
        .split_once('/')
        .ok_or_else(|| anyhow::anyhow!("{label} must be IPv4 CIDR"))?;
    let ip = ip_raw
        .parse::<Ipv4Addr>()
        .with_context(|| format!("{label} must use an IPv4 address"))?;
    let prefix = prefix_raw
        .parse::<u8>()
        .with_context(|| format!("{label} has invalid prefix"))?;
    if prefix > 32 {
        anyhow::bail!("{label} prefix must be <= 32");
    }
    Ok((ip, prefix))
}

pub(super) fn ipv4_mask(prefix: u8) -> u32 {
    if prefix == 0 {
        0
    } else {
        u32::MAX << u32::from(32_u8 - prefix)
    }
}

pub(super) fn ipv4_network_u32(ip: Ipv4Addr, prefix: u8) -> u32 {
    u32::from(ip) & ipv4_mask(prefix)
}

pub(super) fn ipv4_in_prefix(ip: u32, network: u32, prefix: u8) -> bool {
    (ip & ipv4_mask(prefix)) == network
}

pub(super) fn allocate_guest_ip_in_subnet(
    network: u32,
    prefix: u8,
    vm_name: &str,
    used_ips: &BTreeSet<u32>,
    gateway: Ipv4Addr,
) -> Option<Ipv4Addr> {
    if prefix > 30 {
        return None;
    }

    let capacity = 1_u32 << u32::from(32_u8 - prefix);
    let first_guest_offset = 2_u32;
    let last_guest_offset = capacity.checked_sub(2)?;
    if last_guest_offset < first_guest_offset {
        return None;
    }

    let gateway_u32 = u32::from(gateway);
    let candidate_count = last_guest_offset - first_guest_offset + 1;
    let start = stable_u64(&[vm_name]) % u64::from(candidate_count);
    for offset in 0..candidate_count {
        let host_offset =
            first_guest_offset + ((start + u64::from(offset)) % u64::from(candidate_count)) as u32;
        let candidate = network.saturating_add(host_offset);
        if candidate == gateway_u32 || used_ips.contains(&candidate) {
            continue;
        }
        return Some(Ipv4Addr::from(candidate));
    }

    None
}

pub(super) fn gateway_for_guest_cidr(cidr: &str) -> Result<String> {
    let (guest_ip, prefix) = parse_ipv4_cidr(cidr, "network.guest_ip_cidr")?;
    if prefix > 30 {
        anyhow::bail!("network.guest_ip_cidr prefix must leave room for a gateway");
    }
    let network = ipv4_network_u32(guest_ip, prefix);
    Ok(Ipv4Addr::from(network.saturating_add(1)).to_string())
}

pub(super) fn next_lease_expiry_error_log_state(
    prev: Option<&LeaseExpiryErrorLogState>,
    signature: &str,
    now_s: i64,
) -> (bool, LeaseExpiryErrorLogState) {
    let next = LeaseExpiryErrorLogState {
        signature: signature.to_string(),
        last_logged_at_s: now_s,
    };

    match prev {
        None => (true, next),
        Some(prev) if prev.signature != signature => (true, next),
        Some(prev)
            if now_s.saturating_sub(prev.last_logged_at_s) >= LEASE_EXPIRY_ERROR_LOG_INTERVAL_S =>
        {
            (true, next)
        }
        Some(prev) => (false, prev.clone()),
    }
}
