//! Writes what `kernel.yml` needs to compile one architecture's kernel:
//!
//! ```text
//! kernel_inputs <amd64 | arm64> <dir>
//! ```
//!
//! The build script, the configuration profile and the initramfs init script
//! go into `<dir>`. Standard output is one JSON object naming the set, the
//! release tag, the file, the pinned Debian image to compile in, and the
//! checksum pinned for this set (null when the set is not the pinned one).

use std::path::Path;

use anyhow::{Context as _, Result, bail};
use intar_image_build::{
    BuildArch, KERNEL_ARTIFACT_JOBS, KERNEL_ARTIFACT_SET, KERNEL_INITRAMFS_INIT_SCRIPT,
    KERNEL_SOURCE_DATE_EPOCH, QemuBuildConfig, kernel_artifact_file_name, kernel_artifact_sha256,
    kernel_artifact_tag, kernel_config_fragment, kernel_release, kernel_set_id,
    render_kernel_build_script,
};

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [arch, dir] = args.as_slice() else {
        bail!("usage: kernel_inputs <amd64 | arm64> <dir>");
    };
    let arch =
        BuildArch::parse(arch).with_context(|| format!("no kernel is built for '{arch}'"))?;
    let mut config = QemuBuildConfig::default();
    arch.debian().clone_into(&mut config.target_arch);
    config.layered.kernel_build_jobs = KERNEL_ARTIFACT_JOBS;

    let dir = Path::new(dir);
    std::fs::create_dir_all(dir)?;
    std::fs::write(
        dir.join("intar-kernel-build.sh"),
        render_kernel_build_script(&config),
    )?;
    std::fs::write(
        dir.join("intar-kernel.config"),
        kernel_config_fragment(arch),
    )?;
    std::fs::write(
        dir.join("intar-initramfs-init.sh"),
        KERNEL_INITRAMFS_INIT_SCRIPT,
    )?;

    let set = kernel_set_id();
    let pinned = (set == KERNEL_ARTIFACT_SET).then(|| kernel_artifact_sha256(arch));
    println!(
        "{}",
        serde_json::json!({
            "arch": arch.debian(),
            "set": set,
            "tag": kernel_artifact_tag(&set),
            "file": kernel_artifact_file_name(arch),
            "debian_image": arch.pinned_debian_image(),
            "release": kernel_release(),
            "source_date_epoch": KERNEL_SOURCE_DATE_EPOCH,
            "pinned_sha256": pinned,
        })
    );
    Ok(())
}
