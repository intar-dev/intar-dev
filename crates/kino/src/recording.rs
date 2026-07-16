pub(crate) use imp::{record_command, record_ssh};

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
