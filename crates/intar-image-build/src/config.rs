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
pub struct QemuBuildConfig {
    #[serde(default = "default_target_arch")]
    pub target_arch: String,
    #[serde(default = "default_qemu_binary")]
    pub qemu_binary: PathBuf,
    #[serde(default = "default_mmdebstrap_binary")]
    pub mmdebstrap_binary: PathBuf,
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
    #[serde(default)]
    pub qemuargs: Vec<Vec<String>>,
    #[serde(default = "default_build_cpus")]
    pub build_cpus: u32,
    #[serde(default = "default_build_memory_mb")]
    pub build_memory_mb: u32,
    #[serde(default = "default_output_root")]
    pub output_root: PathBuf,
    #[serde(default = "default_work_root")]
    pub work_root: PathBuf,
    #[serde(default)]
    pub base_cache_root: Option<PathBuf>,
}

impl Default for QemuBuildConfig {
    fn default() -> Self {
        Self {
            target_arch: default_target_arch(),
            qemu_binary: default_qemu_binary(),
            mmdebstrap_binary: default_mmdebstrap_binary(),
            mke2fs_binary: default_mke2fs_binary(),
            e2fsck_binary: default_e2fsck_binary(),
            resize2fs_binary: default_resize2fs_binary(),
            ssh_wait_timeout_seconds: default_ssh_wait_timeout_seconds(),
            provision_timeout_seconds: default_provision_timeout_seconds(),
            qemu_exit_timeout_seconds: default_qemu_exit_timeout_seconds(),
            accelerator: default_accelerator(),
            qemuargs: Vec::new(),
            build_cpus: default_build_cpus(),
            build_memory_mb: default_build_memory_mb(),
            output_root: default_output_root(),
            work_root: default_work_root(),
            base_cache_root: None,
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

fn default_mmdebstrap_binary() -> PathBuf {
    PathBuf::from("mmdebstrap")
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
    String::from("none")
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
  mmdebstrap_binary = "/usr/bin/mmdebstrap"
  mke2fs_binary = "/usr/sbin/mke2fs"
  e2fsck_binary = "/usr/sbin/e2fsck"
  resize2fs_binary = "/usr/sbin/resize2fs"
  ssh_wait_timeout_seconds = 120
  provision_timeout_seconds = 240
  qemu_exit_timeout_seconds = 30
  accelerator = "none"
  qemuargs = [["-machine", "q35"]]
  build_cpus = 4
  build_memory_mb = 4096
  output_root = "dist"
  work_root = ".work"
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
                assert_eq!(config.qemu.accelerator, "none");
                assert_eq!(config.qemu.target_arch, "amd64");
                assert_eq!(
                    config.qemu.mmdebstrap_binary,
                    PathBuf::from("/usr/bin/mmdebstrap")
                );
                assert_eq!(config.qemu.ssh_wait_timeout_seconds, 120);
                assert_eq!(config.qemu.provision_timeout_seconds, 240);
                assert_eq!(config.qemu.qemu_exit_timeout_seconds, 30);
                assert_eq!(config.qemu.qemuargs.len(), 1);
                assert_eq!(config.qemu.build_cpus, 4);
                assert_eq!(config.qemu.build_memory_mb, 4096);
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
}
