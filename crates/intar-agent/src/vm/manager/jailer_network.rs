use super::*;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum JailerIdentityOperation {
    Inspect,
    Stop,
    Destroy,
}

pub(super) async fn jailer_identity_request(
    inner: &Inner,
    generation: &str,
    operation: JailerIdentityOperation,
) -> Result<Option<VmInspection>> {
    let identity = VmIdentityRequest::by_generation(
        ValidatedId::parse(generation.to_string()).context("validate persisted jail generation")?,
    );
    jailer_vm_selector_request(inner, identity, operation).await
}

pub(super) async fn jailer_vm_selector_request(
    inner: &Inner,
    identity: VmIdentityRequest,
    operation: JailerIdentityOperation,
) -> Result<Option<VmInspection>> {
    identity.validate().context("validate jailer VM selector")?;
    let request = match operation {
        JailerIdentityOperation::Inspect => JailerRequest::InspectVm(identity),
        JailerIdentityOperation::Stop => JailerRequest::StopVm(identity),
        JailerIdentityOperation::Destroy => JailerRequest::DestroyVm(identity),
    };

    classify_jailer_identity_response(operation, request_jailerd(inner, request).await?)
}

pub(super) fn classify_jailer_identity_response(
    operation: JailerIdentityOperation,
    response: JailerResponse,
) -> Result<Option<VmInspection>> {
    match (operation, response) {
        (JailerIdentityOperation::Inspect, JailerResponse::InspectVm(inspection)) => {
            Ok(Some(inspection))
        }
        (JailerIdentityOperation::Stop, JailerResponse::StopVm(_))
        | (JailerIdentityOperation::Destroy, JailerResponse::DestroyVm(_)) => Ok(None),
        (JailerIdentityOperation::Inspect, JailerResponse::Error(error))
            if error.code == "not_found" =>
        {
            Ok(None)
        }
        (
            JailerIdentityOperation::Stop | JailerIdentityOperation::Destroy,
            JailerResponse::Error(error),
        ) if error.code == "not_found" => Ok(None),
        (_, JailerResponse::Error(error)) => {
            anyhow::bail!("jailerd {}: {}", error.code, error.message)
        }
        (_, response) => {
            anyhow::bail!("jailerd returned unexpected response to {operation:?}: {response:?}")
        }
    }
}

pub(super) async fn wait_for_ch_ready(
    socket_path: &Path,
    timeout_seconds: u64,
) -> Result<ChClient> {
    let deadline = Instant::now() + Duration::from_secs(timeout_seconds);
    let mut last_error = "socket path has not appeared".to_owned();

    loop {
        if socket_path.exists() {
            let socket = socket_path.display().to_string();
            match ChClient::new(socket) {
                Ok(client) => {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    match tokio::time::timeout(remaining, client.ping()).await {
                        Ok(Ok(_)) => return Ok(client),
                        Ok(Err(error)) => {
                            last_error = format!("API ping failed: {error}");
                        }
                        Err(_) => {
                            last_error =
                                "API ping exceeded the remaining readiness deadline".to_owned();
                        }
                    }
                }
                Err(error) => {
                    last_error = format!("socket validation failed: {error}");
                }
            }
        }

        if Instant::now() >= deadline {
            anyhow::bail!(
                "cloud-hypervisor socket did not become ready in {}s at {}; last error: {}",
                timeout_seconds,
                socket_path.display(),
                last_error,
            );
        }

        tokio::time::sleep(
            Duration::from_millis(200).min(deadline.saturating_duration_since(Instant::now())),
        )
        .await;
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct RunNftNetwork {
    run_id: String,
    bridge_name: String,
    subnet_cidr: String,
    gateway: Ipv4Addr,
    prefix: u8,
}

pub(super) async fn repair_vm_networks(inner: &Inner) -> Result<()> {
    let run_networks = collect_run_networks(inner).await?;
    let mut failures = Vec::new();
    for network in &run_networks {
        let run_id = match ValidatedId::parse(network.run_id.clone()) {
            Ok(run_id) => run_id,
            Err(error) => {
                failures.push(format!(
                    "run {} has an invalid persisted ID: {error}",
                    network.run_id
                ));
                continue;
            }
        };
        match request_jailerd(
            inner,
            JailerRequest::RepairRunNetwork(EnsureRunNetworkRequest {
                run_id,
                guest_cidr: network.subnet_cidr.clone(),
                gateway: network.gateway.to_string(),
            }),
        )
        .await
        {
            Ok(JailerResponse::RepairRunNetwork(_)) => {}
            Ok(JailerResponse::Error(error)) => failures.push(format!(
                "run {}: jailerd {}: {}",
                network.run_id, error.code, error.message
            )),
            Ok(response) => failures.push(format!(
                "run {}: jailerd returned unexpected response to repair_run_network: {response:?}",
                network.run_id
            )),
            Err(error) => {
                failures.push(format!("run {}: {error:#}", network.run_id));
            }
        }
    }
    if !failures.is_empty() {
        anyhow::bail!(
            "one or more run network repairs failed: {}",
            failures.join("; ")
        )
    }
    debug!(
        run_network_count = run_networks.len(),
        "repaired run networks through intar-jailerd"
    );
    Ok(())
}

pub(super) async fn collect_run_networks(inner: &Inner) -> Result<Vec<RunNftNetwork>> {
    let states = inner.states.read().await;
    let mut networks = BTreeMap::<String, RunNftNetwork>::new();

    for vm in states.values() {
        let Some(details) = vm.details.as_ref() else {
            continue;
        };
        // Queued or failed-before-launch rows can carry provisional network
        // fields without ever having crossed the jailer generation boundary.
        // Repair is intentionally not an implicit ensure/create fallback.
        if details.jail_generation.is_none() {
            continue;
        }
        let Some(run_id) = details.run_id.as_deref().filter(|value| !value.is_empty()) else {
            continue;
        };
        let Some(bridge_name) = details
            .bridge_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let Some(guest_ip_cidr) = details
            .guest_ip_cidr
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let Some(gateway_raw) = details
            .gateway
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let (guest_ip, prefix) = parse_ipv4_cidr(guest_ip_cidr, "vm.guest_ip_cidr")
            .with_context(|| format!("invalid persisted network for vm {}", vm.name))?;
        if prefix > 30 {
            anyhow::bail!("vm {} has unusable guest subnet prefix /{prefix}", vm.name);
        }
        let gateway = gateway_raw
            .parse::<Ipv4Addr>()
            .with_context(|| format!("vm {} has invalid gateway {gateway_raw}", vm.name))?;
        let subnet = ipv4_network_u32(guest_ip, prefix);
        let subnet_cidr = format!("{}/{prefix}", Ipv4Addr::from(subnet));
        let key = run_id.to_string();

        let entry = networks
            .entry(key.clone())
            .or_insert_with(|| RunNftNetwork {
                run_id: key,
                bridge_name: bridge_name.to_string(),
                subnet_cidr: subnet_cidr.clone(),
                gateway,
                prefix,
            });
        if entry.bridge_name != bridge_name
            || entry.subnet_cidr != subnet_cidr
            || entry.gateway != gateway
            || entry.prefix != prefix
        {
            anyhow::bail!(
                "run {run_id} has inconsistent network state across VMs; refusing to render nftables"
            );
        }
    }

    Ok(networks.into_values().collect())
}

#[cfg(test)]
pub(super) fn parse_default_route_interface(raw_routes: &str) -> Option<String> {
    for line in raw_routes.lines() {
        let mut parts = line.split_whitespace();
        while let Some(part) = parts.next() {
            if part == "dev" {
                let iface = parts.next()?.trim();
                if !iface.is_empty() {
                    return Some(iface.to_string());
                }
            }
        }
    }
    None
}

pub(super) fn random_hex_suffix(bytes_len: usize) -> String {
    let mut bytes = vec![0_u8; bytes_len];
    getrandom_fill(&mut bytes).expect("OS randomness unavailable for suffix generation");
    bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
}

pub(super) fn extract_guest_ip(cidr: &str) -> Result<String> {
    let (ip, _prefix) = cidr
        .split_once('/')
        .ok_or_else(|| anyhow::anyhow!("guest_ip_cidr must include prefix"))?;
    let ip: IpAddr = ip
        .parse()
        .with_context(|| format!("invalid guest IP in CIDR: {cidr}"))?;
    Ok(ip.to_string())
}

pub(super) async fn allocate_tap_name(inner: &Inner, vm_name: &str, tap_prefix: &str) -> String {
    let used = {
        let states = inner.states.read().await;
        states
            .values()
            .filter_map(|vm| vm.details.as_ref().and_then(|d| d.tap_name.clone()))
            .collect::<std::collections::BTreeSet<String>>()
    };

    for _ in 0..64 {
        let mut tap_name = format!("{tap_prefix}{}", random_hex_suffix(2));
        if tap_name.len() > 15 {
            tap_name = tap_name.chars().take(15).collect();
        }
        if !used.contains(&tap_name) {
            return tap_name;
        }
    }

    let mut fallback = format!("{}{}", tap_prefix, vm_name.replace('-', ""));
    if fallback.len() > 15 {
        fallback = fallback.chars().take(15).collect();
    }
    fallback
}

pub(super) async fn allocate_ssh_public_port(inner: &Inner) -> Result<u16, ApiError> {
    let start = inner.ssh_access.public_port_start;
    let end = inner.ssh_access.public_port_end;
    if start == 0 || end == 0 || end < start {
        return Err(ApiError::internal(
            "ssh_access public port range is not configured correctly",
        ));
    }

    let used = {
        let states = inner.states.read().await;
        states
            .values()
            .filter_map(|vm| {
                vm.details
                    .as_ref()
                    .and_then(|details| details.ssh_public_port)
            })
            .collect::<BTreeSet<u16>>()
    };

    for port in start..=end {
        if !used.contains(&port) {
            return Ok(port);
        }
    }

    Err(ApiError::conflict("ssh public port pool exhausted"))
}

pub(super) async fn current_terminal_state_for_vm(
    inner: &Inner,
    vm_name: &str,
    expected_run_id: Option<&str>,
) -> Result<Option<VmTerminalState>> {
    let vm = {
        let states = inner.states.read().await;
        states.get(vm_name).cloned()
    };
    let Some(vm) = vm else {
        return Ok(None);
    };

    if let Some(expected_run_id) = expected_run_id {
        let actual_run_id = vm
            .details
            .as_ref()
            .and_then(|details| details.run_id.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if actual_run_id != Some(expected_run_id) {
            return Ok(None);
        }
    }

    build_terminal_state_from_status(&vm, &inner.ssh_access).await
}

pub(super) async fn build_terminal_state_from_status(
    vm: &VmStatusResponse,
    ssh_access: &SshAccessConfig,
) -> Result<Option<VmTerminalState>> {
    let ssh_ready = ssh_terminal_target_ready(vm).await;
    Ok(terminal_state_from_vm(
        vm,
        ssh_access,
        ssh_ready,
        now_unix_ms(),
    ))
}

pub(super) fn terminal_state_from_vm(
    vm: &VmStatusResponse,
    ssh_access: &SshAccessConfig,
    ssh_ready: bool,
    observed_at: i64,
) -> Option<VmTerminalState> {
    let details = vm.details.as_ref()?;
    let run_id = details
        .run_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_string();

    let advertised_host = ssh_access
        .advertised_host
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let error_reason = vm
        .error
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let runtime_constraints = runtime_constraints_from_details(details);
    let steady_quota_verified = runtime_constraints.as_ref().is_some_and(|constraints| {
        constraints.phase == VmRuntimeConstraintPhaseV1::Steady
            && constraints.effective_cpu_millis == constraints.steady_cpu_millis
            && constraints.quota_verified_at_unix_ms.is_some()
    });
    let terminal_target = if vm.state == VmLifecycleState::Running
        && ssh_access.enabled
        && ssh_ready
        && steady_quota_verified
    {
        details.ssh_public_port.map(|port| VmTerminalTarget {
            host: advertised_host,
            port,
            username: "ubuntu".to_string(),
            checked_at: observed_at,
        })
    } else {
        None
    };
    let (state, reason) = if terminal_target.is_some() {
        (VmTerminalStateKind::Ready, None)
    } else {
        match vm.state {
            VmLifecycleState::Failed | VmLifecycleState::DeleteFailed => (
                VmTerminalStateKind::Failed,
                error_reason.or_else(|| Some("vm failed".to_string())),
            ),
            VmLifecycleState::DeletingVm | VmLifecycleState::ArchivingArtifacts => {
                (VmTerminalStateKind::Pending, Some("destroying".to_string()))
            }
            _ => (VmTerminalStateKind::Pending, None),
        }
    };

    Some(VmTerminalState {
        run_id,
        vm_name: vm.name.clone(),
        state,
        terminal_target,
        reason,
        observed_at,
        runtime_constraints,
    })
}

pub(super) fn runtime_constraints_from_details(
    details: &VmDetails,
) -> Option<VmRuntimeConstraintsV1> {
    let runtime = details.cpu_runtime.as_ref()?;
    let generation = details.jail_generation.clone()?;
    let phase = match runtime.phase {
        VmCpuPhase::BootBurst => VmRuntimeConstraintPhaseV1::BootBurst,
        VmCpuPhase::Steady => VmRuntimeConstraintPhaseV1::Steady,
    };
    Some(VmRuntimeConstraintsV1 {
        generation,
        phase,
        steady_cpu_millis: runtime.steady_quota.cpu_millis,
        effective_cpu_millis: runtime.effective_quota.cpu_millis,
        quota_verified_at_unix_ms: runtime
            .attestation
            .as_ref()
            .and_then(|attestation| i64::try_from(attestation.verified_at_unix_ms).ok()),
        lease_expires_at_unix_ms: runtime
            .boot_deadline_unix_ms
            .and_then(|deadline| i64::try_from(deadline).ok()),
    })
}

pub(super) fn terminal_state_matches_inventory(
    state: &VmTerminalState,
    run_id: Option<&str>,
    generation: Option<&str>,
) -> bool {
    let Some(run_id) = run_id else {
        return false;
    };
    let Some(generation) = generation else {
        return false;
    };
    state.run_id == run_id
        && state
            .runtime_constraints
            .as_ref()
            .map(|constraints| constraints.generation.as_str())
            == Some(generation)
}

pub(super) async fn ssh_terminal_target_ready(vm: &VmStatusResponse) -> bool {
    if !matches!(vm.state, VmLifecycleState::Running) {
        return false;
    }

    let guest_ip = match vm
        .details
        .as_ref()
        .and_then(|details| details.guest_ip.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(value) => value,
        None => return false,
    };

    timeout(
        Duration::from_millis(750),
        TcpStream::connect((guest_ip, 22)),
    )
    .await
    .is_ok_and(|result| result.is_ok())
}

pub(super) struct StrictGuestHostKeys {
    pub(super) expected: Arc<[PublicKey]>,
    pub(super) mismatch_observed: Arc<AtomicBool>,
}

impl ssh_client::Handler for StrictGuestHostKeys {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        // OpenSSH comments are not part of the key sent over the wire. Kino
        // reports the contents of /etc/ssh/ssh_host_*.pub, so compare only
        // authenticated key material rather than full PublicKey equality.
        let accepted = self
            .expected
            .iter()
            .any(|expected| expected.key_data() == server_public_key.key_data());
        if !accepted {
            self.mismatch_observed.store(true, Ordering::Release);
        }
        Ok(accepted)
    }
}

pub(super) fn parse_guest_ssh_host_keys(raw_keys: &[String]) -> Result<Arc<[PublicKey]>> {
    anyhow::ensure!(
        !raw_keys.is_empty(),
        "Kino readiness did not include an SSH host key"
    );
    raw_keys
        .iter()
        .enumerate()
        .map(|(index, raw)| {
            PublicKey::from_openssh(raw)
                .with_context(|| format!("Kino reported invalid SSH host key at index {index}"))
        })
        .collect::<Result<Vec<_>>>()
        .map(Arc::from)
}

pub(super) fn guest_ssh_readiness_client_config() -> Arc<ssh_client::Config> {
    // Keep the same conservative KEX set as Stargate's outbound SSH client.
    // OpenSSH 10 guests and russh otherwise choose incompatible post-quantum
    // algorithms before the host-key check can run.
    let preferred = Preferred {
        kex: Cow::Borrowed(&[kex::CURVE25519, kex::CURVE25519_PRE_RFC_8731]),
        ..Preferred::DEFAULT
    };
    Arc::new(ssh_client::Config {
        client_id: russh::SshId::Standard("SSH-2.0-Intar-Agent-Readiness".into()),
        inactivity_timeout: Some(Duration::from_millis(500)),
        nodelay: true,
        preferred,
        ..Default::default()
    })
}

pub(super) async fn wait_for_guest_ssh_before_running(
    inner: &Inner,
    vm_name: &str,
    generation: &ValidatedId,
) -> Result<()> {
    let (guest_ip, raw_host_keys) = {
        let states = inner.states.read().await;
        let details = states
            .get(vm_name)
            .and_then(|vm| vm.details.as_ref())
            .context("VM details missing for SSH readiness")?;
        anyhow::ensure!(
            details.jail_generation.as_deref() == Some(generation.as_str()),
            "VM generation changed before SSH readiness verification"
        );
        let guest_ip = details
            .guest_ip
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .context("VM details missing guest IP for SSH readiness")?;
        (guest_ip, details.ssh_host_keys_openssh.clone())
    };
    let expected_host_keys = parse_guest_ssh_host_keys(&raw_host_keys)?;
    let client_config = guest_ssh_readiness_client_config();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let mismatch_observed = Arc::new(AtomicBool::new(false));
        let attempt = timeout(
            Duration::from_millis(500),
            ssh_client::connect(
                Arc::clone(&client_config),
                (guest_ip.as_str(), 22),
                StrictGuestHostKeys {
                    expected: Arc::clone(&expected_host_keys),
                    mismatch_observed: Arc::clone(&mismatch_observed),
                },
            ),
        )
        .await;
        match attempt {
            Ok(Ok(session)) => {
                let _ = session
                    .disconnect(Disconnect::ByApplication, "", "en")
                    .await;
                let states = inner.states.read().await;
                let generation_is_current = states
                    .get(vm_name)
                    .and_then(|vm| vm.details.as_ref())
                    .is_some_and(|details| {
                        details.jail_generation.as_deref() == Some(generation.as_str())
                    });
                anyhow::ensure!(
                    generation_is_current,
                    "VM generation changed during SSH readiness verification"
                );
                return Ok(());
            }
            _ if mismatch_observed.load(Ordering::Acquire) => {
                anyhow::bail!(
                    "guest SSH presented a host key that was not reported by Kino; refusing to publish terminal readiness"
                )
            }
            _ if Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            _ => {
                anyhow::bail!(
                    "guest SSH did not complete a Kino-attested host-key handshake after steady quota sealing"
                )
            }
        }
    }
}

pub(super) fn normalize_peer_vm_topology(
    current_vm_name: &str,
    raw_peer_vm_names: Vec<String>,
    raw_peer_vm_aliases: BTreeMap<String, String>,
) -> Result<(Vec<String>, BTreeMap<String, String>), ApiError> {
    let mut peer_vm_names = Vec::new();
    for peer_name in raw_peer_vm_names {
        let peer_name = peer_name.trim().to_string();
        if peer_name.is_empty() || peer_name == current_vm_name {
            continue;
        }
        if !is_safe_key(&peer_name) {
            return Err(ApiError::bad_request(
                "runtime.peer_vm_names entries must match [A-Za-z0-9_-]+",
            ));
        }
        if !peer_vm_names.contains(&peer_name) {
            peer_vm_names.push(peer_name);
        }
    }

    let known_peer_names = peer_vm_names.iter().cloned().collect::<BTreeSet<_>>();
    let mut peer_vm_aliases = BTreeMap::new();
    for (runtime_name, logical_name) in raw_peer_vm_aliases {
        let runtime_name = runtime_name.trim().to_string();
        let logical_name = logical_name.trim().to_string();
        if !is_safe_key(&runtime_name) {
            return Err(ApiError::bad_request(
                "runtime.peer_vm_aliases keys must match [A-Za-z0-9_-]+",
            ));
        }
        if !known_peer_names.contains(&runtime_name) {
            return Err(ApiError::bad_request(format!(
                "runtime.peer_vm_aliases key {runtime_name:?} does not name a runtime peer"
            )));
        }
        if !is_safe_key(&logical_name) {
            return Err(ApiError::bad_request(
                "runtime.peer_vm_aliases values must match [A-Za-z0-9_-]+",
            ));
        }
        if peer_vm_aliases
            .insert(runtime_name.clone(), logical_name)
            .is_some()
        {
            return Err(ApiError::bad_request(format!(
                "runtime.peer_vm_aliases contains duplicate normalized key {runtime_name:?}"
            )));
        }
    }

    let mut logical_peer_names = BTreeSet::new();
    let mut logical_peer_env_names = BTreeSet::new();
    for runtime_name in &peer_vm_names {
        let logical_name = peer_vm_aliases.get(runtime_name).unwrap_or(runtime_name);
        if !logical_peer_names.insert(logical_name.clone()) {
            return Err(ApiError::bad_request(format!(
                "runtime peer aliases produce duplicate logical peer name {logical_name:?}"
            )));
        }
        let logical_env_name = peer_env_name_identity(logical_name);
        if !logical_peer_env_names.insert(logical_env_name.clone()) {
            return Err(ApiError::bad_request(format!(
                "runtime peer aliases produce duplicate environment peer name {logical_env_name:?}"
            )));
        }
    }

    Ok((peer_vm_names, peer_vm_aliases))
}
