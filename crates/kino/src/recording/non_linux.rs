use crate::config::RecordingConfig;
use anyhow::{Result, bail};

pub(crate) fn record_command(_config: &RecordingConfig, _command: &str) -> Result<i32> {
    bail!("recording is only supported on Linux")
}

pub(crate) fn record_ssh(
    _config: &RecordingConfig,
    _command: Option<&str>,
    _startup_mode: super::ShellStartupMode,
) -> Result<i32> {
    bail!("recording is only supported on Linux")
}
