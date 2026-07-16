use super::*;

impl JailerdConfig {
    pub fn validate(&self) -> Result<(), ValidationError> {
        for path in [
            &self.jail_root,
            &self.cloud_hypervisor_binary,
            &self.jailer_binary,
            &self.socket_path,
            &self.netns_root,
        ] {
            if !path.is_absolute() {
                return Err(ValidationError::PathNotAbsolute(path.clone()));
            }
            if !is_normal_absolute_path(path) {
                return Err(ValidationError::UnsafePrivilegedPath(path.clone()));
            }
        }
        if self.uid_gid_start < 1_000 || self.uid_gid_start > self.uid_gid_end {
            return Err(ValidationError::InvalidIdentityRange);
        }
        if self.agent_uid == 0 || self.agent_gid == 0 {
            return Err(ValidationError::RootAgentIdentity);
        }
        if self.cloud_hypervisor_sha256.as_str() != CLOUD_HYPERVISOR_SHA256 {
            return Err(ValidationError::UnpinnedRuntime);
        }
        if self.vmm_file_size_limit_bytes == Some(0) {
            return Err(ValidationError::InvalidFileSizeLimit);
        }
        CpuQuota::from_millis(self.boot_cpu_millis)?;
        if self.boot_cpu_lease_ms == 0 || self.boot_cpu_lease_ms > DEFAULT_BOOT_CPU_LEASE_MS {
            return Err(ValidationError::InvalidBootCpuLease);
        }
        if self.allowed_source_roots.is_empty()
            || self
                .allowed_source_roots
                .iter()
                .any(|path| !is_normal_absolute_path(path))
        {
            return Err(ValidationError::InvalidSourceRoots);
        }
        validate_guest_network_pool(&self.guest_network_pool)?;
        validate_ssh_public_port_range(self.ssh_public_port_start, self.ssh_public_port_end)?;
        Ok(())
    }

    /// Validate a typed run network against root-owned host policy.
    pub fn validate_run_network_request(
        &self,
        request: &EnsureRunNetworkRequest,
    ) -> Result<(), ValidationError> {
        request.validate()?;
        let (pool, pool_prefix) = parse_ipv4_cidr(&self.guest_network_pool)?;
        let (network, prefix) = parse_ipv4_cidr(&request.guest_cidr)?;
        if prefix != RUN_GUEST_NETWORK_PREFIX
            || !ipv4_subnet_contains(pool, pool_prefix, network, prefix)
        {
            return Err(ValidationError::RunNetworkOutsideConfiguredPool);
        }
        let expected_gateway = u32::from(network)
            .checked_add(1)
            .map(std::net::Ipv4Addr::from)
            .ok_or(ValidationError::InvalidGateway)?;
        if request.gateway.parse::<std::net::Ipv4Addr>().ok() != Some(expected_gateway) {
            return Err(ValidationError::InvalidGateway);
        }
        Ok(())
    }

    /// Validate an optional SSH DNAT port against root-owned host policy.
    pub fn validate_ssh_public_port(&self, port: Option<u16>) -> Result<(), ValidationError> {
        if port.is_some_and(|port| {
            port < self.ssh_public_port_start || port > self.ssh_public_port_end
        }) {
            return Err(ValidationError::SshPortOutsideConfiguredRange);
        }
        Ok(())
    }
}
