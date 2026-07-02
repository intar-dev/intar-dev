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
    pub packer: PackerConfig,
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
pub struct PackerConfig {
    #[serde(default = "default_target_arch")]
    pub target_arch: String,
    #[serde(default = "default_packer_binary")]
    pub binary: PathBuf,
    #[serde(default = "default_qemu_binary")]
    pub qemu_binary: PathBuf,
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
}

impl Default for PackerConfig {
    fn default() -> Self {
        Self {
            target_arch: default_target_arch(),
            binary: default_packer_binary(),
            qemu_binary: default_qemu_binary(),
            accelerator: default_accelerator(),
            qemuargs: Vec::new(),
            build_cpus: default_build_cpus(),
            build_memory_mb: default_build_memory_mb(),
            output_root: default_output_root(),
            work_root: default_work_root(),
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

fn default_packer_binary() -> PathBuf {
    PathBuf::from("packer")
}

fn default_target_arch() -> String {
    String::from("amd64")
}

fn default_qemu_binary() -> PathBuf {
    PathBuf::from("qemu-system-x86_64")
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
    use super::BuildConfig;

    #[test]
    fn parses_builder_config() {
        let parsed = hcl::from_str::<BuildConfig>(
            r#"
packer {
  target_arch = "amd64"
  binary = "/usr/local/bin/packer"
  qemu_binary = "/usr/local/bin/qemu-system-x86_64"
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
                assert_eq!(config.packer.accelerator, "none");
                assert_eq!(config.packer.target_arch, "amd64");
                assert_eq!(config.packer.qemuargs.len(), 1);
                assert_eq!(config.packer.build_cpus, 4);
                assert_eq!(config.packer.build_memory_mb, 4096);
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
