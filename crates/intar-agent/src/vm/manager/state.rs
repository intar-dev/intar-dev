use super::*;

pub(super) fn publish_inventory_update(inner: &Inner) {
    advance_inventory_revision(&inner.inventory_updates_tx);
}

pub(super) fn advance_inventory_revision(updates: &watch::Sender<u64>) {
    updates.send_modify(|revision| {
        *revision = revision.wrapping_add(1);
    });
}

pub(super) async fn set_state(inner: &Inner, name: &str, state: VmLifecycleState) {
    debug_assert_ne!(
        state,
        VmLifecycleState::Running,
        "Running must use the generation-fenced atomic ready commit"
    );
    let now_s = now_unix_s();
    let updated_at = format_rfc3339_s(now_s);

    let persisted = {
        let mut states = inner.states.write().await;
        let Some(vm) = states.get_mut(name) else {
            return;
        };

        vm.state = state;
        vm.updated_at_s = now_s;
        vm.updated_at = updated_at;
        if !state.is_failure() {
            vm.error = None;
        }

        vm.lease_expires_at = compute_lease_expires_at(vm.running_at_s, vm.lease_duration_seconds);

        vm.clone()
    };

    if let Err(e) = inner.db.upsert_vm(persisted.to_db_row()).await {
        error!(error = %e, vm = persisted.name, "failed to persist vm status");
    }
    publish_inventory_update(inner);
    if matches!(
        state,
        VmLifecycleState::DeletingVm | VmLifecycleState::ArchivingArtifacts
    ) {
        publish_terminal_state_update(inner, name, false).await;
    }
}

pub(super) async fn mark_vm_failed(inner: &Inner, name: &str, message: String) {
    let now_s = now_unix_s();
    let updated_at = format_rfc3339_s(now_s);

    let persisted = {
        let mut states = inner.states.write().await;
        let Some(vm) = states.get_mut(name) else {
            return;
        };

        vm.state = VmLifecycleState::Failed;
        vm.updated_at_s = now_s;
        vm.updated_at = updated_at;
        vm.error = Some(message);
        vm.lease_expires_at = compute_lease_expires_at(vm.running_at_s, vm.lease_duration_seconds);

        vm.clone()
    };

    if let Err(e) = inner.db.upsert_vm(persisted.to_db_row()).await {
        error!(error = %e, vm = persisted.name, "failed to persist vm status");
    }
    publish_inventory_update(inner);
    stop_terminal_worker(inner, name).await;
    publish_terminal_state_update(inner, name, false).await;
}

pub(super) async fn mark_vm_delete_failed(inner: &Inner, name: &str, message: String) {
    let now_s = now_unix_s();
    let updated_at = format_rfc3339_s(now_s);

    let persisted = {
        let mut states = inner.states.write().await;
        let Some(vm) = states.get_mut(name) else {
            return;
        };

        vm.state = VmLifecycleState::DeleteFailed;
        vm.updated_at_s = now_s;
        vm.updated_at = updated_at;
        vm.error = Some(message);
        vm.lease_expires_at = compute_lease_expires_at(vm.running_at_s, vm.lease_duration_seconds);

        vm.clone()
    };

    if let Err(e) = inner.db.upsert_vm(persisted.to_db_row()).await {
        error!(error = %e, vm = persisted.name, "failed to persist vm upload failure");
    }
    publish_inventory_update(inner);
    stop_terminal_worker(inner, name).await;
    publish_terminal_state_update(inner, name, false).await;
}

pub(super) fn vm_status_from_row(row: VmRow) -> Result<VmStatusResponse> {
    let state = VmLifecycleState::parse(&row.state)
        .ok_or_else(|| anyhow::anyhow!("unknown vm state \"{}\"", row.state))?;

    let details = match (&row.root_disk_path, &row.seed_disk_path, &row.mac) {
        (Some(root_disk_path), Some(seed_disk_path), Some(mac)) => Some(VmDetails {
            image_key: row.image_key.clone(),
            image_sha256: row.image_sha256.clone(),
            run_id: row.run_id.clone(),
            root_disk_path: root_disk_path.clone(),
            seed_disk_path: seed_disk_path.clone(),
            recording_disk_path: row.recording_disk_path.clone(),
            spool_dir: row.spool_dir.clone(),
            mac: mac.clone(),
            cpu_millis: row.cpu_millis.and_then(|value| u32::try_from(value).ok()),
            vcpu_count: row.vcpu_count.and_then(|value| u16::try_from(value).ok()),
            guest_ip: row.guest_ip.clone(),
            guest_ip_cidr: row.guest_ip_cidr.clone(),
            gateway: row.gateway.clone(),
            bridge_name: row.bridge_name.clone(),
            ssh_public_port: row.ssh_public_port.and_then(|v| u16::try_from(v).ok()),
            tap_name: row.tap_name.clone(),
            ch_socket_path: row.ch_socket_path.clone(),
            ch_pid: row.ch_pid.and_then(|v| u32::try_from(v).ok()),
            ch_start_time_ticks: row
                .ch_start_time_ticks
                .and_then(|value| u64::try_from(value).ok()),
            host_boot_id: row.host_boot_id.clone(),
            ch_executable_sha256: row.ch_executable_sha256.clone(),
            jail_generation: row.jail_generation.clone(),
            jail_unit_name: row.jail_unit_name.clone(),
            jail_cgroup_path: row.jail_cgroup_path.clone(),
            jail_root_path: row.jail_root_path.clone(),
            jail_root_inode: row
                .jail_root_inode
                .and_then(|value| u64::try_from(value).ok()),
            jail_uid: row.jail_uid.and_then(|value| u32::try_from(value).ok()),
            jail_gid: row.jail_gid.and_then(|value| u32::try_from(value).ok()),
            jail_netns_name: row.jail_netns_name.clone(),
            kino_vsock_cid: row.kino_vsock_cid.and_then(|v| u32::try_from(v).ok()),
            kino_vsock_port: row
                .kino_vsock_port
                .and_then(|v| u32::try_from(v).ok())
                .or_else(|| row.kino_vsock_cid.map(|_| KINO_VSOCK_PORT)),
            kino_vsock_path: row.kino_vsock_path.clone(),
            ssh_host_keys_openssh: parse_ssh_host_keys_json(
                row.ssh_host_keys_openssh_json.as_deref(),
            ),
            cpu_runtime: None,
        }),
        _ => None,
    };

    let running_at_s = match (state, row.running_at_s) {
        (
            VmLifecycleState::Running
            | VmLifecycleState::DeletingVm
            | VmLifecycleState::ArchivingArtifacts
            | VmLifecycleState::DeleteFailed,
            None,
        ) => Some(row.updated_at_s),
        (_, other) => other,
    };

    let lease_duration_seconds = row
        .lease_duration_seconds
        .and_then(|v| u64::try_from(v).ok())
        .filter(|v| *v > 0);
    let lease_expires_at = compute_lease_expires_at(running_at_s, lease_duration_seconds);

    Ok(VmStatusResponse {
        name: row.name,
        state,
        created_at: format_rfc3339_s(row.created_at_s),
        updated_at: format_rfc3339_s(row.updated_at_s),
        details,
        error: row.error,
        lease_duration_seconds,
        lease_expires_at,
        created_at_s: row.created_at_s,
        updated_at_s: row.updated_at_s,
        running_at_s,
    })
}

pub(super) async fn current_ssh_host_keys(inner: &Inner, vm_name: &str) -> Vec<String> {
    let states = inner.states.read().await;
    states
        .get(vm_name)
        .and_then(|vm| vm.details.as_ref())
        .map(|details| details.ssh_host_keys_openssh.clone())
        .unwrap_or_default()
}

pub(super) fn parse_ssh_host_keys_json(raw: Option<&str>) -> Vec<String> {
    let Some(raw) = raw else {
        return Vec::new();
    };
    match serde_json::from_str::<Vec<String>>(raw) {
        Ok(keys) => normalize_ssh_host_keys(keys),
        Err(error) => {
            warn!(error = %error, "discarding invalid persisted ssh host keys");
            Vec::new()
        }
    }
}

pub(super) fn normalize_ssh_host_keys(keys: Vec<String>) -> Vec<String> {
    let mut keys = keys
        .into_iter()
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
        .collect::<Vec<_>>();
    keys.sort();
    keys.dedup();
    keys
}

pub(super) fn now_unix_ms() -> i64 {
    let millis = time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
    i64::try_from(millis).unwrap_or(i64::MAX)
}

pub(super) fn now_unix_s() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

pub(super) fn format_rfc3339_s(ts: i64) -> String {
    use time::format_description::well_known::Rfc3339;

    let dt = match time::OffsetDateTime::from_unix_timestamp(ts) {
        Ok(v) => v,
        Err(_) => return "unknown".to_string(),
    };

    match dt.format(&Rfc3339) {
        Ok(s) => s,
        Err(_) => "unknown".to_string(),
    }
}

pub(super) fn compute_lease_expires_at(
    running_at_s: Option<i64>,
    lease_duration_seconds: Option<u64>,
) -> Option<String> {
    let running_at_s = running_at_s?;
    let lease_duration_seconds = lease_duration_seconds?;

    let lease_expires_at_s: i128 =
        (running_at_s as i128).saturating_add(lease_duration_seconds as i128);
    let lease_expires_at_s: i64 = match i64::try_from(lease_expires_at_s) {
        Ok(v) => v,
        Err(_) => return None,
    };

    Some(format_rfc3339_s(lease_expires_at_s))
}

pub(super) fn is_safe_key(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub(super) fn run_spool_dir(work_dir: &Path, run_id: &str) -> PathBuf {
    work_dir.join("run-spool").join(run_id)
}

pub(super) fn vm_spool_dir(work_dir: &Path, run_id: &str, vm_name: &str) -> PathBuf {
    run_spool_dir(work_dir, run_id).join(vm_name)
}

pub(super) fn matching_vm_names_for_run_id(
    states: &BTreeMap<String, VmStatusResponse>,
    run_id: &str,
) -> Vec<String> {
    states
        .iter()
        .filter_map(|(name, vm)| {
            let candidate = vm
                .details
                .as_ref()
                .and_then(|details| details.run_id.as_deref())?;
            (candidate == run_id).then(|| name.clone())
        })
        .collect()
}

pub(super) fn resolve_work_dir(defaults: &VmDefaultsConfig) -> Result<PathBuf> {
    if let Some(p) = defaults.work_dir.as_ref() {
        return Ok(p.clone());
    }
    let base = dirs::cache_dir().ok_or_else(|| anyhow::anyhow!("cache dir unavailable"))?;
    Ok(base.join("intar-agent"))
}

pub(super) async fn ensure_guest_ip_available(
    inner: &Inner,
    guest_ip_cidr: &str,
) -> Result<(), ApiError> {
    let guest_ip = extract_guest_ip(guest_ip_cidr)
        .map_err(|e| ApiError::bad_request(format!("invalid scenario runtime network: {e}")))?;

    let conflict = {
        let states = inner.states.read().await;
        states
            .values()
            .filter_map(|vm| {
                vm.details
                    .as_ref()
                    .and_then(|details| details.guest_ip.as_deref())
            })
            .any(|current| current == guest_ip)
    };

    if conflict {
        return Err(ApiError::conflict(format!(
            "guest IP {guest_ip} is already in use"
        )));
    }

    Ok(())
}

pub(super) async fn allocate_kino_vsock_cid(inner: &Inner) -> Result<u32, ApiError> {
    let used = {
        let states = inner.states.read().await;
        states
            .values()
            .filter_map(|vm| vm.details.as_ref().and_then(|d| d.kino_vsock_cid))
            .collect::<BTreeSet<_>>()
    };

    for cid in KINO_VSOCK_CID_MIN..=u32::MAX {
        if !used.contains(&cid) {
            return Ok(cid);
        }
    }

    Err(ApiError::internal("exhausted kino vsock CID range"))
}

pub(super) async fn ensure_kino_vsock_cid_available(
    inner: &Inner,
    requested_cid: u32,
) -> Result<(), ApiError> {
    if requested_cid < KINO_VSOCK_CID_MIN {
        return Err(ApiError::bad_request(format!(
            "runtime.kino.vsock_cid must be >= {KINO_VSOCK_CID_MIN}"
        )));
    }

    let conflict = {
        let states = inner.states.read().await;
        states
            .values()
            .filter_map(|vm| {
                vm.details
                    .as_ref()
                    .and_then(|details| details.kino_vsock_cid)
            })
            .any(|current| current == requested_cid)
    };

    if conflict {
        return Err(ApiError::conflict(format!(
            "Kino vsock CID {requested_cid} is already in use"
        )));
    }

    Ok(())
}

pub(super) fn error_chain_to_string(err: &anyhow::Error) -> String {
    let mut out = err.to_string();
    for cause in err.chain().skip(1) {
        out.push_str(": ");
        out.push_str(&cause.to_string());
    }
    out
}

pub(super) fn scenario_runtime_ready_timeout(cpu_millis: u32) -> Result<Duration> {
    anyhow::ensure!(cpu_millis > 0, "vm details cpu_millis must be positive");
    let cpu_millis = u64::from(cpu_millis);
    let quota_scaled_seconds = SCENARIO_READY_BASE_TIMEOUT_SECONDS
        .saturating_mul(u64::from(SCENARIO_READY_REFERENCE_CPU_MILLIS))
        .div_ceil(cpu_millis);
    Ok(Duration::from_secs(quota_scaled_seconds.clamp(
        SCENARIO_READY_BASE_TIMEOUT_SECONDS,
        SCENARIO_READY_MAX_TIMEOUT_SECONDS,
    )))
}

pub(super) fn scenario_runtime_timeout_context(
    kino_vsock_path: &Path,
    saw_kino_vsock_socket: bool,
    timeout: Duration,
) -> String {
    let mut message = format!(
        "timed out after {}s waiting for scenario runtime readiness",
        timeout.as_secs()
    );
    if saw_kino_vsock_socket {
        message.push_str(" after Cloud Hypervisor created the Kino vsock socket at ");
        message.push_str(&kino_vsock_path.display().to_string());
    } else {
        message.push_str(" because Cloud Hypervisor never created the Kino vsock socket at ");
        message.push_str(&kino_vsock_path.display().to_string());
        if let Some(vm_dir) = kino_vsock_path.parent() {
            message.push_str("; inspect ");
            message.push_str(
                &vm_dir
                    .join(CLOUD_HYPERVISOR_STDERR_LOG_NAME)
                    .display()
                    .to_string(),
            );
        }
    }
    message
}

pub(super) fn validate_network(net: &CreateVmNetwork) -> Result<String> {
    let guest = net.guest_ip_cidr.trim();
    if guest.is_empty() {
        anyhow::bail!("network.guest_ip_cidr must not be empty");
    }
    let (ip_str, prefix_str) = guest
        .split_once('/')
        .ok_or_else(|| anyhow::anyhow!("network.guest_ip_cidr must be CIDR like 10.0.0.2/24"))?;
    let ip: IpAddr = ip_str
        .parse()
        .with_context(|| format!("invalid guest IP address {ip_str}"))?;
    let prefix: u8 = prefix_str
        .parse()
        .with_context(|| format!("invalid guest IP prefix length {prefix_str}"))?;
    match ip {
        IpAddr::V4(_) if prefix <= 32 => {}
        IpAddr::V6(_) if prefix <= 128 => {}
        _ => anyhow::bail!("invalid CIDR prefix length for {ip}"),
    }

    let gateway_str = net.gateway.trim();
    if gateway_str.is_empty() {
        anyhow::bail!("network.gateway must not be empty");
    }
    let gateway: IpAddr = gateway_str
        .parse()
        .with_context(|| format!("invalid gateway IP address {gateway_str}"))?;
    if std::mem::discriminant(&ip) != std::mem::discriminant(&gateway) {
        anyhow::bail!("guest IP and gateway must be the same address family");
    }

    if net.dns.is_empty() {
        anyhow::bail!("network.dns must include at least one DNS server");
    }
    for d in &net.dns {
        let d = d.trim();
        if d.is_empty() {
            anyhow::bail!("network.dns contains an empty entry");
        }
        let dns_ip: IpAddr = d
            .parse()
            .with_context(|| format!("invalid DNS IP address {d}"))?;
        if std::mem::discriminant(&ip) != std::mem::discriminant(&dns_ip) {
            anyhow::bail!("all DNS servers must match the guest IP address family");
        }
    }

    Ok(format!("{ip_str}/{prefix}"))
}
