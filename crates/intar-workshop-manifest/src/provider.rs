use std::fmt::Display;

use crate::error::{WorkshopManifestError, invalid};
use crate::model::{
    HetznerServerTypeObservation, ProviderArchitecture, ResolvedProviderHardware,
    ResolvedWorkspaceProvider, ValidatedWorkshop, WorkspaceProvider,
};

/// Publication-time boundary implemented by the trusted provider service.
/// Implementations resolve the exact requested type and must not substitute a
/// different name when a type is unavailable.
pub trait HetznerServerTypeResolver {
    type Error: Display;

    fn resolve_server_type(
        &self,
        exact_name: &str,
    ) -> std::result::Result<HetznerServerTypeObservation, Self::Error>;
}

/// Resolve and prove that an author-declared provider can run this workshop.
/// The returned value is safe to pin in an immutable workshop revision.
pub fn resolve_workspace_provider<R>(
    workshop: &ValidatedWorkshop,
    resolver: &R,
) -> std::result::Result<ResolvedWorkspaceProvider, WorkshopManifestError>
where
    R: HetznerServerTypeResolver,
{
    let Some(provider) = &workshop.manifest.workspace.provider else {
        return Ok(ResolvedWorkspaceProvider::AgentKvm);
    };

    match provider {
        WorkspaceProvider::HetznerCloud {
            vm_id,
            server_type,
            system_image,
        } => {
            let vm = workshop
                .manifest
                .workspace
                .vms
                .iter()
                .find(|vm| vm.id == *vm_id)
                .ok_or_else(|| {
                    invalid(format!(
                        "workspace provider 'hetzner_cloud' references unknown vm '{vm_id}'"
                    ))
                })?;
            let observed = resolver.resolve_server_type(server_type).map_err(|error| {
                invalid(format!(
                    "failed to resolve Hetzner server_type '{server_type}': {error}"
                ))
            })?;
            if observed.name != *server_type {
                return Err(invalid(format!(
                    "Hetzner resolved server_type '{}' instead of exact requested type '{}'",
                    observed.name, server_type
                )));
            }
            if observed.deprecated {
                return Err(invalid(format!(
                    "Hetzner server_type '{server_type}' is deprecated"
                )));
            }
            if observed.architecture != ProviderArchitecture::X86 {
                return Err(invalid(format!(
                    "Hetzner server_type '{server_type}' must use x86 architecture"
                )));
            }
            let available_cpu_millis = observed.cores.checked_mul(1_000).ok_or_else(|| {
                invalid(format!(
                    "Hetzner server_type '{server_type}' CPU shape is out of range"
                ))
            })?;
            let required_disk_mib = vm.disk_gib.checked_mul(1_024).ok_or_else(|| {
                invalid(format!("vm '{}' disk requirement is out of range", vm.id))
            })?;
            let mut shortages = Vec::new();
            if available_cpu_millis < vm.vcpu_millis {
                shortages.push(format!(
                    "CPU {available_cpu_millis}m < required {}m",
                    vm.vcpu_millis
                ));
            }
            if observed.memory_mib < vm.memory_mib {
                shortages.push(format!(
                    "memory {} MiB < required {} MiB",
                    observed.memory_mib, vm.memory_mib
                ));
            }
            if observed.disk_mib < required_disk_mib {
                shortages.push(format!(
                    "disk {} MiB < required {required_disk_mib} MiB",
                    observed.disk_mib
                ));
            }
            if !shortages.is_empty() {
                return Err(invalid(format!(
                    "Hetzner server_type '{server_type}' is undersized: {}",
                    shortages.join(", ")
                )));
            }

            Ok(ResolvedWorkspaceProvider::HetznerCloud {
                vm_id: vm_id.clone(),
                server_type: server_type.clone(),
                system_image: system_image.clone(),
                hardware: ResolvedProviderHardware {
                    architecture: observed.architecture,
                    cores: observed.cores,
                    memory_mib: observed.memory_mib,
                    disk_mib: observed.disk_mib,
                },
                compatible: true,
            })
        }
    }
}
