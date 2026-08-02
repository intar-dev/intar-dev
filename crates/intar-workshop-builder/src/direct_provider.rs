use anyhow::{Result, bail};

use crate::backend::{
    BeginWorkshopBuild, CanonicalScript, RuntimeBundleColdBoot, RuntimeBundleColdBootProof,
    SealCheckpoint, SealedVmArtifact, WorkshopExecutionBackend,
};

/// Capability fence for builders that may only emit direct-provider runtime
/// bundles. Every operation on the local VM lifecycle fails closed.
#[derive(Debug, Default)]
pub struct DirectProviderOnlyBackend;

impl DirectProviderOnlyBackend {
    pub const fn new() -> Self {
        Self
    }
}

fn reject_local_execution<T>(operation: &str) -> Result<T> {
    bail!(
        "direct_provider_only builder refused local VM operation '{operation}'; this publication requires an agent_kvm builder"
    )
}

impl WorkshopExecutionBackend for DirectProviderOnlyBackend {
    fn begin(&mut self, _request: &BeginWorkshopBuild<'_>) -> Result<()> {
        reject_local_execution("begin")
    }

    fn run_canonical_script(&mut self, _script: &CanonicalScript<'_>) -> Result<()> {
        reject_local_execution("run_canonical_script")
    }

    fn sanitize_and_shutdown(&mut self, _checkpoint_id: &str) -> Result<()> {
        reject_local_execution("sanitize_and_shutdown")
    }

    fn seal_checkpoint(&mut self, _request: &SealCheckpoint<'_>) -> Result<Vec<SealedVmArtifact>> {
        reject_local_execution("seal_checkpoint")
    }

    fn cold_boot_checkpoint(
        &mut self,
        _checkpoint_id: &str,
        _artifacts: &[SealedVmArtifact],
    ) -> Result<()> {
        reject_local_execution("cold_boot_checkpoint")
    }

    fn finish_cold_boot(&mut self, _checkpoint_id: &str) -> Result<()> {
        reject_local_execution("finish_cold_boot")
    }

    fn cold_boot_runtime_bundle(
        &mut self,
        _request: &RuntimeBundleColdBoot<'_>,
    ) -> Result<RuntimeBundleColdBootProof> {
        reject_local_execution("cold_boot_runtime_bundle")
    }

    fn resume_from_checkpoint(
        &mut self,
        _checkpoint_id: &str,
        _artifacts: &[SealedVmArtifact],
    ) -> Result<()> {
        reject_local_execution("resume_from_checkpoint")
    }

    fn finish(&mut self) -> Result<()> {
        reject_local_execution("finish")
    }

    fn abort(&mut self) {}
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::DirectProviderOnlyBackend;
    use crate::backend::{BeginWorkshopBuild, WorkshopExecutionBackend};
    use intar_contracts::catalog::ImageArchitecture;
    use intar_workshop_manifest::load_and_validate;

    #[test]
    fn rejects_agent_kvm_lifecycle_before_any_local_execution() {
        let workshop = load_and_validate(std::path::Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../.work/workshops/platform-engineering"
        )))
        .unwrap();
        let mut backend = DirectProviderOnlyBackend::new();

        let error = backend
            .begin(&BeginWorkshopBuild {
                publication_id: "publication-agent-kvm",
                bundle_root: std::path::Path::new("/not-used"),
                manifest: &workshop.manifest,
                architecture: ImageArchitecture::X86_64,
            })
            .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("direct_provider_only builder refused local VM operation 'begin'")
        );
    }
}
