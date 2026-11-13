#![forbid(unsafe_code)]

mod check_passes;
mod krec;
mod mac;
mod manager;
mod replay_compose;
mod replay_media;
mod runtime_disk;
mod transcript;

#[cfg(test)]
pub use manager::VmTerminalTarget;
pub use manager::{
    CreateScenarioVmRequest, CreateScenarioVmRuntime, CreateScenarioVmRuntimeKino,
    CreateScenarioVmRuntimeNetwork, CreateVmResources, VmLifecycleState, VmManager,
    VmStatusResponse, VmTerminalState, VmTerminalStateKind,
};
pub(crate) use manager::{GuestUpdate, ImagePrepareRequeued};
