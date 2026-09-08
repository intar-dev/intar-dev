use serde::Deserialize;
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("failed to read config file '{path}': {source}")]
    ReadFile {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to parse config HCL: {0}")]
    Parse(String),
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct BuildConfig {
    #[serde(default)]
    pub qemu: QemuBuildConfig,
    #[serde(default)]
    pub upload: Option<RawUploadConfig>,
}

impl BuildConfig {
    /// Load the builder config from a local HCL file.
    ///
    /// # Errors
    /// Returns `ConfigError` when the file cannot be read or parsed.
    pub fn from_file(path: &Path) -> Result<Self, ConfigError> {
        let content = std::fs::read_to_string(path).map_err(|source| ConfigError::ReadFile {
            path: path.display().to_string(),
            source,
        })?;

        hcl::from_str(&content).map_err(|error| ConfigError::Parse(error.to_string()))
    }
}

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
    #[serde(default = "default_ssh_wait_timeout_seconds")]
    pub ssh_wait_timeout_seconds: u64,
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
            ssh_wait_timeout_seconds: default_ssh_wait_timeout_seconds(),
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
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawUploadConfig {
    #[serde(default = "default_upload_enabled")]
    pub enabled: bool,
    pub url: String,
    #[serde(default)]
    pub token: String,
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

fn default_ssh_wait_timeout_seconds() -> u64 {
    20 * 60
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

fn default_upload_enabled() -> bool {
    true
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

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::BuildConfig;

    #[test]
    fn parses_builder_config() {
        let parsed = hcl::from_str::<BuildConfig>(
            r#"
qemu {
  target_arch = "amd64"
  qemu_binary = "/usr/local/bin/qemu-system-x86_64"
  mke2fs_binary = "/usr/sbin/mke2fs"
  e2fsck_binary = "/usr/sbin/e2fsck"
  resize2fs_binary = "/usr/sbin/resize2fs"
  ssh_wait_timeout_seconds = 120
  provision_timeout_seconds = 240
  qemu_exit_timeout_seconds = 30
  accelerator = "kvm"
  build_cpus = 4
  build_memory_mb = 4096
  output_root = "dist"
  work_root = ".work"
  layered {
    qemu_img_binary = "/usr/bin/qemu-img"
    buildctl_binary = "/usr/local/bin/buildctl"
    umoci_binary = "/usr/bin/umoci"
    debian_image = "docker.io/library/debian@sha256:abc9cb88a5587630d7f915f47b23b0668fe250fbfc6457aa4d52b534c1bbf73f"
    oci_cache_root = ".cache/oci"
    checkpoint_cache_root = ".cache/checkpoints"
    use_cache = false
    oci_cache_bytes = 8589934592
    checkpoint_cache_bytes = 42949672960
    minimum_free_bytes = 21474836480
  }
}

upload {
  enabled = true
  url = "https://intar.dev/registry/v1/publish"
  token = "registry-publish-token"
}
"#,
        );

        match parsed {
            Ok(config) => {
                assert_eq!(config.qemu.accelerator, "kvm");
                assert_eq!(config.qemu.target_arch, "amd64");
                assert_eq!(config.qemu.ssh_wait_timeout_seconds, 120);
                assert_eq!(config.qemu.provision_timeout_seconds, 240);
                assert_eq!(config.qemu.qemu_exit_timeout_seconds, 30);
                assert_eq!(config.qemu.build_cpus, 4);
                assert_eq!(config.qemu.build_memory_mb, 4096);
                assert_eq!(
                    config.qemu.layered.qemu_img_binary,
                    PathBuf::from("/usr/bin/qemu-img")
                );
                assert_eq!(
                    config.qemu.layered.oci_cache_root,
                    Some(PathBuf::from(".cache/oci"))
                );
                assert!(!config.qemu.layered.use_cache);
                assert_eq!(config.qemu.layered.oci_cache_bytes, 8 * 1024 * 1024 * 1024);
                assert_eq!(
                    config.qemu.layered.checkpoint_cache_bytes,
                    40 * 1024 * 1024 * 1024
                );
                assert_eq!(
                    config.qemu.layered.minimum_free_bytes,
                    20 * 1024 * 1024 * 1024
                );
                let upload = config.upload.expect("upload config should be present");
                assert_eq!(upload.url, "https://intar.dev/registry/v1/publish");
                assert_eq!(upload.token, "registry-publish-token");
            }
            Err(error) => panic!("config should parse: {error}"),
        }
    }

    #[test]
    fn parses_disabled_upload_without_token() {
        let parsed = hcl::from_str::<BuildConfig>(
            r#"
upload {
  enabled = false
  url = "https://intar.dev/registry/v1/publish"
}
"#,
        )
        .expect("config should parse");

        let upload = parsed.upload.expect("upload config should be present");
        assert!(!upload.enabled);
        assert_eq!(upload.token, "");
    }

    #[test]
    fn defaults_to_oci_cache_settings() {
        let config = hcl::from_str::<BuildConfig>("").expect("config should parse");

        assert!(config.qemu.layered.use_cache);
        assert_eq!(config.qemu.layered.oci_cache_bytes, 8 * 1024 * 1024 * 1024);
        assert_eq!(
            config.qemu.layered.checkpoint_cache_bytes,
            40 * 1024 * 1024 * 1024
        );
        assert_eq!(
            config.qemu.layered.minimum_free_bytes,
            20 * 1024 * 1024 * 1024
        );
    }

    #[test]
    fn rejects_removed_qemu_fields() {
        for field in [
            "backend = \"legacy\"",
            "mmdebstrap_binary = \"mmdebstrap\"",
            "qemuargs = []",
            "base_cache_root = \".cache/base\"",
        ] {
            let source = format!("qemu {{\n  {field}\n}}");
            assert!(hcl::from_str::<BuildConfig>(&source).is_err(), "{field}");
        }
    }
}
