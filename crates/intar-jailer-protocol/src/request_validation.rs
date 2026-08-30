use super::*;

impl VmLaunchRequest {
    pub fn validate(&self) -> Result<CpuQuota, ValidationError> {
        if self.artifacts.tools_disk.is_some() {
            return Err(ValidationError::InvalidToolsDisk);
        }
        self.validate_inner(false)
    }

    pub(super) fn validate_inner(
        &self,
        allow_prepared_boot_artifacts: bool,
    ) -> Result<CpuQuota, ValidationError> {
        if self.vcpu_count == 0 {
            return Err(ValidationError::ZeroVcpus);
        }
        if u64::from(self.cpu_millis) > u64::from(self.vcpu_count) * 1_000 {
            return Err(ValidationError::QuotaExceedsTopology);
        }
        if self.memory_mib == 0 {
            return Err(ValidationError::ZeroMemory);
        }
        if self.root_disk_size_bytes == 0 {
            return Err(ValidationError::ZeroRootDiskSize);
        }
        validate_tap_name(&self.tap_name)?;
        validate_mac(&self.mac_address)?;
        parse_cidr(&self.guest_ip_cidr)?;
        if self.ssh_public_port == Some(0) {
            return Err(ValidationError::InvalidSshPort);
        }
        if self.vsock_cid < 3 {
            return Err(ValidationError::InvalidVsockCid);
        }
        if self.artifacts.kernel.access != ArtifactAccess::ReadOnly
            || self
                .artifacts
                .initrd
                .as_ref()
                .is_some_and(|source| source.access != ArtifactAccess::ReadOnly)
            || self.artifacts.root_disk.access != ArtifactAccess::ReadWrite
            || self.artifacts.runtime_disk.access != ArtifactAccess::ReadOnly
            || self.artifacts.recording_disk.access != ArtifactAccess::ReadWrite
            || self
                .artifacts
                .tools_disk
                .as_ref()
                .is_some_and(|source| source.access != ArtifactAccess::ReadOnly)
        {
            return Err(ValidationError::InvalidArtifactAccess);
        }
        for source in [
            Some(&self.artifacts.kernel),
            self.artifacts.initrd.as_ref(),
            Some(&self.artifacts.root_disk),
            Some(&self.artifacts.runtime_disk),
            Some(&self.artifacts.recording_disk),
            self.artifacts.tools_disk.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            source.validate()?;
        }
        let boot_artifacts = [
            Some(&self.artifacts.root_disk),
            Some(&self.artifacts.kernel),
            self.artifacts.initrd.as_ref(),
        ];
        if !allow_prepared_boot_artifacts
            && boot_artifacts
                .into_iter()
                .flatten()
                .any(|source| source.source_root == PREPARED_IMAGE_SOURCE_ROOT)
        {
            return Err(ValidationError::TemplateLaunchRequiresV2);
        }
        if self.artifacts.runtime_disk.source_root == PREPARED_IMAGE_SOURCE_ROOT
            || self.artifacts.recording_disk.source_root == PREPARED_IMAGE_SOURCE_ROOT
            || self
                .artifacts
                .tools_disk
                .as_ref()
                .is_some_and(|source| source.source_root == PREPARED_IMAGE_SOURCE_ROOT)
        {
            return Err(ValidationError::InvalidTemplateRuntimeSource);
        }
        if self.artifacts.kernel.sha256.is_none()
            || self
                .artifacts
                .initrd
                .as_ref()
                .is_some_and(|source| source.sha256.is_none())
        {
            return Err(ValidationError::MissingBootArtifactHash);
        }
        CpuQuota::from_millis(self.cpu_millis)
    }
}
