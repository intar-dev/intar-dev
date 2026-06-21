#![forbid(unsafe_code)]

mod kino_recording;
mod mac;
mod manager;
mod qemu_img;
mod replay_media;
mod runtime_disk;

pub use manager::{CreateScenarioVmRequest, VmManager, VmTerminalState};
