#![forbid(unsafe_code)]

mod kino_recording;
mod mac;
mod manager;
mod replay_compose;
mod replay_media;
mod runtime_disk;

pub use manager::{
    CreateScenarioVmRequest, CreateScenarioVmRuntime, CreateScenarioVmRuntimeKino,
    CreateScenarioVmRuntimeNetwork, CreateVmResources, VmLifecycleState, VmManager,
    VmStatusResponse,
};
