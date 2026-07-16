use super::*;

pub(super) fn request_fingerprint(request: &VmLaunchRequest) -> Result<Sha256Digest> {
    let canonical = serde_json::to_vec(request).context("serialize VM launch fingerprint")?;
    Ok(Sha256Digest::for_bytes(&canonical))
}

pub(super) fn unix_time_millis() -> Result<u64> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before the Unix epoch")?
        .as_millis();
    u64::try_from(millis).context("Unix timestamp does not fit in u64 milliseconds")
}

pub(super) fn quota_attestation(quota: CpuQuota) -> Result<CpuQuotaAttestation> {
    Ok(CpuQuotaAttestation {
        quota,
        cpu_max: quota.cpu_max(),
        cpu_max_burst: 0,
        verified_at_unix_ms: unix_time_millis()?,
    })
}

pub(super) fn backend_identity_matches(record: &VmRecord, inspection: &BackendInspection) -> bool {
    if inspection.cgroup_path != record.cgroup_path
        || inspection.host_boot_id != record.host_boot_id
    {
        return false;
    }
    if matches!(
        inspection.health,
        SandboxHealth::Exited | SandboxHealth::Stopping
    ) && inspection.pid.is_none()
    {
        return true;
    }
    inspection.pid.is_some()
        && inspection.pid_start_time_ticks == record.pid_start_time_ticks
        && inspection.netns_inode == Some(record.run_network.result.namespace_inode)
        && inspection.jail_root_inode == record.jail_root_inode
        && inspection.executable_sha256.as_deref() == Some(record.cloud_hypervisor_sha256.as_str())
}

#[derive(Debug, Default)]
pub(super) struct RecoveryContainmentOutcome {
    pub(super) cgroup_drain_proven: bool,
    pub(super) failures: Vec<String>,
}

/// Attempt every containment boundary even when an earlier one fails. A
/// successful stop or destroy is sufficient proof that the cgroup no longer
/// consumes CPU; network and jail cleanup are attempted only after that proof.
pub(super) fn attempt_recovered_containment<B: HostBackend, P: JailPreparer>(
    config: &JailerdConfig,
    backend: &mut B,
    preparer: &mut P,
    recovery: &UnresolvedRecovery,
) -> RecoveryContainmentOutcome {
    let mut outcome = RecoveryContainmentOutcome::default();
    if recovery.uid == recovery.gid
        && (config.uid_gid_start..=config.uid_gid_end).contains(&recovery.uid)
        && let Err(error) =
            preparer.reserve_identity(config, &recovery.generation, recovery.uid, recovery.gid)
    {
        outcome.failures.push(format!(
            "preserve quarantined VM identity reservation: {error:#}"
        ));
    }
    match backend.stop_unit(&recovery.unit_name) {
        Ok(_) => outcome.cgroup_drain_proven = true,
        Err(error) => outcome.failures.push(format!(
            "drain mismatched transient unit {}: {error:#}",
            recovery.unit_name
        )),
    }
    match backend.destroy_unit(&recovery.unit_name) {
        Ok(_) => outcome.cgroup_drain_proven = true,
        Err(error) => outcome.failures.push(format!(
            "remove mismatched transient unit {}: {error:#}",
            recovery.unit_name
        )),
    }
    if outcome.cgroup_drain_proven {
        if let Err(error) = backend.destroy_vm_network(&recovery.run_id, &recovery.generation) {
            outcome.failures.push(format!(
                "destroy recovered VM network for {}: {error:#}",
                recovery.generation
            ));
        }
        if let Err(error) = preparer.quarantine(config, &recovery.generation) {
            outcome.failures.push(format!(
                "quarantine mismatched recovered jail {}: {error:#}",
                recovery.generation
            ));
        }
    } else {
        outcome.failures.push(format!(
            "preserved VM network and jail {} because cgroup drain was not proven",
            recovery.generation
        ));
    }
    outcome
}

/// Fail closed when persisted state cannot be reattached safely. Constructor
/// recovery must not abort and leave a boot-quota process tree without a live
/// watchdog. Instead, charge the full effective boot allocation and retain a
/// cleanup item until a later attempt proves cgroup drain.
pub(super) fn contain_or_retain_recovered_record<B: HostBackend, P: JailPreparer>(
    config: &JailerdConfig,
    backend: &mut B,
    preparer: &mut P,
    record: &VmRecord,
    pending_cpu_reservations: &mut BTreeMap<ValidatedId, CpuQuota>,
    unresolved_recoveries: &mut BTreeMap<ValidatedId, UnresolvedRecovery>,
) {
    let requested_effective = config.boot_cpu_millis.max(record.request.cpu_millis);
    let conservative_quota = CpuQuota::from_millis(requested_effective).unwrap_or_else(|_| {
        CpuQuota::from_millis(config.boot_cpu_millis).expect("validated quota")
    });
    let recovery = UnresolvedRecovery {
        run_id: record.request.run_id.clone(),
        generation: record.generation.clone(),
        // Never trust a persisted unit name when selecting a root-owned unit.
        unit_name: format!("intar-vm-{}.service", record.generation),
        uid: record.uid,
        gid: record.gid,
    };
    pending_cpu_reservations.insert(record.generation.clone(), conservative_quota);
    unresolved_recoveries.insert(record.generation.clone(), recovery.clone());
    let outcome = attempt_recovered_containment(config, backend, preparer, &recovery);
    if outcome.cgroup_drain_proven {
        pending_cpu_reservations.remove(&record.generation);
    }
    if outcome.failures.is_empty() {
        unresolved_recoveries.remove(&record.generation);
    }
}

#[cfg(target_os = "linux")]
pub(super) fn live_api_ping(path: &Path) -> bool {
    ping_cloud_hypervisor(path).is_ok()
}

#[cfg(not(target_os = "linux"))]
pub(super) fn live_api_ping(_path: &Path) -> bool {
    true
}

pub(super) fn validate_recovered_record(config: &JailerdConfig, record: &VmRecord) -> Result<()> {
    if record.schema_version != VM_RECORD_METADATA_VERSION {
        bail!("persisted VM metadata schema is not v2")
    }
    let request_quota = record
        .request
        .validate()
        .context("validate persisted VM request")?;
    config
        .validate_run_network_request(&record.run_network.request)
        .context("validate persisted run network policy")?;
    config
        .validate_ssh_public_port(record.request.ssh_public_port)
        .context("validate persisted SSH public port policy")?;
    if record.request_fingerprint != request_fingerprint(&record.request)? {
        bail!("persisted VM request fingerprint changed")
    }
    if record.request.run_id != record.run_network.request.run_id
        || record.request.run_id != record.run_network.result.run_id
    {
        bail!("persisted VM and run-network identities differ")
    }
    if record.uid != record.gid
        || !(config.uid_gid_start..=config.uid_gid_end).contains(&record.uid)
    {
        bail!("persisted VM identity is outside the configured allocation range")
    }
    if record.unit_name != format!("intar-vm-{}.service", record.generation) {
        bail!("persisted transient unit name does not match its generation")
    }
    if record.cloud_hypervisor_sha256 != config.cloud_hypervisor_sha256.as_str() {
        bail!("persisted VM runtime hash differs from the configured runtime")
    }
    if request_quota != record.quota
        || record.vcpu_count != record.request.vcpu_count
        || CpuQuota::from_millis(record.quota.cpu_millis)? != record.quota
    {
        bail!("persisted CPU quota is not canonical")
    }
    let expected_effective = match record.cpu_phase {
        VmCpuPhase::BootBurst => {
            if record.boot_deadline_unix_ms.is_none() || record.ssh_forward_active {
                bail!("persisted boot CPU lease state is incomplete or externally reachable")
            }
            CpuQuota::from_millis(record.request.cpu_millis.max(config.boot_cpu_millis))?
        }
        VmCpuPhase::Steady => {
            if record.boot_deadline_unix_ms.is_some() {
                bail!("persisted steady CPU state retains a boot lease deadline")
            }
            record.quota
        }
    };
    if record.effective_quota != expected_effective {
        bail!("persisted effective CPU quota does not match its phase")
    }
    if let Some(attestation) = &record.quota_attestation
        && (attestation.quota != record.effective_quota()
            || attestation.cpu_max != attestation.quota.cpu_max()
            || attestation.cpu_max_burst != 0
            || attestation.verified_at_unix_ms == 0)
    {
        bail!("persisted CPU quota attestation is invalid")
    }
    let expected_root = generation_directory(config, &record.generation).join("root");
    let expected_paths = jail_paths(&expected_root, record.paths.host_initrd.is_some());
    if record.paths != expected_paths {
        bail!("persisted jail paths do not match the generation root")
    }
    if !record.netns_name.starts_with("intar-") {
        bail!("persisted network namespace name is invalid")
    }
    if record.netns_name != record.run_network.result.namespace_name
        || record.run_network.result.namespace_inode == 0
    {
        bail!("persisted network namespace identity is invalid")
    }
    if record.cgroup_path.as_ref().is_some_and(|path| {
        !path.is_absolute()
            || path
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
    }) {
        bail!("persisted cgroup path is invalid")
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub(super) fn current_host_boot_id() -> Option<String> {
    read_trimmed("/proc/sys/kernel/random/boot_id").ok()
}

#[cfg(not(target_os = "linux"))]
pub(super) fn current_host_boot_id() -> Option<String> {
    None
}
