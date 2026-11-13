//! Machine and repository-image builds of image format 3 from a
//! `SourceBundleV2` (#311 §6): plan, build VM, OCI output.

mod host;
mod output;
pub(crate) mod plan;
mod qmp;
mod script;
mod shutdown;
mod vm;
mod wake;

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Result, bail, ensure};
use intar_contracts::oci::OciDigest;
use intar_contracts::source::SourceBundleV2;

use crate::config::QemuBuildConfig;
use crate::platform::ensure_platform_base;

pub use output::{
    MachineImage, VerifiedMachineImage, reconstruct_machine_disk, verify_machine_image,
    write_machine_image,
};
pub use plan::{BuildPlan, BuildTarget, PlannedNode, PlannedStage, WakeRole, plan_build};
pub use wake::{WAKE_CHILD_ARG, run_wake_child, wake_unavailable};

/// One build: a target of a bundle, the key the caller expects, and where
/// the image goes.
#[derive(Clone, Debug)]
pub struct MachineBuildRequest {
    pub bundle: SourceBundleV2,
    pub target: BuildTarget,
    /// Refuse when the bundle builds another key.
    pub expected_key: Option<OciDigest>,
    pub config: QemuBuildConfig,
    /// `sha256/<hex>` blobs land here.
    pub output_dir: PathBuf,
}

/// A built image and where its build log is.
#[derive(Clone, Debug)]
pub struct MachineBuildOutput {
    pub plan: BuildPlan,
    pub image: MachineImage,
    pub log_path: PathBuf,
    pub base_seconds: f64,
    pub build_seconds: f64,
    pub output_seconds: f64,
}

/// The build log of `build_key` under `work_root`; the serial console goes
/// beside it as `<log>.serial.log`.
#[must_use]
pub fn machine_build_log_path(work_root: &Path, build_key: &OciDigest) -> PathBuf {
    work_root.join(format!("machine-{}.build.log", build_key.hex()))
}

/// Plan, build and write one image.
///
/// # Errors
/// Returns an error when the plan is refused or any build step fails.
pub fn build_machine_image(request: &MachineBuildRequest) -> Result<MachineBuildOutput> {
    let plan = plan_build(
        &request.bundle,
        &request.target,
        request.expected_key.as_ref(),
    )?;
    ensure!(
        cfg!(target_os = "linux") && request.config.accelerator == "kvm",
        "machine builds need Linux and KVM"
    );
    let started = Instant::now();
    let base = ensure_platform_base(&request.config)?;
    let base_seconds = started.elapsed().as_secs_f64();
    let work_root = &request.config.work_root;
    fs::create_dir_all(work_root)?;
    let log_path = machine_build_log_path(work_root, &plan.build_key);
    let work = tempfile::Builder::new()
        .prefix("machine-")
        .tempdir_in(work_root)?;
    let started = Instant::now();
    fs::create_dir_all(&request.output_dir)?;
    if plan.wake.is_some() && builds_wake(&request.config, &log_path)? {
        let image = wake::build_wake_target(request, &plan, &base, work.path(), &log_path)?;
        return Ok(MachineBuildOutput {
            plan,
            image,
            log_path,
            base_seconds,
            build_seconds: started.elapsed().as_secs_f64(),
            output_seconds: 0.0,
        });
    }
    let raw = vm::build_disk(&plan, &request.config, &base, work.path(), &log_path)?;
    let build_seconds = started.elapsed().as_secs_f64();
    let started = Instant::now();
    let image = write_machine_image(
        &raw,
        &base.kernel_path,
        &base.initrd_path,
        &plan.build_key,
        &request.output_dir,
    )?;
    Ok(MachineBuildOutput {
        plan,
        image,
        log_path,
        base_seconds,
        build_seconds,
        output_seconds: started.elapsed().as_secs_f64(),
    })
}

/// Whether a wake target builds as one. Wake off is the operator's choice:
/// a plain image, and its log says so. Wake on but unusable fails the build
/// rather than publish a plain image under the wake key.
fn builds_wake(config: &QemuBuildConfig, log: &Path) -> Result<bool> {
    use std::io::Write as _;
    if config.wake.is_none() {
        let mut file = fs::OpenOptions::new().create(true).append(true).open(log)?;
        writeln!(
            file,
            "[wake] off on this builder; building this wake target as a plain image"
        )?;
        return Ok(false);
    }
    if let Some(reason) = wake::wake_unavailable(config) {
        bail!("this builder cannot build wake images: {reason}");
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::WakeBuildConfig;

    #[test]
    fn wake_off_builds_plain_and_broken_wake_fails() {
        let dir = tempfile::tempdir().expect("dir");
        let log = dir.path().join("build.log");
        let mut config = QemuBuildConfig::default();
        assert!(!builds_wake(&config, &log).expect("off"));
        assert!(
            fs::read_to_string(&log)
                .expect("log")
                .contains("plain image")
        );

        config.wake = Some(WakeBuildConfig {
            vmm_binary: dir.path().join("missing-vmm"),
            vmm_sha256: "00".to_owned(),
            vmm_version: "v55.0.0".to_owned(),
            cpu_profile: dir.path().join("profile.json"),
            kino: dir.path().join("kino"),
            base_cache: dir.path().join("bases"),
        });
        let error = builds_wake(&config, &log).expect_err("broken wake");
        assert!(
            error.to_string().contains("cannot build wake images"),
            "{error}"
        );
    }
}
