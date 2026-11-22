use serde::Deserialize;
use std::path::PathBuf;

/// The architecture of the machines an image is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuildArch {
    Amd64,
    Arm64,
}

impl BuildArch {
    /// Debian's name, which the build's `target_arch` and BuildKit's platform use.
    #[must_use]
    pub fn debian(self) -> &'static str {
        match self {
            Self::Amd64 => "amd64",
            Self::Arm64 => "arm64",
        }
    }

    /// The architecture this builder itself runs on, if images exist for it.
    #[must_use]
    pub fn host() -> Option<Self> {
        Self::parse(std::env::consts::ARCH)
    }

    #[must_use]
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "amd64" | "x86_64" => Some(Self::Amd64),
            "arm64" | "aarch64" => Some(Self::Arm64),
            _ => None,
        }
    }

    /// The guest's serial console, as its kernel names it.
    #[must_use]
    pub fn console(self) -> &'static str {
        match self {
            Self::Amd64 => "ttyS0",
            Self::Arm64 => "ttyAMA0",
        }
    }

    #[must_use]
    pub fn qemu_binary(self) -> &'static str {
        match self {
            Self::Amd64 => "qemu-system-x86_64",
            Self::Arm64 => "qemu-system-aarch64",
        }
    }
}

/// A foreign architecture is emulated instruction by instruction; a build
/// then gets this many times the time a native one has.
const EMULATION_TIME_FACTOR: u64 = 6;

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

impl QemuBuildConfig {
    /// The architecture this configuration builds for. An unknown name is
    /// refused where the build starts; here it reads as amd64.
    #[must_use]
    pub fn arch(&self) -> BuildArch {
        BuildArch::parse(&self.target_arch).unwrap_or(BuildArch::Amd64)
    }

    /// The Debian image the base starts from, for this configuration's architecture.
    #[must_use]
    pub fn debian_image(&self) -> &str {
        match self.arch() {
            BuildArch::Amd64 => &self.layered.debian_image,
            BuildArch::Arm64 => &self.layered.debian_image_arm64,
        }
    }

    /// This configuration for another architecture, on the same host: the
    /// same tools and directories, that architecture's QEMU beside this one,
    /// and, when it is not the host's own, emulation with more time.
    #[must_use]
    pub fn for_arch(&self, arch: BuildArch) -> Self {
        if arch == self.arch() {
            return self.clone();
        }
        let mut other = self.clone();
        arch.debian().clone_into(&mut other.target_arch);
        other.qemu_binary = self.qemu_binary.with_file_name(arch.qemu_binary());
        if BuildArch::host() != Some(arch) {
            "tcg".clone_into(&mut other.accelerator);
            other.provision_timeout_seconds *= EMULATION_TIME_FACTOR;
            other.qemu_exit_timeout_seconds *= EMULATION_TIME_FACTOR;
        }
        other
    }
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
    /// The same Debian release for arm64.
    #[serde(default = "default_debian_image_arm64")]
    pub debian_image_arm64: String,
    #[serde(default)]
    pub oci_cache_root: Option<PathBuf>,
    #[serde(default)]
    pub checkpoint_cache_root: Option<PathBuf>,
    /// Where a cluster build keeps its pinned Talos and Kubernetes downloads
    /// across builds; `work_root/talos-cache` when unset.
    #[serde(default)]
    pub talos_cache_root: Option<PathBuf>,
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
            debian_image_arm64: default_debian_image_arm64(),
            oci_cache_root: None,
            checkpoint_cache_root: None,
            talos_cache_root: None,
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

// Both are `debian:trixie-20261104-slim`, each by its own platform's manifest:
// BuildKit would take an index digest for either platform, but a manifest
// digest cannot resolve to the wrong one.
fn default_debian_image() -> String {
    String::from(DEBIAN_IMAGE_AMD64)
}

fn default_debian_image_arm64() -> String {
    String::from(DEBIAN_IMAGE_ARM64)
}

const DEBIAN_IMAGE_AMD64: &str = "docker.io/library/debian@sha256:7378260c0a098d27ac206225db5e7d92b8c7c84ea7afccc86eeb513756bbd392";
const DEBIAN_IMAGE_ARM64: &str = "docker.io/library/debian@sha256:24a01011d10eba3a023bc8585b9650b8b29021240d4217c05b905e09ef4a5232";

impl BuildArch {
    /// The pinned Debian image of this architecture: what a base is built
    /// from unless a builder's configuration names another, and what the
    /// kernel is always compiled in.
    #[must_use]
    pub fn pinned_debian_image(self) -> &'static str {
        match self {
            Self::Amd64 => DEBIAN_IMAGE_AMD64,
            Self::Arm64 => DEBIAN_IMAGE_ARM64,
        }
    }
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
