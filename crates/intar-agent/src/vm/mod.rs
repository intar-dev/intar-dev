#![forbid(unsafe_code)]

mod mac;
mod manager;
mod runtime_disk;

#[cfg(test)]
pub use manager::VmTerminalTarget;
pub use manager::{
    CreateScenarioVmRequest, CreateScenarioVmRuntime, CreateScenarioVmRuntimeKino,
    CreateScenarioVmRuntimeNetwork, CreateVmResources, VmLifecycleState, VmManager,
    VmStatusResponse, VmTerminalState, VmTerminalStateKind,
};
pub(crate) use manager::{GuestUpdate, ImagePrepareRequeued, is_safe_key, jail_vm_exited};
