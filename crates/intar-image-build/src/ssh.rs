use std::io::Write as _;
use std::path::Path;
use std::sync::Arc;

use anyhow::{Context as _, Result, bail};
use russh::keys::{
    PrivateKey, PrivateKeyWithHashAlg,
    ssh_key::{Algorithm, LineEnding, PublicKey},
};
use russh::{ChannelMsg, client};

#[derive(Debug)]
pub struct BuildSshKey {
    pub private_key: PrivateKey,
    pub public_key_openssh: String,
}

pub fn generate_build_ssh_key() -> Result<BuildSshKey> {
    let mut rng = russh::keys::key::safe_rng();
    let private_key = PrivateKey::random(&mut rng, Algorithm::Ed25519)
        .context("failed to generate build SSH key")?;
    let public_key_openssh = private_key
        .public_key()
        .to_openssh()
        .context("failed to encode build SSH public key")?;
    Ok(BuildSshKey {
        private_key,
        public_key_openssh,
    })
}

pub fn private_key_to_openssh(private_key: &PrivateKey) -> Result<String> {
    Ok(private_key
        .to_openssh(LineEnding::LF)
        .context("failed to encode build SSH private key")?
        .to_string())
}

pub struct BuildSshSession {
    session: client::Handle<AcceptUnknownHostKey>,
}

impl BuildSshSession {
    pub async fn connect(
        host: &str,
        port: u16,
        username: &str,
        private_key: &PrivateKey,
    ) -> Result<Self> {
        let config = Arc::new(client::Config::default());
        let mut session = client::connect(config, (host, port), AcceptUnknownHostKey)
            .await
            .with_context(|| format!("failed to connect to build SSH at {host}:{port}"))?;
        let authenticated = session
            .authenticate_publickey(
                username,
                PrivateKeyWithHashAlg::new(Arc::new(private_key.clone()), None),
            )
            .await
            .context("build SSH public key authentication failed")?;
        if !authenticated.success() {
            bail!("build SSH public key authentication was rejected");
        }
        Ok(Self { session })
    }

    pub async fn upload_file(
        &mut self,
        local_path: &Path,
        remote_path: &str,
        mode: u32,
    ) -> Result<()> {
        let file = tokio::fs::File::open(local_path)
            .await
            .with_context(|| format!("failed to open upload source '{}'", local_path.display()))?;
        let remote = shell_quote(remote_path);
        let command = format!("cat > {remote} && chmod {mode:o} {remote}");
        self.exec_with_optional_input(&command, Some(file), false, None)
            .await
            .with_context(|| {
                format!(
                    "failed to upload '{}' to build guest at {remote_path}",
                    local_path.display()
                )
            })
    }

    /// Download one trusted guest file without invoking a host `ssh` binary.
    /// The remote path is shell-quoted and the local destination must not
    /// already exist.
    pub async fn download_file(&mut self, remote_path: &str, local_path: &Path) -> Result<()> {
        self.download_file_inner(remote_path, local_path, None)
            .await
    }

    /// Download one guest file while rejecting a response larger than
    /// `maximum_bytes`. A failed or oversized transfer removes the incomplete
    /// local destination.
    pub async fn download_file_limited(
        &mut self,
        remote_path: &str,
        local_path: &Path,
        maximum_bytes: u64,
    ) -> Result<()> {
        self.download_file_inner(remote_path, local_path, Some(maximum_bytes))
            .await
    }

    async fn download_file_inner(
        &mut self,
        remote_path: &str,
        local_path: &Path,
        maximum_bytes: Option<u64>,
    ) -> Result<()> {
        if let Some(parent) = local_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("failed to create '{}'", parent.display()))?;
        }
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(local_path)
            .with_context(|| format!("failed to create '{}'", local_path.display()))?;
        let remote = shell_quote(remote_path);
        let command = format!("cat -- {remote}");
        let result = async {
            let mut channel = self
                .session
                .channel_open_session()
                .await
                .context("failed to open build SSH download channel")?;
            channel
                .exec(true, command.as_str())
                .await
                .with_context(|| format!("failed to download guest file {remote}"))?;
            channel
                .eof()
                .await
                .context("failed to close build SSH download stdin")?;
            let mut exit_status = None;
            let mut error_tail = Vec::new();
            let mut bytes_written = 0_u64;
            while let Some(message) = channel.wait().await {
                match message {
                    ChannelMsg::Data { data } => {
                        let chunk_len = u64::try_from(data.len())
                            .context("downloaded guest file chunk length does not fit in u64")?;
                        let next_size = bytes_written
                            .checked_add(chunk_len)
                            .context("downloaded guest file size overflowed")?;
                        if let Some(maximum) = maximum_bytes
                            && next_size > maximum
                        {
                            bail!("build SSH download {remote} exceeded the {maximum}-byte limit");
                        }
                        output
                            .write_all(&data)
                            .context("failed to write downloaded guest file")?;
                        bytes_written = next_size;
                    }
                    ChannelMsg::ExtendedData { data, .. } => {
                        append_limited(&mut error_tail, &data);
                    }
                    ChannelMsg::ExitStatus { exit_status: code } => exit_status = Some(code),
                    ChannelMsg::ExitSignal {
                        signal_name,
                        error_message,
                        ..
                    } => bail!(
                        "build SSH download {remote} exited from signal {signal_name:?}: {error_message}"
                    ),
                    _ => {}
                }
            }
            match exit_status {
                Some(0) => output
                    .sync_all()
                    .context("failed to sync downloaded guest file"),
                Some(code) => bail!(
                    "build SSH download {remote} failed with status {code}: {}",
                    String::from_utf8_lossy(&error_tail)
                ),
                None => bail!("build SSH download {remote} closed without exit status"),
            }
        }
        .await;
        if result.is_err() {
            drop(output);
            let _ = std::fs::remove_file(local_path);
        }
        result
    }

    pub async fn run(&mut self, command: &str, inherit_output: bool) -> Result<()> {
        self.exec_with_optional_input(command, None, inherit_output, None)
            .await
    }

    pub async fn run_logged(
        &mut self,
        command: &str,
        inherit_output: bool,
        log_path: &Path,
    ) -> Result<()> {
        self.exec_with_optional_input(command, None, inherit_output, Some(log_path))
            .await
    }

    async fn exec_with_optional_input(
        &mut self,
        command: &str,
        input: Option<tokio::fs::File>,
        inherit_output: bool,
        log_path: Option<&Path>,
    ) -> Result<()> {
        let mut channel = self
            .session
            .channel_open_session()
            .await
            .context("failed to open build SSH session channel")?;
        channel
            .exec(true, command)
            .await
            .with_context(|| format!("failed to execute build SSH command '{command}'"))?;
        if let Some(file) = input {
            channel
                .data(file)
                .await
                .context("failed to stream build SSH command stdin")?;
        }
        channel
            .eof()
            .await
            .context("failed to close build SSH command stdin")?;

        let mut log_file = open_log_file(log_path)?;
        let mut exit_status = None;
        let mut output_tail = Vec::new();
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    if inherit_output {
                        std::io::stdout()
                            .write_all(&data)
                            .context("failed to write build SSH stdout")?;
                    }
                    write_log_chunk(log_file.as_mut(), &data)?;
                    append_limited(&mut output_tail, &data);
                }
                ChannelMsg::ExtendedData { data, .. } => {
                    if inherit_output {
                        std::io::stderr()
                            .write_all(&data)
                            .context("failed to write build SSH stderr")?;
                    }
                    write_log_chunk(log_file.as_mut(), &data)?;
                    append_limited(&mut output_tail, &data);
                }
                ChannelMsg::ExitStatus { exit_status: code } => {
                    exit_status = Some(code);
                }
                ChannelMsg::ExitSignal {
                    signal_name,
                    error_message,
                    ..
                } => {
                    bail!(
                        "build SSH command '{command}' exited from signal {signal_name:?}: {error_message}"
                    );
                }
                _ => {}
            }
        }

        match exit_status {
            Some(0) => Ok(()),
            Some(code) => {
                let output = String::from_utf8_lossy(&output_tail);
                bail!("build SSH command '{command}' failed with status {code}: {output}");
            }
            None => bail!("build SSH command '{command}' closed without exit status"),
        }
    }
}

fn open_log_file(log_path: Option<&Path>) -> Result<Option<std::fs::File>> {
    let Some(log_path) = log_path else {
        return Ok(None);
    };
    if let Some(parent) = log_path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create '{}'", parent.display()))?;
    }
    Ok(Some(
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path)
            .with_context(|| format!("failed to open build log '{}'", log_path.display()))?,
    ))
}

fn write_log_chunk(log_file: Option<&mut std::fs::File>, data: &[u8]) -> Result<()> {
    if let Some(log_file) = log_file {
        log_file
            .write_all(data)
            .context("failed to append build SSH output to build log")?;
    }
    Ok(())
}

struct AcceptUnknownHostKey;

impl client::Handler for AcceptUnknownHostKey {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKey,
    ) -> std::result::Result<bool, Self::Error> {
        Ok(true)
    }
}

fn append_limited(buffer: &mut Vec<u8>, data: &[u8]) {
    const LIMIT: usize = 64 * 1024;
    if data.len() >= LIMIT {
        buffer.clear();
        buffer.extend_from_slice(&data[data.len() - LIMIT..]);
        return;
    }
    if buffer.len() + data.len() > LIMIT {
        let excess = buffer.len() + data.len() - LIMIT;
        buffer.drain(..excess);
    }
    buffer.extend_from_slice(data);
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::{generate_build_ssh_key, private_key_to_openssh, shell_quote};

    #[test]
    fn generates_ed25519_build_key_without_ssh_keygen() {
        let key = generate_build_ssh_key().unwrap();

        assert!(key.public_key_openssh.starts_with("ssh-ed25519 "));
        let private_openssh = private_key_to_openssh(&key.private_key).unwrap();
        assert!(private_openssh.contains("BEGIN OPENSSH PRIVATE KEY"));
    }

    #[test]
    fn shell_quote_handles_single_quotes() {
        assert_eq!(shell_quote("/tmp/intar"), "'/tmp/intar'");
        assert_eq!(shell_quote("/tmp/intar's file"), "'/tmp/intar'\\''s file'");
    }
}
