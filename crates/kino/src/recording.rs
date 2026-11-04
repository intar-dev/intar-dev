pub(crate) use imp::{record_command, record_ssh};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RecordingConfig {
    pub(crate) output_dir: std::path::PathBuf,
    pub(crate) real_shell: std::path::PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ShellStartupMode {
    Login,
    Interactive,
}

#[cfg(target_os = "linux")]
#[path = "recording/linux.rs"]
mod imp;

#[cfg(not(target_os = "linux"))]
#[path = "recording/non_linux.rs"]
mod imp;
