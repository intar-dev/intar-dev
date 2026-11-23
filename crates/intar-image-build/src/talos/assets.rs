//! What a cluster bake downloads, pinned by digest per supported release:
//! Talos' kernel, initramfs and metal disk for the target architecture,
//! `talosctl` and `kubectl` for the builder host and for the management
//! machine. Changing a pin changes what is baked, so it goes with a bump of
//! `CLUSTER_BAKE_REVISION`.

use std::fs;
use std::io::{self, Read as _, Write as _};
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result, bail, ensure};

use crate::config::BuildArch;
use crate::sha256::sha256_file_hex;

const TALOS_RELEASE_URL: &str = "https://github.com/siderolabs/talos/releases/download";
const KUBERNETES_RELEASE_URL: &str = "https://dl.k8s.io/release";

/// `(talos, file, sha256)` of the Talos release assets, from its
/// `sha256sum.txt`.
const TALOS_FILES: &[(&str, &str, &str)] = &[
    (
        "v1.15.0-beta.0",
        "vmlinuz-amd64",
        "83fff3595e082abc40f7839e067d5bec7157c0bfe0ef5d256f0728e1404c1665",
    ),
    (
        "v1.15.0-beta.0",
        "vmlinuz-arm64",
        "0876970ef4a274bfea572ac7e13508caf772d88c95e551c00fd7ca18f7c23915",
    ),
    (
        "v1.15.0-beta.0",
        "initramfs-amd64.xz",
        "3702bfb39a5c8dd2ea152868ea1204eed8e01d322bed772855f6f55ca8a18627",
    ),
    (
        "v1.15.0-beta.0",
        "initramfs-arm64.xz",
        "247ec615ec521d1d77d4bc27f0512b208bfc9068dcf1ecf7ade45f24eb78f119",
    ),
    (
        "v1.15.0-beta.0",
        "metal-amd64.raw.zst",
        "72b5f01901906c0f3eeb511d925f1a39e18c414ce912a46210fb124047d63807",
    ),
    (
        "v1.15.0-beta.0",
        "metal-arm64.raw.zst",
        "683a1378a466893bebac3775d185a19f8831270cec2b7d3b7e01219ceee4bc21",
    ),
    (
        "v1.15.0-beta.0",
        "talosctl-linux-amd64",
        "cc4f2483dc3a137840690aa925460ef3a45eeffbb9292675b4f417d7489cbe64",
    ),
    (
        "v1.15.0-beta.0",
        "talosctl-linux-arm64",
        "f7595189b1ce7fa2a0b1c6dc0bb0bdd33a9c7d3be69dad8805ddf05852143e07",
    ),
];

/// `(talos, sha256)` of the arm64 kernel unpacked from its EFI zboot
/// wrapper, which QEMU's direct boot cannot load.
const ARM64_IMAGES: &[(&str, &str)] = &[(
    "v1.15.0-beta.0",
    "e75b1082f489d0009d3314afbf276bc6576461df810eef1e05dd6909e07df518",
)];

/// `(kubernetes, arch, sha256)` of `kubectl`, from dl.k8s.io.
const KUBECTL_FILES: &[(&str, &str, &str)] = &[
    (
        "v1.37.1",
        "amd64",
        "65691ff77eb6fa44c908b77a1082c9f092c3b9733b5cefabec0d1104890e21a8",
    ),
    (
        "v1.37.1",
        "arm64",
        "ff749f4b78d9c4f1ec87307df9b50119ed819e2094aa9810cb9acffc3286c8c7",
    ),
];

/// One release's files for one target architecture, in the cache.
#[derive(Clone, Debug)]
pub(crate) struct ReleaseFiles {
    /// The kernel QEMU boots: `vmlinuz` on amd64, the unpacked `Image` on arm64.
    pub kernel: PathBuf,
    pub initramfs: PathBuf,
    /// The zstd-compressed preinstalled metal disk.
    pub disk_zst: PathBuf,
    pub host_talosctl: PathBuf,
    pub host_kubectl: PathBuf,
    pub target_talosctl: PathBuf,
    pub target_kubectl: PathBuf,
}

fn talos_sha(talos: &str, file: &str) -> Result<&'static str> {
    TALOS_FILES
        .iter()
        .find(|(version, name, _)| *version == talos && *name == file)
        .map(|(_, _, sha)| *sha)
        .with_context(|| format!("no pin for Talos {talos} {file}"))
}

fn kubectl_sha(kubernetes: &str, arch: BuildArch) -> Result<&'static str> {
    KUBECTL_FILES
        .iter()
        .find(|(version, name, _)| *version == kubernetes && *name == arch.debian())
        .map(|(_, _, sha)| *sha)
        .with_context(|| format!("no pin for kubectl {kubernetes} {}", arch.debian()))
}

/// Every file of `(talos, kubernetes)` for `target`, downloaded into
/// `cache` once and verified on every use.
///
/// # Errors
/// Returns an error for an unpinned release, a failed download or a digest
/// that differs from its pin.
pub(crate) fn release_files(
    cache: &Path,
    talos: &str,
    kubernetes: &str,
    target: BuildArch,
    host: BuildArch,
) -> Result<ReleaseFiles> {
    let dir = cache.join(talos);
    fs::create_dir_all(&dir)?;
    let talos_file = |name: String| -> Result<PathBuf> {
        let sha = talos_sha(talos, &name)?;
        fetch(
            &dir.join(&name),
            &format!("{TALOS_RELEASE_URL}/{talos}/{name}"),
            sha,
        )
    };
    let kubectl = |arch: BuildArch| -> Result<PathBuf> {
        let sha = kubectl_sha(kubernetes, arch)?;
        let url = format!(
            "{KUBERNETES_RELEASE_URL}/{kubernetes}/bin/linux/{}/kubectl",
            arch.debian()
        );
        fetch(
            &dir.join(format!("kubectl-{kubernetes}-{}", arch.debian())),
            &url,
            sha,
        )
    };
    let arch = target.debian();
    let vmlinuz = talos_file(format!("vmlinuz-{arch}"))?;
    let kernel = match target {
        BuildArch::Amd64 => vmlinuz,
        BuildArch::Arm64 => {
            let sha = ARM64_IMAGES
                .iter()
                .find(|(version, _)| *version == talos)
                .map(|(_, sha)| *sha)
                .with_context(|| format!("no pin for the unpacked arm64 kernel of {talos}"))?;
            unpacked_zboot(&vmlinuz, &dir.join("Image-arm64"), sha)?
        }
    };
    let files = ReleaseFiles {
        kernel,
        initramfs: talos_file(format!("initramfs-{arch}.xz"))?,
        disk_zst: talos_file(format!("metal-{arch}.raw.zst"))?,
        host_talosctl: talos_file(format!("talosctl-linux-{}", host.debian()))?,
        host_kubectl: kubectl(host)?,
        target_talosctl: talos_file(format!("talosctl-linux-{arch}"))?,
        target_kubectl: kubectl(target)?,
    };
    for tool in [&files.host_talosctl, &files.host_kubectl] {
        make_executable(tool)?;
    }
    Ok(files)
}

fn make_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    Ok(())
}

/// `path` when it holds `sha256`; otherwise `url` downloaded beside it,
/// checked and renamed into place.
fn fetch(path: &Path, url: &str, sha256: &str) -> Result<PathBuf> {
    if path.exists() && sha256_file_hex(path)? == sha256 {
        return Ok(path.to_owned());
    }
    let dir = path.parent().context("cache file has a directory")?;
    let mut partial = tempfile::NamedTempFile::new_in(dir)?;
    let mut response = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30 * 60))
        .build()?
        .get(url)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .with_context(|| format!("failed to download {url}"))?;
    io::copy(&mut response, partial.as_file_mut())
        .with_context(|| format!("failed to download {url}"))?;
    partial.as_file_mut().flush()?;
    let found = sha256_file_hex(partial.path())?;
    ensure!(
        found == sha256,
        "{url} has sha256 {found}, not the pinned {sha256}"
    );
    partial.persist(path)?;
    Ok(path.to_owned())
}

/// The raw kernel inside an EFI zboot image (`MZ`, `zimg` at 4, payload
/// offset and size little-endian at 8 and 12, compression name at 24), which
/// must hash to `sha256`.
fn unpacked_zboot(zboot: &Path, path: &Path, sha256: &str) -> Result<PathBuf> {
    if path.exists() && sha256_file_hex(path)? == sha256 {
        return Ok(path.to_owned());
    }
    let bytes = fs::read(zboot)?;
    let field = |at: usize| -> Result<usize> {
        let word = bytes.get(at..at + 4).context("zboot header is short")?;
        Ok(u32::from_le_bytes(word.try_into()?) as usize)
    };
    if bytes.get(4..8) != Some(b"zimg") {
        bail!("{} is not an EFI zboot image", zboot.display());
    }
    let compression = bytes.get(24..28).context("zboot header is short")?;
    ensure!(
        compression == b"zstd",
        "{} is not zstd-compressed",
        zboot.display()
    );
    let (offset, size) = (field(8)?, field(12)?);
    let payload = bytes
        .get(offset..offset + size)
        .context("zboot payload is outside the file")?;
    let dir = path.parent().context("cache file has a directory")?;
    let mut partial = tempfile::NamedTempFile::new_in(dir)?;
    let mut decoder = zstd::stream::read::Decoder::new(payload)?;
    let mut image = Vec::new();
    decoder.read_to_end(&mut image)?;
    partial.write_all(&image)?;
    let found = sha256_file_hex(partial.path())?;
    ensure!(
        found == sha256,
        "the unpacked arm64 kernel has sha256 {found}, not the pinned {sha256}"
    );
    partial.persist(path)?;
    Ok(path.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use intar_contracts::scenario::TALOS_RELEASES;

    #[test]
    fn every_supported_release_is_pinned_for_both_architectures() {
        for (talos, kubernetes) in TALOS_RELEASES {
            for arch in [BuildArch::Amd64, BuildArch::Arm64] {
                let a = arch.debian();
                for file in [
                    format!("vmlinuz-{a}"),
                    format!("initramfs-{a}.xz"),
                    format!("metal-{a}.raw.zst"),
                    format!("talosctl-linux-{a}"),
                ] {
                    assert!(talos_sha(talos, &file).is_ok(), "{talos} {file}");
                }
                assert!(kubectl_sha(kubernetes, arch).is_ok(), "{kubernetes} {a}");
            }
            assert!(ARM64_IMAGES.iter().any(|(version, _)| version == talos));
        }
    }

    #[test]
    fn a_zboot_payload_is_unpacked_and_checked() {
        let dir = tempfile::tempdir().expect("tempdir");
        let kernel = b"raw arm64 kernel".to_vec();
        let payload = zstd::encode_all(&kernel[..], 3).expect("zstd");
        let mut zboot = vec![0u8; 64];
        zboot[..2].copy_from_slice(b"MZ");
        zboot[4..8].copy_from_slice(b"zimg");
        zboot[8..12].copy_from_slice(&64u32.to_le_bytes());
        zboot[12..16].copy_from_slice(&u32::try_from(payload.len()).expect("len").to_le_bytes());
        zboot[24..28].copy_from_slice(b"zstd");
        zboot.extend_from_slice(&payload);
        let wrapped = dir.path().join("vmlinuz");
        fs::write(&wrapped, &zboot).expect("write");
        let sha = crate::sha256::sha256_bytes_hex(&kernel);
        let out = unpacked_zboot(&wrapped, &dir.path().join("Image"), &sha).expect("unpacks");
        assert_eq!(fs::read(out).expect("read"), kernel);
        assert!(unpacked_zboot(&wrapped, &dir.path().join("Other"), &"0".repeat(64)).is_err());
    }
}
