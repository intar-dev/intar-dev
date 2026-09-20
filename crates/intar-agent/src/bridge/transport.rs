use super::*;

pub(super) fn command_exists(command: &str) -> bool {
    std::env::var_os("PATH")
        .and_then(|path| {
            std::env::split_paths(&path)
                .map(|dir| dir.join(command))
                .find(|path| path.is_file())
        })
        .is_some()
}

pub(crate) async fn bootstrap_agent_access(
    cfg: &BridgeConfig,
    http: &HttpClient,
) -> Result<AgentBootstrapResponse> {
    let url = format!("{}/api/agent/bootstrap", cfg.base_url.trim_end_matches('/'));
    let response = http
        .post(&url)
        .json(&AgentBootstrapRequest {
            host_id: &cfg.host_id,
            bootstrap_token: &cfg.credential,
        })
        .send()
        .await
        .with_context(|| format!("failed to bootstrap agent against {url}"))?;

    let status = response.status();
    if !status.is_success() {
        anyhow::bail!("agent bootstrap failed with HTTP {status}");
    }

    let access = response
        .json::<AgentBootstrapResponse>()
        .await
        .context("failed to parse bootstrap response")?;
    validate_bootstrap_identity(cfg, &access)?;
    Ok(access)
}

pub(super) async fn refresh_agent_access(
    cfg: &BridgeConfig,
    http: &HttpClient,
) -> Result<AgentBootstrapResponse> {
    timeout(
        Duration::from_secs(RUN_CLI_ACCESS_REFRESH_TIMEOUT_SECS),
        bootstrap_agent_access(cfg, http),
    )
    .await
    .context("agent access refresh timed out")?
    .context("agent access refresh failed")
}

pub(super) fn default_ws_url(base_url: &str, host_id: &str) -> String {
    let base = base_url.trim_end_matches('/');
    let ws_base = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        base.to_string()
    };
    format!("{ws_base}/api/agent/bridge/{host_id}")
}

pub(super) async fn send_bridge_message<W>(write: &mut W, message: &BridgeMessageV8) -> Result<()>
where
    W: Sink<Message> + Unpin,
    W::Error: std::error::Error + Send + Sync + 'static,
{
    let raw = serde_json::to_string(message).context("failed to serialize bridge message")?;
    write
        .send(Message::Text(raw.into()))
        .await
        .context("failed to send bridge websocket message")
}

pub(super) fn parse_bridge_message(message: Message) -> Result<Option<BridgeMessageV8>> {
    match message {
        Message::Text(raw) => parse_bridge_json(&raw).map(Some),
        Message::Binary(raw) => {
            let raw = std::str::from_utf8(&raw).context("bridge binary message is not utf-8")?;
            parse_bridge_json(raw).map(Some)
        }
        Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => Ok(None),
        Message::Close(frame) => {
            anyhow::bail!("bridge websocket closed by peer: {:?}", frame);
        }
    }
}

pub(super) fn parse_bridge_json(raw: &str) -> Result<BridgeMessageV8> {
    let message =
        serde_json::from_str::<BridgeMessageV8>(raw).context("invalid bridge v7 JSON message")?;
    if !message_has_v7_protocol(&message) {
        anyhow::bail!("invalid bridge protocol version; expected v8");
    }
    Ok(message)
}

pub(super) fn validate_bridge_message(message: &BridgeMessageV8, host_id: &str) -> Result<()> {
    if !message_has_v7_protocol(message) {
        anyhow::bail!("invalid bridge protocol version; expected v8");
    }
    let message_host_id = bridge_message_host_id(message);
    if message_host_id != host_id {
        anyhow::bail!("bridge message host mismatch: expected {host_id}, got {message_host_id}");
    }
    Ok(())
}

pub(super) fn validate_desired_state(
    cfg: &BridgeConfig,
    desired: &HostDesiredStateV2,
) -> Result<()> {
    let host_id = &cfg.host_id;
    if desired.schema_version != HOST_DESIRED_STATE_SCHEMA_VERSION {
        anyhow::bail!(
            "unsupported desired state schema version {}; expected {}",
            desired.schema_version,
            HOST_DESIRED_STATE_SCHEMA_VERSION
        );
    }
    if desired.host_id != *host_id {
        anyhow::bail!(
            "desired state host mismatch: expected {host_id}, got {}",
            desired.host_id
        );
    }
    anyhow::ensure!(
        desired.scope == cfg.scope
            && desired.owner_user_id == cfg.owner_user_id
            && !desired.owner_user_id.trim().is_empty(),
        "desired host ownership mismatch"
    );
    let mut names = BTreeSet::new();
    let mut runs = BTreeMap::new();
    for vm in &desired.vms {
        cfg.validate_owner(&vm.owner_user_id, &vm.runtime_execution_id, vm.generation)?;
        anyhow::ensure!(
            !vm.run_id.trim().is_empty()
                && !vm.vm_name.trim().is_empty()
                && !vm.vm_id.trim().is_empty(),
            "VM identity is empty"
        );
        anyhow::ensure!(
            names.insert(&vm.vm_name),
            "duplicate VM name in desired state"
        );
        let identity = (&vm.owner_user_id, &vm.runtime_execution_id, vm.generation);
        if let Some(previous) = runs.insert(&vm.run_id, identity) {
            anyhow::ensure!(
                identity == previous,
                "run has inconsistent execution identity"
            );
        }
    }
    if !desired.builds.is_empty() {
        anyhow::bail!(
            "agent desired state must not contain build assignments; received {}",
            desired.builds.len()
        );
    }
    Ok(())
}

pub(super) fn message_has_v7_protocol(message: &BridgeMessageV8) -> bool {
    match message {
        BridgeMessageV8::ClientHello(message) => {
            message.protocol_version == BRIDGE_PROTOCOL_VERSION
        }
        BridgeMessageV8::ServerHello(message) => {
            message.protocol_version == BRIDGE_PROTOCOL_VERSION
        }
        BridgeMessageV8::DesiredState(message) => {
            message.protocol_version == BRIDGE_PROTOCOL_VERSION
        }
        BridgeMessageV8::StateReport(message) => {
            message.protocol_version == BRIDGE_PROTOCOL_VERSION
        }
        BridgeMessageV8::VmReport(message) => message.protocol_version == BRIDGE_PROTOCOL_VERSION,
        BridgeMessageV8::BuildReport(message) => {
            message.protocol_version == BRIDGE_PROTOCOL_VERSION
        }
        BridgeMessageV8::SyncRequest(message) => {
            message.protocol_version == BRIDGE_PROTOCOL_VERSION
        }
    }
}

pub(super) fn bridge_message_host_id(message: &BridgeMessageV8) -> &str {
    match message {
        BridgeMessageV8::ClientHello(message) => &message.host_id,
        BridgeMessageV8::ServerHello(message) => &message.host_id,
        BridgeMessageV8::DesiredState(message) => &message.host_id,
        BridgeMessageV8::StateReport(message) => &message.host_id,
        BridgeMessageV8::VmReport(message) => &message.host_id,
        BridgeMessageV8::BuildReport(message) => &message.host_id,
        BridgeMessageV8::SyncRequest(message) => &message.host_id,
    }
}

pub(super) fn bridge_message_type(message: &BridgeMessageV8) -> &'static str {
    match message {
        BridgeMessageV8::ClientHello(_) => "client_hello",
        BridgeMessageV8::ServerHello(_) => "server_hello",
        BridgeMessageV8::DesiredState(_) => "desired_state",
        BridgeMessageV8::StateReport(_) => "state_report",
        BridgeMessageV8::VmReport(_) => "vm_report",
        BridgeMessageV8::BuildReport(_) => "build_report",
        BridgeMessageV8::SyncRequest(_) => "sync_request",
    }
}

pub(super) fn local_run_id(status: &VmStatusResponse) -> Option<String> {
    status
        .details
        .as_ref()
        .and_then(|details| details.run_id.as_deref())
        .map(str::trim)
        .filter(|run_id| !run_id.is_empty())
        .map(ToOwned::to_owned)
}

pub(super) fn preserve_last_attestation<T: Clone>(
    live: Option<&T>,
    cached: Option<&T>,
) -> Option<T> {
    live.or(cached).cloned()
}

pub(super) fn terminal_update_matches_status(
    update: &VmTerminalState,
    status: &VmStatusResponse,
) -> bool {
    let update_generation = update
        .runtime_constraints
        .as_ref()
        .map(|constraints| constraints.generation.as_str());
    let current_generation = status
        .details
        .as_ref()
        .and_then(|details| details.jail_generation.as_deref());
    terminal_identities_match(
        &update.run_id,
        update_generation,
        &update.state,
        local_run_id(status).as_deref(),
        current_generation,
    )
}

pub(super) fn terminal_identities_match(
    update_run_id: &str,
    update_generation: Option<&str>,
    update_state: &VmTerminalStateKind,
    current_run_id: Option<&str>,
    current_generation: Option<&str>,
) -> bool {
    if current_run_id != Some(update_run_id) {
        return false;
    }
    match (update_generation, current_generation) {
        (Some(update), Some(current)) => update == current,
        // A pre-launch failure or deletion can legitimately have no jail
        // generation. Ready is never accepted without an explicit fence.
        (None, None) => *update_state != VmTerminalStateKind::Ready,
        _ => false,
    }
}

pub(super) fn resources_from_desired(resources: &VmResourcesV3) -> CreateVmResources {
    CreateVmResources {
        cpu_millis: resources.cpu_millis,
        memory_mib: resources.memory_mib.0,
        disk_mib: Some(resources.disk_mib.0),
    }
}

pub(super) fn desired_lease_duration_seconds(vm: &DesiredVmV2, now_ms: i64) -> Result<u64> {
    let remaining_ms = vm.lease_expires_at_unix_ms.saturating_sub(now_ms);
    anyhow::ensure!(remaining_ms > 0, "desired VM lease expired");
    let seconds = u64::try_from((remaining_ms / 1_000).max(1)).unwrap_or(u64::MAX);
    Ok(seconds)
}

pub(super) fn image_cache_key(image_key: &ImageKey) -> String {
    format!(
        "{}-{}-{}",
        image_key.scenario,
        image_key.vm,
        image_architecture_slug(&image_key.arch)
    )
}

pub(super) fn image_architecture_slug(arch: &ImageArchitecture) -> &'static str {
    match arch {
        ImageArchitecture::X86_64 => "x86_64",
        ImageArchitecture::Aarch64 => "aarch64",
    }
}

pub(super) fn kino_vsock_cid(desired_version: u64, vm: &DesiredVmV2) -> u32 {
    let mut hash = desired_version;
    for byte in vm.run_id.bytes().chain(vm.vm_name.bytes()) {
        hash = hash.wrapping_mul(16_777_619) ^ u64::from(byte);
    }
    10_000 + u32::try_from(hash % 50_000).unwrap_or(0)
}

pub(super) fn mib_from_u64(value: u64) -> Mib {
    Mib(u32::try_from(value).unwrap_or(u32::MAX))
}

pub(super) fn saturating_u64_to_u32(value: u64) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

pub(super) fn parse_rfc3339_ms(value: &str) -> Option<i64> {
    let parsed =
        time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).ok()?;
    i64::try_from(parsed.unix_timestamp_nanos() / 1_000_000).ok()
}

pub(super) fn now_ms() -> i64 {
    let millis = time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
    i64::try_from(millis).unwrap_or(i64::MAX)
}

fn validate_bootstrap_identity(cfg: &BridgeConfig, access: &AgentBootstrapResponse) -> Result<()> {
    anyhow::ensure!(
        access.host_id == cfg.host_id
            && access.owner_user_id == cfg.owner_user_id
            && access.scope == cfg.scope
            && access.credential_generation == cfg.credential_generation,
        "bootstrap host identity mismatch"
    );
    anyhow::ensure!(
        !access.access_token.is_empty(),
        "bootstrap access token is empty"
    );
    Ok(())
}

#[cfg(test)]
mod ownership_tests {
    use super::*;
    #[test]
    fn bootstrap_response_must_match_the_enrolled_identity() {
        let cfg = BridgeConfig {
            host_id: "host-1".into(),
            owner_user_id: "user-1".into(),
            credential_generation: 1,
            ..BridgeConfig::default()
        };
        let valid = serde_json::json!({"accessToken":"secret", "hostId":"host-1", "ownerUserId":"user-1", "scope":"personal", "credentialGeneration":1});
        let response = serde_json::from_value(valid.clone()).expect("valid fixture");
        validate_bootstrap_identity(&cfg, &response).expect("valid fixture");
        for (field, wrong) in [
            ("hostId", serde_json::json!("other")),
            ("ownerUserId", serde_json::json!("other")),
            ("scope", serde_json::json!("platform")),
            ("credentialGeneration", serde_json::json!(2)),
        ] {
            let mut value = valid.clone();
            value[field] = wrong;
            let response = serde_json::from_value(value).expect("valid fixture");
            assert!(validate_bootstrap_identity(&cfg, &response).is_err());
            let mut missing = valid.clone();
            missing
                .as_object_mut()
                .expect("fixture object")
                .remove(field);
            assert!(serde_json::from_value::<AgentBootstrapResponse>(missing).is_err());
        }
    }
}
