#![allow(clippy::missing_errors_doc)]

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result, anyhow, bail};
use flate2::read::GzDecoder;
use intar_contracts::catalog::ImageArchitecture;
use intar_image_build::{KinoArtifact, sha256_bytes_hex};

use crate::config::BuilderRuntimeConfig;

const KINO_BINARY_NAME: &str = "kino";

pub async fn resolve_kino_artifact(
    config: &BuilderRuntimeConfig,
    version: &str,
    arch: &ImageArchitecture,
) -> Result<KinoArtifact> {
    if let Some(path) = explicit_kino_binary(config) {
        return local_kino_artifact(path, version);
    }

    let binary_path = ensure_cached_kino_release(
        &config.cache_root,
        &config.kino_release_base_url,
        version,
        arch,
    )
    .await?;
    Ok(KinoArtifact {
        binary_path,
        version: normalized_version(version).to_string(),
    })
}

fn explicit_kino_binary(config: &BuilderRuntimeConfig) -> Option<&Path> {
    config
        .kino_binary
        .as_deref()
        .filter(|path| !path.as_os_str().is_empty() && *path != Path::new("."))
}

fn local_kino_artifact(path: &Path, version: &str) -> Result<KinoArtifact> {
    if !path.is_file() {
        bail!("kino binary does not exist at {}", path.display());
    }
    Ok(KinoArtifact {
        binary_path: path.to_path_buf(),
        version: normalized_version(version).to_string(),
    })
}

async fn ensure_cached_kino_release(
    cache_root: &Path,
    release_base_url: &str,
    version: &str,
    arch: &ImageArchitecture,
) -> Result<PathBuf> {
    let version = normalized_version(version);
    validate_version(version)?;
    let arch = release_arch(arch);
    let asset_name = kino_archive_asset_name(version, arch);
    let cache_dir = cache_root.join("kino").join(version).join(arch);
    let binary_path = cache_dir.join(KINO_BINARY_NAME);
    let archive_path = cache_dir.join(&asset_name);
    let marker_path = cache_dir.join(".verified");
    if cached_release_is_verified(&binary_path, &archive_path, &marker_path, &asset_name)? {
        return Ok(binary_path);
    }

    let release_url = release_download_base_url(release_base_url, version)?;
    let checksums_name = kino_checksums_asset_name(version);
    let checksums_url = format!("{release_url}/{checksums_name}");
    let checksums = download_text(&checksums_url).await?;
    let expected_sha256 = parse_checksum_for_asset(&checksums, &asset_name)?;

    let archive_url = format!("{release_url}/{asset_name}");
    let archive_bytes = download_bytes(&archive_url).await?;
    let actual_sha256 = sha256_bytes_hex(&archive_bytes);
    if !actual_sha256.eq_ignore_ascii_case(&expected_sha256) {
        bail!(
            "kino release archive checksum mismatch for {asset_name}: expected {expected_sha256}, got {actual_sha256}"
        );
    }

    fs::create_dir_all(&cache_dir)
        .with_context(|| format!("failed to create kino cache '{}'", cache_dir.display()))?;
    let archive_tmp = cache_dir.join(format!("{asset_name}.tmp"));
    fs::write(&archive_tmp, archive_bytes)
        .with_context(|| format!("failed to write '{}'", archive_tmp.display()))?;
    fs::rename(&archive_tmp, &archive_path).with_context(|| {
        format!(
            "failed to move '{}' to '{}'",
            archive_tmp.display(),
            archive_path.display()
        )
    })?;
    extract_kino_binary(&archive_path, &binary_path)?;
    let binary_sha256 = sha256_file_hex(&binary_path)?;
    fs::write(
        &marker_path,
        format!("asset={asset_name}\nsha256={expected_sha256}\nbinary_sha256={binary_sha256}\n"),
    )
    .with_context(|| format!("failed to write '{}'", marker_path.display()))?;

    Ok(binary_path)
}

fn cached_release_is_verified(
    binary_path: &Path,
    archive_path: &Path,
    marker_path: &Path,
    asset_name: &str,
) -> Result<bool> {
    if !binary_path.is_file() || !archive_path.is_file() || !marker_path.is_file() {
        return Ok(false);
    }
    let marker = fs::read_to_string(marker_path)
        .with_context(|| format!("failed to read '{}'", marker_path.display()))?;
    if !marker
        .lines()
        .any(|line| line.trim() == format!("asset={asset_name}"))
    {
        return Ok(false);
    }
    let Some(archive_sha256) = marker_value(&marker, "sha256=") else {
        return Ok(false);
    };
    if !is_sha256_hex(archive_sha256) || sha256_file_hex(archive_path)? != archive_sha256 {
        return Ok(false);
    }
    let Some(binary_sha256) = marker_value(&marker, "binary_sha256=") else {
        return Ok(false);
    };
    if !is_sha256_hex(binary_sha256) || sha256_file_hex(binary_path)? != binary_sha256 {
        return Ok(false);
    }
    Ok(true)
}

async fn download_text(url: &str) -> Result<String> {
    let bytes = download_bytes(url).await?;
    String::from_utf8(bytes).with_context(|| format!("release asset '{url}' is not valid UTF-8"))
}

async fn download_bytes(url: &str) -> Result<Vec<u8>> {
    let response = reqwest::Client::new()
        .get(url)
        .send()
        .await
        .with_context(|| format!("failed to download {url}"))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .with_context(|| format!("failed to read response body from {url}"))?;
    if !status.is_success() {
        let body = String::from_utf8_lossy(&bytes);
        bail!("download failed for {url} with HTTP {status}: {body}");
    }
    Ok(bytes.to_vec())
}

fn parse_checksum_for_asset(checksums: &str, asset_name: &str) -> Result<String> {
    for line in checksums.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let mut fields = trimmed.split_whitespace();
        let Some(digest) = fields.next() else {
            continue;
        };
        let Some(name) = fields.next() else {
            continue;
        };
        let normalized_name = name.trim_start_matches('*');
        if normalized_name == asset_name {
            if !is_sha256_hex(digest) {
                bail!("checksum for {asset_name} is not a SHA-256 hex digest");
            }
            return Ok(digest.to_ascii_lowercase());
        }
    }
    bail!("checksums file does not contain {asset_name}")
}

fn extract_kino_binary(archive_path: &Path, binary_path: &Path) -> Result<()> {
    let parent = binary_path
        .parent()
        .ok_or_else(|| anyhow!("kino binary cache path has no parent"))?;
    fs::create_dir_all(parent)
        .with_context(|| format!("failed to create '{}'", parent.display()))?;
    let archive_file = fs::File::open(archive_path)
        .with_context(|| format!("failed to open '{}'", archive_path.display()))?;
    let decoder = GzDecoder::new(archive_file);
    let mut archive = tar::Archive::new(decoder);
    let temp_path = binary_path.with_extension("tmp");

    for entry in archive.entries().context("failed to read kino archive")? {
        let mut entry = entry.context("failed to read kino archive entry")?;
        let path = entry.path().context("failed to read kino archive path")?;
        let file_name = path.file_name().and_then(|value| value.to_str());
        if file_name != Some(KINO_BINARY_NAME) {
            continue;
        }
        if !entry.header().entry_type().is_file() {
            bail!(
                "kino release archive entry '{}' is not a file",
                path.display()
            );
        }
        entry
            .unpack(&temp_path)
            .with_context(|| format!("failed to extract '{}'", temp_path.display()))?;
        set_executable_permissions(&temp_path)?;
        fs::rename(&temp_path, binary_path).with_context(|| {
            format!(
                "failed to move '{}' to '{}'",
                temp_path.display(),
                binary_path.display()
            )
        })?;
        return Ok(());
    }

    bail!("kino release archive does not contain a kino binary")
}

#[cfg(unix)]
fn set_executable_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt as _;

    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)
        .with_context(|| format!("failed to chmod '{}'", path.display()))
}

#[cfg(not(unix))]
fn set_executable_permissions(path: &Path) -> Result<()> {
    let _ = path;
    Ok(())
}

fn release_download_base_url(release_base_url: &str, version: &str) -> Result<String> {
    let base = release_base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        bail!("builder.kino_release_base_url must not be empty");
    }
    Ok(format!("{base}/kino%2Fv{version}"))
}

fn kino_archive_asset_name(version: &str, arch: &str) -> String {
    format!("kino_{version}_linux_{arch}.tar.gz")
}

fn kino_checksums_asset_name(version: &str) -> String {
    format!("kino_{version}_checksums.txt")
}

fn normalized_version(version: &str) -> &str {
    version.trim().strip_prefix('v').unwrap_or(version.trim())
}

fn validate_version(version: &str) -> Result<()> {
    if version.is_empty()
        || version
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || matches!(byte, b'/' | b'\\'))
    {
        bail!("invalid kino version '{version}'");
    }
    Ok(())
}

fn release_arch(arch: &ImageArchitecture) -> &'static str {
    match arch {
        ImageArchitecture::X86_64 => "amd64",
        ImageArchitecture::Aarch64 => "arm64",
    }
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn marker_value<'a>(marker: &'a str, prefix: &str) -> Option<&'a str> {
    marker
        .lines()
        .find_map(|line| line.trim().strip_prefix(prefix))
}

fn sha256_file_hex(path: &Path) -> Result<String> {
    let bytes = fs::read(path).with_context(|| format!("failed to read '{}'", path.display()))?;
    Ok(sha256_bytes_hex(&bytes))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use flate2::{Compression, write::GzEncoder};

    use super::{
        cached_release_is_verified, extract_kino_binary, kino_archive_asset_name,
        kino_checksums_asset_name, parse_checksum_for_asset, release_download_base_url,
    };

    #[test]
    fn derives_kino_release_asset_names() {
        assert_eq!(
            release_download_base_url(
                "https://github.com/intar-dev/intar-dev/releases/download/",
                "0.1.24"
            )
            .unwrap(),
            "https://github.com/intar-dev/intar-dev/releases/download/kino%2Fv0.1.24"
        );
        assert_eq!(
            kino_archive_asset_name("0.1.24", "amd64"),
            "kino_0.1.24_linux_amd64.tar.gz"
        );
        assert_eq!(
            kino_checksums_asset_name("0.1.24"),
            "kino_0.1.24_checksums.txt"
        );
    }

    #[test]
    fn parses_release_checksum_for_asset() {
        let checksums = "\
1111111111111111111111111111111111111111111111111111111111111111  kino_0.1.24_linux_arm64.tar.gz
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  kino_0.1.24_linux_amd64.tar.gz
";
        assert_eq!(
            parse_checksum_for_asset(checksums, "kino_0.1.24_linux_amd64.tar.gz").unwrap(),
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
        assert!(parse_checksum_for_asset(checksums, "missing.tar.gz").is_err());
    }

    #[test]
    fn extracts_kino_binary_from_release_archive() {
        let temp = tempfile::tempdir().unwrap();
        let archive_path = temp.path().join("kino.tar.gz");
        let binary_path = temp.path().join("cache/kino");
        {
            let archive_file = std::fs::File::create(&archive_path).unwrap();
            let encoder = GzEncoder::new(archive_file, Compression::default());
            let mut archive = tar::Builder::new(encoder);
            let payload = b"#!/bin/sh\nexit 0\n";
            let mut header = tar::Header::new_gnu();
            header.set_path("kino").unwrap();
            header.set_size(payload.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            archive.append(&header, &payload[..]).unwrap();
            archive.finish().unwrap();
            archive.into_inner().unwrap().finish().unwrap();
        }

        extract_kino_binary(&archive_path, &binary_path).unwrap();

        assert_eq!(
            std::fs::read_to_string(binary_path).unwrap(),
            "#!/bin/sh\nexit 0\n"
        );
    }

    #[test]
    fn cached_release_requires_matching_asset_and_sha() {
        let temp = tempfile::tempdir().unwrap();
        let binary_path = temp.path().join("kino");
        let archive_path = temp.path().join("kino_0.1.24_linux_amd64.tar.gz");
        let marker_path = temp.path().join(".verified");
        std::fs::write(&binary_path, "kino").unwrap();
        std::fs::write(&archive_path, "archive").unwrap();
        let binary_sha256 = super::sha256_file_hex(&binary_path).unwrap();
        let archive_sha256 = super::sha256_file_hex(&archive_path).unwrap();
        std::fs::write(
            &marker_path,
            format!(
                "asset=kino_0.1.24_linux_amd64.tar.gz\nsha256={archive_sha256}\nbinary_sha256={binary_sha256}\n"
            ),
        )
        .unwrap();

        assert!(
            cached_release_is_verified(
                &binary_path,
                &archive_path,
                &marker_path,
                "kino_0.1.24_linux_amd64.tar.gz"
            )
            .unwrap()
        );
        assert!(
            !cached_release_is_verified(
                &binary_path,
                &archive_path,
                &marker_path,
                "kino_0.1.24_linux_arm64.tar.gz"
            )
            .unwrap()
        );

        std::fs::write(&binary_path, "tampered").unwrap();
        assert!(
            !cached_release_is_verified(
                &binary_path,
                &archive_path,
                &marker_path,
                "kino_0.1.24_linux_amd64.tar.gz"
            )
            .unwrap()
        );

        std::fs::write(&binary_path, "kino").unwrap();
        std::fs::write(&archive_path, "tampered").unwrap();
        assert!(
            !cached_release_is_verified(
                &binary_path,
                &archive_path,
                &marker_path,
                "kino_0.1.24_linux_amd64.tar.gz"
            )
            .unwrap()
        );
    }
}
