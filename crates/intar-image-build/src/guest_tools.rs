use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context as _, Result, bail};
use intar_contracts::catalog::GUEST_BOOTSTRAP_ABI_V1;
use serde::{Deserialize, Serialize};

use crate::artifact::sha256_file_hex;

pub const GUEST_TOOLS_DISK_SIZE_BYTES: u64 = 64 * 1024 * 1024;
pub const GUEST_TOOLS_DISK_LABEL: &str = "INTARTOOLS";

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct GuestToolsDiskManifestV1 {
    pub schema_version: u8,
    pub bootstrap_abi: u16,
    pub kino_sha256: String,
    pub kino_size_bytes: u64,
}

#[derive(Clone, Debug)]
pub struct GuestToolsDiskArtifact {
    pub disk_path: PathBuf,
    pub compressed_disk_path: PathBuf,
    pub disk_sha256: String,
    pub compressed_disk_sha256: String,
    pub disk_size_bytes: u64,
    pub compressed_disk_size_bytes: u64,
    pub kino_sha256: String,
    pub kino_size_bytes: u64,
    pub manifest: GuestToolsDiskManifestV1,
}

/// Build the fixed-size read-only guest-tools ext4 image.
///
/// The filesystem UUID and fake creation time are derived from immutable
/// inputs. This makes repeated builds byte-stable with the pinned e2fsprogs
/// toolchain used by CI.
pub fn write_guest_tools_disk(
    kino_path: &Path,
    output_root: &Path,
    mke2fs_binary: &Path,
) -> Result<GuestToolsDiskArtifact> {
    let kino_metadata = fs::symlink_metadata(kino_path)
        .with_context(|| format!("failed to stat Kino binary '{}'", kino_path.display()))?;
    if !kino_metadata.is_file() || kino_metadata.len() == 0 {
        bail!(
            "Kino binary '{}' is not a non-empty file",
            kino_path.display()
        );
    }
    let kino_sha256 = sha256_file_hex(kino_path)?;
    let manifest = GuestToolsDiskManifestV1 {
        schema_version: 1,
        bootstrap_abi: GUEST_BOOTSTRAP_ABI_V1,
        kino_sha256: kino_sha256.clone(),
        kino_size_bytes: kino_metadata.len(),
    };

    fs::create_dir_all(output_root).with_context(|| {
        format!(
            "failed to create guest-tools output '{}'",
            output_root.display()
        )
    })?;
    let staging = tempfile::tempdir_in(output_root).with_context(|| {
        format!(
            "failed to create guest-tools staging directory in '{}'",
            output_root.display()
        )
    })?;
    let filesystem_root = staging.path().join("root");
    fs::create_dir_all(filesystem_root.join("bin"))?;
    let staged_kino = filesystem_root.join("bin/kino");
    fs::copy(kino_path, &staged_kino).with_context(|| {
        format!(
            "failed to stage Kino '{}' as '{}'",
            kino_path.display(),
            staged_kino.display()
        )
    })?;
    set_read_only_executable(&staged_kino)?;
    let manifest_bytes = serde_json::to_vec(&manifest).context("serialize tools manifest")?;
    fs::write(filesystem_root.join("manifest.json"), &manifest_bytes)?;
    set_read_only_file(&filesystem_root.join("manifest.json"))?;

    let staged_disk = staging.path().join("tools.ext4");
    let disk = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&staged_disk)?;
    disk.set_len(GUEST_TOOLS_DISK_SIZE_BYTES)?;
    disk.sync_all()?;
    drop(disk);

    let filesystem_uuid = filesystem_uuid(&kino_sha256);
    let extended_options =
        format!("lazy_itable_init=0,lazy_journal_init=0,hash_seed={filesystem_uuid}");
    let status = Command::new(mke2fs_binary)
        .args([
            "-F",
            "-q",
            "-t",
            "ext4",
            "-b",
            "4096",
            "-L",
            GUEST_TOOLS_DISK_LABEL,
            "-U",
            &filesystem_uuid,
            "-E",
            &extended_options,
            "-d",
        ])
        .arg(&filesystem_root)
        .arg(&staged_disk)
        .env("E2FSPROGS_FAKE_TIME", "1")
        .env("SOURCE_DATE_EPOCH", "1")
        .env("TZ", "UTC")
        .env("LC_ALL", "C")
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .status()
        .with_context(|| format!("failed to execute '{}'", mke2fs_binary.display()))?;
    if !status.success() {
        bail!("mke2fs guest-tools disk failed with status {status}");
    }
    if fs::metadata(&staged_disk)?.len() != GUEST_TOOLS_DISK_SIZE_BYTES {
        bail!("guest-tools disk has an unexpected size");
    }

    let disk_sha256 = sha256_file_hex(&staged_disk)?;
    let disk_path = output_root.join(format!("{disk_sha256}.ext4"));
    publish_immutable_file(&staged_disk, &disk_path)?;

    let staged_compressed = staging.path().join("tools.ext4.zst");
    compress_disk(&disk_path, &staged_compressed)?;
    let compressed_disk_sha256 = sha256_file_hex(&staged_compressed)?;
    let compressed_disk_path = output_root.join(format!("{disk_sha256}.ext4.zst"));
    publish_immutable_file(&staged_compressed, &compressed_disk_path)?;
    let compressed_disk_size_bytes = fs::metadata(&compressed_disk_path)?.len();

    Ok(GuestToolsDiskArtifact {
        disk_path,
        compressed_disk_path,
        disk_sha256,
        compressed_disk_sha256,
        disk_size_bytes: GUEST_TOOLS_DISK_SIZE_BYTES,
        compressed_disk_size_bytes,
        kino_sha256,
        kino_size_bytes: kino_metadata.len(),
        manifest,
    })
}

fn compress_disk(source: &Path, destination: &Path) -> Result<()> {
    let mut input = fs::File::open(source)?;
    let output = fs::File::create(destination)?;
    let mut encoder = zstd::stream::Encoder::new(output, 6)?;
    encoder.include_checksum(true)?;
    encoder.include_contentsize(true)?;
    encoder.set_pledged_src_size(Some(GUEST_TOOLS_DISK_SIZE_BYTES))?;
    std::io::copy(&mut input, &mut encoder)?;
    let output = encoder.finish()?;
    output.sync_all()?;
    Ok(())
}

fn publish_immutable_file(source: &Path, destination: &Path) -> Result<()> {
    if destination.is_file() {
        if sha256_file_hex(source)? == sha256_file_hex(destination)? {
            return Ok(());
        }
        bail!(
            "immutable guest-tools artifact '{}' already exists with different bytes",
            destination.display()
        );
    }
    fs::rename(source, destination).with_context(|| {
        format!(
            "failed to publish guest-tools artifact '{}'",
            destination.display()
        )
    })
}

fn filesystem_uuid(kino_sha256: &str) -> String {
    format!(
        "{}-{}-{}-{}-{}",
        &kino_sha256[0..8],
        &kino_sha256[8..12],
        &kino_sha256[12..16],
        &kino_sha256[16..20],
        &kino_sha256[20..32],
    )
}

#[cfg(unix)]
fn set_read_only_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    fs::set_permissions(path, fs::Permissions::from_mode(0o555))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_read_only_executable(path: &Path) -> Result<()> {
    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_readonly(true);
    fs::set_permissions(path, permissions)?;
    Ok(())
}

fn set_read_only_file(path: &Path) -> Result<()> {
    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_readonly(true);
    fs::set_permissions(path, permissions)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_stable_uuid_from_kino_digest() {
        assert_eq!(
            filesystem_uuid(&"a".repeat(64)),
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        );
    }

    #[test]
    fn tools_manifest_is_canonical_and_pins_abi() {
        let manifest = GuestToolsDiskManifestV1 {
            schema_version: 1,
            bootstrap_abi: GUEST_BOOTSTRAP_ABI_V1,
            kino_sha256: "a".repeat(64),
            kino_size_bytes: 123,
        };
        assert_eq!(
            serde_json::to_string(&manifest).expect("serialize tools manifest"),
            format!(
                "{{\"schema_version\":1,\"bootstrap_abi\":1,\"kino_sha256\":\"{}\",\"kino_size_bytes\":123}}",
                "a".repeat(64)
            )
        );
    }
}
