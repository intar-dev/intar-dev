#![allow(clippy::missing_errors_doc)]

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use intar_contracts::catalog::ImageArchitecture;
use intar_image_build::{LayeredBuildConfig, QemuBuildConfig};
use serde::Deserialize;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct BuilderConfig {
    pub bridge: BridgeConfig,
    pub builder: BuilderRuntimeConfig,
    pub qemu: QemuConfig,
    pub jobs: JobConfig,
}

impl BuilderConfig {
    #[must_use]
    pub fn qemu_build_config(&self) -> QemuBuildConfig {
        let mut layered = self.qemu.layered.clone();
        layered
            .oci_cache_root
            .get_or_insert_with(|| self.builder.cache_root.join("oci"));
        layered
            .checkpoint_cache_root
            .get_or_insert_with(|| self.builder.cache_root.join("checkpoints"));

        QemuBuildConfig {
            target_arch: builder_arch(crate::bridge::host_architecture()).to_string(),
            qemu_binary: PathBuf::from(&self.qemu.qemu_binary),
            mke2fs_binary: PathBuf::from(&self.qemu.mke2fs_binary),
            e2fsck_binary: PathBuf::from(&self.qemu.e2fsck_binary),
            resize2fs_binary: PathBuf::from(&self.qemu.resize2fs_binary),
            ssh_wait_timeout_seconds: self.qemu.ssh_wait_timeout_seconds,
            provision_timeout_seconds: self.qemu.provision_timeout_seconds,
            qemu_exit_timeout_seconds: self.qemu.qemu_exit_timeout_seconds,
            accelerator: self.qemu.accelerator.clone(),
            build_cpus: self.qemu.build_cpus,
            build_memory_mb: self.qemu.build_memory_mb,
            work_root: self.builder.work_root.clone(),
            output_root: self.builder.cache_root.join("outputs"),
            layered,
        }
    }
}

fn builder_arch(arch: ImageArchitecture) -> &'static str {
    match arch {
        ImageArchitecture::X86_64 => "amd64",
        ImageArchitecture::Aarch64 => "arm64",
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct BridgeConfig {
    pub enabled: bool,
    pub base_url: String,
    pub host_id: String,
    pub bootstrap_token: String,
    pub heartbeat_interval_seconds: u64,
}

impl Default for BridgeConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            base_url: String::new(),
            host_id: String::new(),
            bootstrap_token: String::new(),
            heartbeat_interval_seconds: 20,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct BuilderRuntimeConfig {
    pub work_root: PathBuf,
    pub cache_root: PathBuf,
    pub state_db: PathBuf,
}

impl Default for BuilderRuntimeConfig {
    fn default() -> Self {
        Self {
            work_root: PathBuf::from("/var/lib/intar-builder/work"),
            cache_root: PathBuf::from("/var/cache/intar-builder"),
            state_db: PathBuf::from("/var/lib/intar-builder/state.sqlite3"),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct QemuConfig {
    pub qemu_binary: String,
    pub mke2fs_binary: String,
    pub e2fsck_binary: String,
    pub resize2fs_binary: String,
    pub ssh_wait_timeout_seconds: u64,
    pub provision_timeout_seconds: u64,
    pub qemu_exit_timeout_seconds: u64,
    pub accelerator: String,
    pub build_cpus: u32,
    pub build_memory_mb: u32,
    pub layered: LayeredBuildConfig,
}

impl Default for QemuConfig {
    fn default() -> Self {
        Self {
            qemu_binary: "qemu-system-x86_64".to_string(),
            mke2fs_binary: "mke2fs".to_string(),
            e2fsck_binary: "e2fsck".to_string(),
            resize2fs_binary: "resize2fs".to_string(),
            ssh_wait_timeout_seconds: 20 * 60,
            provision_timeout_seconds: 40 * 60,
            qemu_exit_timeout_seconds: 5 * 60,
            accelerator: "kvm".to_string(),
            build_cpus: 4,
            build_memory_mb: 4096,
            layered: LayeredBuildConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct JobConfig {
    pub max_attempts: u32,
    pub max_concurrent_builds: u16,
}

impl Default for JobConfig {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            max_concurrent_builds: 2,
        }
    }
}

pub fn load(path: &Path) -> Result<BuilderConfig> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read builder config '{}'", path.display()))?;
    parse(&content)
}

pub fn parse(content: &str) -> Result<BuilderConfig> {
    toml::from_str(content).context("failed to parse builder config TOML")
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::path::PathBuf;

    use super::parse;

    #[test]
    fn parses_minimal_builder_config() {
        let config = parse(
            r#"
[bridge]
base_url = "https://intar.dev"
host_id = "builder-1"
bootstrap_token = "secret"

[builder]
work_root = "/tmp/intar-builder/work"
cache_root = "/tmp/intar-builder/cache"

[qemu]
qemu_binary = "/usr/bin/qemu-system-x86_64"
mke2fs_binary = "/usr/sbin/mke2fs"
e2fsck_binary = "/usr/sbin/e2fsck"
resize2fs_binary = "/usr/sbin/resize2fs"
ssh_wait_timeout_seconds = 120
provision_timeout_seconds = 240
qemu_exit_timeout_seconds = 30
accelerator = "kvm"
build_cpus = 6
build_memory_mb = 6144

[qemu.layered]
qemu_img_binary = "/usr/bin/qemu-img"
buildctl_binary = "/usr/local/bin/buildctl"
umoci_binary = "/usr/bin/umoci"
debian_image = "docker.io/library/debian@sha256:abc9cb88a5587630d7f915f47b23b0668fe250fbfc6457aa4d52b534c1bbf73f"
oci_cache_root = "/tmp/intar-builder/oci"
checkpoint_cache_root = "/tmp/intar-builder/checkpoints"
use_cache = false
oci_cache_bytes = 8589934592
checkpoint_cache_bytes = 42949672960
minimum_free_bytes = 21474836480
"#,
        )
        .unwrap();

        assert!(config.bridge.enabled);
        assert_eq!(config.bridge.host_id, "builder-1");
        assert_eq!(config.jobs.max_attempts, 3);
        assert_eq!(config.qemu.qemu_binary, "/usr/bin/qemu-system-x86_64");
        assert_eq!(config.qemu.ssh_wait_timeout_seconds, 120);
        assert_eq!(config.qemu.provision_timeout_seconds, 240);
        assert_eq!(config.qemu.qemu_exit_timeout_seconds, 30);
        assert_eq!(config.qemu.accelerator, "kvm");
        assert_eq!(config.qemu.build_memory_mb, 6144);
        assert!(!config.qemu.layered.use_cache);
        assert_eq!(
            config.qemu.layered.checkpoint_cache_root,
            Some(PathBuf::from("/tmp/intar-builder/checkpoints"))
        );

        let build_config = config.qemu_build_config();
        assert_eq!(
            build_config.qemu_binary,
            PathBuf::from("/usr/bin/qemu-system-x86_64")
        );
        assert_eq!(build_config.build_cpus, 6);
        assert_eq!(
            build_config.layered.oci_cache_root,
            Some(PathBuf::from("/tmp/intar-builder/oci"))
        );
        assert!(!build_config.layered.use_cache);
        assert_eq!(
            build_config.output_root,
            PathBuf::from("/tmp/intar-builder/cache/outputs")
        );
    }

    #[test]
    fn rejects_unknown_config_fields() {
        let error = parse(
            r#"
[bridge]
base_url = "https://intar.dev"
host_id = "builder-1"
bootstrap_token = "secret"
unknown = true
"#,
        )
        .unwrap_err();

        assert!(format!("{error:#}").contains("unknown field"));
    }

    #[test]
    fn rejects_removed_qemu_config_fields() {
        for field in [
            "backend = \"legacy\"",
            "mmdebstrap_binary = \"mmdebstrap\"",
            "qemuargs = []",
            "base_cache_root = \"/var/cache/intar-builder/base\"",
        ] {
            let error = parse(&format!("[qemu]\n{field}\n")).unwrap_err();
            assert!(format!("{error:#}").contains("unknown field"), "{field}");
        }
    }

    #[test]
    fn parses_deploy_example_config() {
        let config = parse(include_str!("../deploy/config.example.toml")).unwrap();

        assert!(config.bridge.enabled);
        assert_eq!(config.bridge.base_url, "https://intar.dev");
        assert_eq!(config.bridge.host_id, "");
        assert_eq!(
            config.builder.work_root,
            PathBuf::from("/var/lib/intar-builder/work")
        );
        assert_eq!(
            config.builder.cache_root,
            PathBuf::from("/var/cache/intar-builder")
        );
        assert_eq!(
            config.builder.state_db,
            PathBuf::from("/var/lib/intar-builder/state.sqlite3")
        );
        assert_eq!(config.qemu.accelerator, "kvm");
        let build_config = config.qemu_build_config();
        assert_eq!(
            build_config.layered.oci_cache_root,
            Some(PathBuf::from("/var/cache/intar-builder/oci"))
        );
        assert_eq!(
            build_config.layered.checkpoint_cache_root,
            Some(PathBuf::from("/var/cache/intar-builder/checkpoints"))
        );
        assert_eq!(config.jobs.max_concurrent_builds, 2);
    }
}
