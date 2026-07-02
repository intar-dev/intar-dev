#![forbid(unsafe_code)]

use std::path::Path;

use anyhow::{Context as _, Result};
use serde::Deserialize;
use tokio::process::Command;

#[derive(Debug, Deserialize)]
struct QemuImgInfo {
    format: Option<String>,
    #[serde(rename = "virtual-size")]
    virtual_size: Option<u64>,
}

pub async fn detect_format(qemu_img: &str, path: &Path) -> Result<String> {
    let out = Command::new(qemu_img)
        .arg("info")
        .arg("--output=json")
        .arg(path)
        .output()
        .await
        .with_context(|| format!("failed to execute {qemu_img} info"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        anyhow::bail!("{qemu_img} info failed: {stderr}");
    }

    let info = serde_json::from_slice::<QemuImgInfo>(&out.stdout)
        .context("failed to parse qemu-img info JSON")?;
    let fmt = info
        .format
        .ok_or_else(|| anyhow::anyhow!("qemu-img info did not include format field"))?;
    Ok(fmt)
}

pub async fn virtual_size_bytes(qemu_img: &str, path: &Path) -> Result<u64> {
    let out = Command::new(qemu_img)
        .arg("info")
        .arg("--output=json")
        .arg(path)
        .output()
        .await
        .with_context(|| format!("failed to execute {qemu_img} info"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        anyhow::bail!("{qemu_img} info failed: {stderr}");
    }

    let info = serde_json::from_slice::<QemuImgInfo>(&out.stdout)
        .context("failed to parse qemu-img info JSON")?;
    info.virtual_size
        .ok_or_else(|| anyhow::anyhow!("qemu-img info did not include virtual-size field"))
}

pub async fn convert_to_raw(
    qemu_img: &str,
    src_path: &Path,
    src_format: &str,
    dest_path: &Path,
) -> Result<()> {
    let out = Command::new(qemu_img)
        .arg("convert")
        // Our VM host root filesystem is tiny; always write sparse raw disks.
        // This keeps the per-VM root disk close to the image's allocated blocks
        // rather than the full virtual size.
        .arg("-S")
        .arg("4k")
        .arg("-f")
        .arg(src_format)
        .arg("-O")
        .arg("raw")
        .arg(src_path)
        .arg(dest_path)
        .output()
        .await
        .with_context(|| format!("failed to execute {qemu_img} convert"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        anyhow::bail!("{qemu_img} convert failed: {stderr}");
    }

    Ok(())
}

pub async fn resize(qemu_img: &str, path: &Path, bytes: u64) -> Result<()> {
    let out = Command::new(qemu_img)
        .arg("resize")
        .arg(path)
        .arg(bytes.to_string())
        .output()
        .await
        .with_context(|| format!("failed to execute {qemu_img} resize"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        anyhow::bail!("{qemu_img} resize failed: {stderr}");
    }

    Ok(())
}
