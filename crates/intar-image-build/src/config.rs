use serde::Deserialize;
use std::path::PathBuf;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QemuBuildConfig {
    #[serde(default = "default_target_arch")]
    pub target_arch: String,
    #[serde(default = "default_qemu_binary")]
    pub qemu_binary: PathBuf,
    #[serde(default = "default_mke2fs_binary")]
    pub mke2fs_binary: PathBuf,
    #[serde(default = "default_e2fsck_binary")]
    pub e2fsck_binary: PathBuf,
    #[serde(default = "default_resize2fs_binary")]
    pub resize2fs_binary: PathBuf,
    #[serde(default = "default_provision_timeout_seconds")]
    pub provision_timeout_seconds: u64,
    #[serde(default = "default_qemu_exit_timeout_seconds")]
    pub qemu_exit_timeout_seconds: u64,
    #[serde(default = "default_accelerator")]
    pub accelerator: String,
    #[serde(default = "default_build_cpus")]
    pub build_cpus: u32,
    #[serde(default = "default_build_memory_mb")]
    pub build_memory_mb: u32,
    #[serde(default = "default_output_root")]
    pub output_root: PathBuf,
    #[serde(default = "default_work_root")]
    pub work_root: PathBuf,
    #[serde(default)]
    pub layered: LayeredBuildConfig,
}

impl Default for QemuBuildConfig {
    fn default() -> Self {
        Self {
            target_arch: default_target_arch(),
            qemu_binary: default_qemu_binary(),
            mke2fs_binary: default_mke2fs_binary(),
            e2fsck_binary: default_e2fsck_binary(),
            resize2fs_binary: default_resize2fs_binary(),
            provision_timeout_seconds: default_provision_timeout_seconds(),
            qemu_exit_timeout_seconds: default_qemu_exit_timeout_seconds(),
            accelerator: default_accelerator(),
            build_cpus: default_build_cpus(),
            build_memory_mb: default_build_memory_mb(),
            output_root: default_output_root(),
            work_root: default_work_root(),
            layered: LayeredBuildConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct LayeredBuildConfig {
    #[serde(default = "default_qemu_img_binary")]
    pub qemu_img_binary: PathBuf,
    #[serde(default = "default_buildctl_binary")]
    pub buildctl_binary: PathBuf,
    #[serde(default = "default_umoci_binary")]
    pub umoci_binary: PathBuf,
    #[serde(default = "default_debian_image")]
    pub debian_image: String,
    #[serde(default)]
    pub oci_cache_root: Option<PathBuf>,
    #[serde(default)]
    pub checkpoint_cache_root: Option<PathBuf>,
    #[serde(default = "default_layered_use_cache")]
    pub use_cache: bool,
    #[serde(default = "default_oci_cache_bytes")]
    pub oci_cache_bytes: u64,
    #[serde(default = "default_checkpoint_cache_bytes")]
    pub checkpoint_cache_bytes: u64,
    #[serde(default = "default_minimum_free_bytes")]
    pub minimum_free_bytes: u64,
    #[serde(default = "default_kernel_build_jobs")]
    pub kernel_build_jobs: u32,
}

impl Default for LayeredBuildConfig {
    fn default() -> Self {
        Self {
            qemu_img_binary: default_qemu_img_binary(),
            buildctl_binary: default_buildctl_binary(),
            umoci_binary: default_umoci_binary(),
            debian_image: default_debian_image(),
            oci_cache_root: None,
            checkpoint_cache_root: None,
            use_cache: default_layered_use_cache(),
            oci_cache_bytes: default_oci_cache_bytes(),
            checkpoint_cache_bytes: default_checkpoint_cache_bytes(),
            minimum_free_bytes: default_minimum_free_bytes(),
            kernel_build_jobs: default_kernel_build_jobs(),
        }
    }
}

fn default_target_arch() -> String {
    String::from("amd64")
}

fn default_qemu_binary() -> PathBuf {
    PathBuf::from("qemu-system-x86_64")
}

fn default_qemu_img_binary() -> PathBuf {
    PathBuf::from("qemu-img")
}

fn default_buildctl_binary() -> PathBuf {
    PathBuf::from("buildctl")
}

fn default_umoci_binary() -> PathBuf {
    PathBuf::from("umoci")
}

fn default_debian_image() -> String {
    String::from(
        "docker.io/library/debian@sha256:abc9cb88a5587630d7f915f47b23b0668fe250fbfc6457aa4d52b534c1bbf73f",
    )
}

fn default_mke2fs_binary() -> PathBuf {
    PathBuf::from("mke2fs")
}

fn default_e2fsck_binary() -> PathBuf {
    PathBuf::from("e2fsck")
}

fn default_resize2fs_binary() -> PathBuf {
    PathBuf::from("resize2fs")
}

fn default_provision_timeout_seconds() -> u64 {
    40 * 60
}

fn default_qemu_exit_timeout_seconds() -> u64 {
    5 * 60
}

fn default_accelerator() -> String {
    String::from("kvm")
}

fn default_output_root() -> PathBuf {
    PathBuf::from("dist")
}

fn default_work_root() -> PathBuf {
    PathBuf::from(".work")
}

fn default_build_cpus() -> u32 {
    4
}

fn default_build_memory_mb() -> u32 {
    4096
}

fn default_layered_use_cache() -> bool {
    true
}

fn default_oci_cache_bytes() -> u64 {
    8 * 1024 * 1024 * 1024
}

fn default_checkpoint_cache_bytes() -> u64 {
    40 * 1024 * 1024 * 1024
}

fn default_minimum_free_bytes() -> u64 {
    20 * 1024 * 1024 * 1024
}

/// Parallel jobs for the kernel compile inside the builder container.
///
/// The build runs in an isolated container next to a scenario build, so the
/// default stays low. Raise it on a dedicated builder host with spare cores.
fn default_kernel_build_jobs() -> u32 {
    4
}

#[cfg(test)]
mod tests {
    use super::QemuBuildConfig;

    #[test]
    fn defaults_to_oci_cache_settings() {
        let config = QemuBuildConfig::default();

        assert!(config.layered.use_cache);
        assert_eq!(config.layered.oci_cache_bytes, 8 * 1024 * 1024 * 1024);
        assert_eq!(
            config.layered.checkpoint_cache_bytes,
            40 * 1024 * 1024 * 1024
        );
        assert_eq!(config.layered.minimum_free_bytes, 20 * 1024 * 1024 * 1024);
    }
}
