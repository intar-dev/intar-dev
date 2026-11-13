use super::*;

/// The origin (scheme, host, port) of the configured registry URL: `/v2`
/// lives there, whatever path the URL names.
pub(crate) fn registry_origin(registry: &ImageRegistryConfig) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(registry.url.trim())
        .with_context(|| "image registry URL is invalid")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        anyhow::bail!("image registry URL must be an absolute HTTP(S) URL");
    }
    reqwest::Url::parse(&url.origin().ascii_serialization())
        .context("image registry origin is invalid")
}

pub(super) async fn bootstrap_agent_access(
    bridge: &BridgeConfig,
    client: &reqwest::Client,
) -> Result<String> {
    Ok(crate::bridge::bootstrap_agent_access(bridge, client)
        .await?
        .access_token)
}

pub(super) async fn create_tmp_file(
    dir: &Path,
    filename: &str,
) -> Result<(PathBuf, tokio::fs::File)> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let pid = std::process::id();

    let mut attempts = 0u8;
    loop {
        attempts = attempts.saturating_add(1);
        let candidate = dir.join(format!(".{filename}.part.{pid}.{nanos}.{attempts}"));
        let open_result = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
            .await;
        match open_result {
            Ok(file) => return Ok((candidate, file)),
            Err(e) if attempts < 8 && e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                return Err(anyhow::anyhow!(
                    "failed to create temp file in {}: {e}",
                    dir.display()
                ));
            }
        }
    }
}

pub(super) async fn sha256_file(path: &Path) -> Result<String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .with_context(|| format!("failed to open file for hashing at {}", path.display()))?;
    sha256_open_file(&mut file, path).await
}

/// Hash an already opened descriptor.
///
/// Callers that must not follow a symlink or accept a path replacement open
/// the file themselves, validate the descriptor, and only then stream it here,
/// so the digest always describes the file they checked.
pub(super) async fn sha256_open_file<R>(file: &mut R, path: &Path) -> Result<String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buf)
            .await
            .with_context(|| format!("failed reading file for hashing at {}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(to_hex_lower(&hasher.finalize()))
}

pub(super) fn to_hex_lower(digest: &[u8]) -> String {
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push(nibble_to_hex(byte >> 4));
        out.push(nibble_to_hex(byte & 0x0f));
    }
    out
}

pub(super) fn nibble_to_hex(nibble: u8) -> char {
    match nibble {
        0..=9 => (b'0' + nibble) as char,
        10..=15 => (b'a' + (nibble - 10)) as char,
        _ => '0',
    }
}
