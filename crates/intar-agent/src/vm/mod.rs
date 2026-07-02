#![forbid(unsafe_code)]

mod kino_recording;
mod mac;
mod manager;
pub(crate) mod qemu_img;
mod replay_media;
mod runtime_disk;

pub use manager::{
    CreateScenarioVmRequest, CreateScenarioVmRuntime, CreateScenarioVmRuntimeKino,
    CreateScenarioVmRuntimeNetwork, CreateVmResources, VmLifecycleState, VmManager,
    VmStatusResponse,
};
