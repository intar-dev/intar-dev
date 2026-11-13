use std::io::Write as _;
use std::path::Path;
use std::sync::Arc;

use anyhow::{Context as _, Result, bail};
use russh::keys::{
    PrivateKey, PrivateKeyWithHashAlg,
    ssh_key::{Algorithm, LineEnding},
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
    /// Close the build connection before saving guest network state.
    pub async fn disconnect(self) -> Result<()> {
        self.session
            .disconnect(
                russh::Disconnect::ByApplication,
                "build stage complete",
                "en",
            )
            .await
            .context("failed to disconnect build SSH")
    }
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
        self.exec_with_optional_input(&command, Some(file), None)
            .await
            .with_context(|| {
                format!(
                    "failed to upload '{}' to build guest at {remote_path}",
                    local_path.display()
                )
            })
    }
    pub async fn run(&mut self, command: &str) -> Result<()> {
        self.exec_with_optional_input(command, None, None).await
    }

    /// Run `command` with its output appended to `log_path`, never to this
    /// process's own output.
    pub async fn run_logged(&mut self, command: &str, log_path: &Path) -> Result<()> {
        self.exec_with_optional_input(command, None, Some(log_path))
            .await
    }

    async fn exec_with_optional_input(
        &mut self,
        command: &str,
        input: Option<tokio::fs::File>,
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

        let mut log = CappedLog::open(log_path, BUILD_LOG_LIMIT_BYTES)?;
        let mut exit_status = None;
        let mut output_tail = Vec::new();
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    log.write(&data)?;
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

/// The most a build log may hold; a command that writes past it fails.
pub const BUILD_LOG_LIMIT_BYTES: u64 = 64 * 1024 * 1024;

/// A log file that refuses to grow past `limit` bytes.
struct CappedLog {
    file: Option<std::fs::File>,
    size: u64,
    limit: u64,
}

impl CappedLog {
    fn open(log_path: Option<&Path>, limit: u64) -> Result<Self> {
        let Some(log_path) = log_path else {
            return Ok(Self {
                file: None,
                size: 0,
                limit,
            });
        };
        if let Some(parent) = log_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("failed to create '{}'", parent.display()))?;
        }
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path)
            .with_context(|| format!("failed to open build log '{}'", log_path.display()))?;
        let size = file.metadata()?.len();
        Ok(Self {
            file: Some(file),
            size,
            limit,
        })
    }

    /// Append `data`, or note the cut and fail when it would pass the limit.
    fn write(&mut self, data: &[u8]) -> Result<()> {
        let Some(file) = self.file.as_mut() else {
            return Ok(());
        };
        let room = self.limit.saturating_sub(self.size);
        if data.len() as u64 > room {
            let fits = usize::try_from(room).unwrap_or(data.len()).min(data.len());
            file.write_all(&data[..fits])?;
            file.write_all(b"\n[intar-machine] build log limit reached; output cut\n")?;
            self.file = None;
            bail!(
                "the build wrote more than {} bytes of output; the build log keeps at most that",
                self.limit
            );
        }
        file.write_all(data)
            .context("failed to append build SSH output to build log")?;
        self.size += data.len() as u64;
        Ok(())
    }
}

struct AcceptUnknownHostKey;

impl client::Handler for AcceptUnknownHostKey {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::PublicKeyOrCertificate,
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

    use super::{CappedLog, generate_build_ssh_key, private_key_to_openssh, shell_quote};

    #[test]
    fn the_build_log_stops_at_its_limit_and_fails() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("build.log");
        std::fs::write(&path, "head\n").unwrap();
        let mut log = CappedLog::open(Some(&path), 20).unwrap();
        log.write(b"0123456789").unwrap();
        let error = log.write(b"abcdefghij").unwrap_err();
        assert!(error.to_string().contains("more than 20 bytes"), "{error}");
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.starts_with("head\n0123456789abcde\n"), "{content}");
        assert!(content.ends_with("output cut\n"), "{content}");
    }

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
