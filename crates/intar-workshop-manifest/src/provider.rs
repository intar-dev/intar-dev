use std::collections::HashSet;
use std::fmt::Display;

use crate::error::{WorkshopManifestError, invalid};
use crate::model::{
    ProviderArchitecture, ResolvedProviderHardware, ResolvedRuntimeProfile, RuntimeProfile,
    RuntimeProfileObservation, RuntimeProfileResolutionRequest, RuntimeProviderKind,
    ValidatedWorkshop, WorkspaceVm,
};

/// Publication-time boundary implemented by the provider control planes.
/// Implementations resolve the exact requested machine type, turn mutable image
/// families into immutable identities, and report availability without making
/// substitutions.
pub trait RuntimeProfileResolver {
    type Error: Display;

    fn resolve_profile(
        &self,
        request: RuntimeProfileResolutionRequest<'_>,
    ) -> std::result::Result<RuntimeProfileObservation, Self::Error>;
}

/// Resolve every profile and prove it satisfies the common workspace
/// requirements. Results retain source order so profile IDs are stable in the
/// immutable Workshop revision.
pub fn resolve_runtime_profiles<R>(
    workshop: &ValidatedWorkshop,
    resolver: &R,
) -> std::result::Result<Vec<ResolvedRuntimeProfile>, WorkshopManifestError>
where
    R: RuntimeProfileResolver,
{
    workshop
        .manifest
        .workspace
        .runtime_profiles
        .iter()
        .map(|profile| {
            let vm = workshop
                .manifest
                .workspace
                .vms
                .iter()
                .find(|vm| vm.id == profile.vm_id)
                .ok_or_else(|| {
                    invalid(format!(
                        "runtime profile '{}' references unknown vm '{}'",
                        profile.id, profile.vm_id
                    ))
                })?;
            if profile.provider == RuntimeProviderKind::AgentKvm {
                return resolve_agent_kvm_profile(profile, vm);
            }
            let observation = resolver
                .resolve_profile(RuntimeProfileResolutionRequest {
                    profile,
                    requirements: vm,
                })
                .map_err(|error| {
                    invalid(format!(
                        "failed to resolve {} runtime profile '{}': {error}",
                        provider_name(profile.provider),
                        profile.id
                    ))
                })?;
            validate_direct_cloud_observation(profile, vm, observation)
        })
        .collect()
}

fn resolve_agent_kvm_profile(
    profile: &RuntimeProfile,
    vm: &WorkspaceVm,
) -> std::result::Result<ResolvedRuntimeProfile, WorkshopManifestError> {
    Ok(ResolvedRuntimeProfile {
        id: profile.id.clone(),
        provider: profile.provider,
        vm_id: profile.vm_id.clone(),
        machine_type: None,
        requested_system_image: profile.system_image.clone(),
        immutable_system_image: profile.system_image.clone(),
        root_disk_type: None,
        locations: Vec::new(),
        hardware: ResolvedProviderHardware {
            architecture: ProviderArchitecture::X86_64,
            cpu_millis: vm.cpu_millis,
            provider_cpu_count: vm.cpu_millis.div_ceil(1_000),
            memory_mib: vm.memory_mib,
            disk_mib: vm.disk_mib,
        },
    })
}

fn validate_direct_cloud_observation(
    profile: &RuntimeProfile,
    vm: &WorkspaceVm,
    observation: RuntimeProfileObservation,
) -> std::result::Result<ResolvedRuntimeProfile, WorkshopManifestError> {
    if observation.provider != profile.provider {
        return Err(invalid(format!(
            "runtime profile '{}' resolved provider '{}' instead of requested '{}'",
            profile.id,
            provider_name(observation.provider),
            provider_name(profile.provider)
        )));
    }
    let requested_machine_type = profile.machine_type.as_deref().ok_or_else(|| {
        invalid(format!(
            "runtime profile '{}' has no machine_type",
            profile.id
        ))
    })?;
    if observation.machine_type != requested_machine_type {
        return Err(invalid(format!(
            "runtime profile '{}' resolved machine_type '{}' instead of exact requested type '{}'",
            profile.id, observation.machine_type, requested_machine_type
        )));
    }
    if observation.deprecated {
        return Err(invalid(format!(
            "runtime profile '{}' machine_type '{}' is deprecated",
            profile.id, requested_machine_type
        )));
    }
    if observation.architecture != ProviderArchitecture::X86_64 {
        return Err(invalid(format!(
            "runtime profile '{}' machine_type '{}' must use x86_64 architecture",
            profile.id, requested_machine_type
        )));
    }
    if !observation.system_image_is_immutable || observation.resolved_system_image.trim().is_empty()
    {
        return Err(invalid(format!(
            "runtime profile '{}' system image did not resolve to an immutable identity",
            profile.id
        )));
    }
    let mut observed_locations = HashSet::new();
    if observation.available_locations.is_empty()
        || observation.available_locations.iter().any(|location| {
            !valid_location(location) || !observed_locations.insert(location.as_str())
        })
    {
        return Err(invalid(format!(
            "runtime profile '{}' resolved an invalid or empty location set",
            profile.id
        )));
    }
    if profile.provider == RuntimeProviderKind::GcpCompute {
        let available = observation
            .available_locations
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let unavailable = profile
            .locations
            .iter()
            .filter(|location| !available.contains(location.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        if !unavailable.is_empty() {
            return Err(invalid(format!(
                "runtime profile '{}' machine_type '{}' is unavailable in requested locations: {}",
                profile.id,
                requested_machine_type,
                unavailable.join(", ")
            )));
        }
    }

    let available_cpu_millis = observation.cores.checked_mul(1_000).ok_or_else(|| {
        invalid(format!(
            "runtime profile '{}' CPU shape is out of range",
            profile.id
        ))
    })?;
    let mut shortages = Vec::new();
    if available_cpu_millis < vm.cpu_millis {
        shortages.push(format!(
            "CPU {available_cpu_millis}m < required {}m",
            vm.cpu_millis
        ));
    }
    if observation.memory_mib < vm.memory_mib {
        shortages.push(format!(
            "memory {} MiB < required {} MiB",
            observation.memory_mib, vm.memory_mib
        ));
    }
    if observation.disk_mib < vm.disk_mib {
        shortages.push(format!(
            "disk {} MiB < required {} MiB",
            observation.disk_mib, vm.disk_mib
        ));
    }
    if !shortages.is_empty() {
        return Err(invalid(format!(
            "runtime profile '{}' machine_type '{}' is undersized: {}",
            profile.id,
            requested_machine_type,
            shortages.join(", ")
        )));
    }

    let locations = if profile.locations.is_empty() {
        observation.available_locations
    } else {
        profile.locations.clone()
    };
    Ok(ResolvedRuntimeProfile {
        id: profile.id.clone(),
        provider: profile.provider,
        vm_id: profile.vm_id.clone(),
        machine_type: Some(requested_machine_type.to_owned()),
        requested_system_image: profile.system_image.clone(),
        immutable_system_image: observation.resolved_system_image,
        root_disk_type: profile.root_disk_type.clone(),
        locations,
        hardware: ResolvedProviderHardware {
            architecture: observation.architecture,
            cpu_millis: available_cpu_millis,
            provider_cpu_count: observation.cores,
            memory_mib: observation.memory_mib,
            disk_mib: observation.disk_mib,
        },
    })
}

fn valid_location(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 63
        && bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes.last().is_some_and(u8::is_ascii_alphanumeric)
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

const fn provider_name(provider: RuntimeProviderKind) -> &'static str {
    match provider {
        RuntimeProviderKind::AgentKvm => "agent_kvm",
        RuntimeProviderKind::HetznerCloud => "hetzner_cloud",
        RuntimeProviderKind::GcpCompute => "gcp_compute",
    }
}
