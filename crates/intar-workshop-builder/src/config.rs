use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result, bail};
use intar_contracts::catalog::ImageArchitecture;
use serde::Deserialize;
use url::Url;

use crate::contracts::RuntimeBundleCompression;

pub const DEFAULT_MAX_COMPRESSED_BUNDLE_BYTES: u64 = 64 * 1024 * 1024;
pub const DEFAULT_MAX_EXPANDED_BUNDLE_BYTES: u64 = 512 * 1024 * 1024;
pub const DEFAULT_MAX_BUNDLE_ENTRIES: usize = 4_096;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkshopBuilderConfig {
    pub registry: RegistryConfig,
    #[serde(default)]
    pub worker: WorkerConfig,
    pub execution: KvmExecutionConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegistryConfig {
    pub base_url: String,
    pub host_id: String,
    pub bootstrap_token: String,
    #[serde(default = "default_http_timeout_seconds")]
    pub http_timeout_seconds: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct WorkerConfig {
    pub work_root: PathBuf,
    pub architecture: ImageArchitecture,
    pub poll_interval_seconds: u64,
    pub error_retry_seconds: u64,
    pub max_compressed_bundle_bytes: u64,
    pub max_expanded_bundle_bytes: u64,
    pub max_bundle_entries: usize,
    /// Required when a claimed workshop selects the direct Hetzner runtime.
    /// The secret itself is never present in TOML: the config names either a
    /// root-owned file or an environment variable containing a base64 seed.
    #[serde(default)]
    pub runtime_bundle_signing: Option<RuntimeBundleSigningConfig>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeBundleSigningConfig {
    pub key_id: String,
    #[serde(default)]
    pub private_key_file: Option<PathBuf>,
    #[serde(default)]
    pub private_key_env: Option<String>,
    #[serde(default)]
    pub compression: RuntimeBundleCompression,
}

impl Default for WorkerConfig {
    fn default() -> Self {
        Self {
            work_root: PathBuf::from("/var/lib/intar-workshop-builder/bundles"),
            architecture: ImageArchitecture::X86_64,
            poll_interval_seconds: 5,
            error_retry_seconds: 15,
            max_compressed_bundle_bytes: DEFAULT_MAX_COMPRESSED_BUNDLE_BYTES,
            max_expanded_bundle_bytes: DEFAULT_MAX_EXPANDED_BUNDLE_BYTES,
            max_bundle_entries: DEFAULT_MAX_BUNDLE_ENTRIES,
            runtime_bundle_signing: None,
        }
    }
}

/// Trusted-host settings for the concrete direct-QEMU workshop builder.
/// Every path in this section is operator-controlled; workshop bundles cannot
/// override kernels, base disks, binaries, the sanitizer, or boot arguments.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KvmExecutionConfig {
    pub work_root: PathBuf,
    pub qemu_binary: PathBuf,
    pub e2fsck_binary: PathBuf,
    pub resize2fs_binary: PathBuf,
    pub sanitizer_path: String,
    #[serde(default = "default_ssh_username")]
    pub ssh_username: String,
    #[serde(default = "default_accelerator")]
    pub accelerator: String,
    #[serde(default = "default_true")]
    pub require_kvm: bool,
    #[serde(default = "default_ssh_wait_timeout_seconds")]
    pub ssh_wait_timeout_seconds: u64,
    #[serde(default = "default_script_timeout_seconds")]
    pub script_timeout_seconds: u64,
    #[serde(default = "default_shutdown_timeout_seconds")]
    pub shutdown_timeout_seconds: u64,
    #[serde(default = "default_probe_every_seconds")]
    pub probe_every_seconds: u64,
    #[serde(default = "default_probe_timeout_seconds")]
    pub probe_timeout_seconds: u64,
    /// Separate, operator-pinned pristine Debian image used only to prove the
    /// direct-cloud reconstruction path. It must not be one of the authored
    /// workshop build images.
    #[serde(default)]
    pub runtime_bundle_verification: Option<RuntimeBundleVerificationConfig>,
    pub images: Vec<WorkshopBaseImageConfig>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeBundleVerificationConfig {
    /// Must exactly match `workspace.provider.hetzner_cloud.system_image`.
    pub system_image: String,
    pub architecture: ImageArchitecture,
    pub disk: PathBuf,
    pub disk_sha256: String,
    pub kernel: PathBuf,
    pub kernel_sha256: String,
    pub initrd: PathBuf,
    pub initrd_sha256: String,
    pub boot_cmdline: String,
    /// Exact guest agent installed by direct-cloud cloud-init. The builder
    /// uploads this binary into the proof guest rather than trusting a copy in
    /// the base image.
    pub workspace_agent_binary: PathBuf,
    pub workspace_agent_sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkshopBaseImageConfig {
    pub name: String,
    pub architecture: ImageArchitecture,
    pub disk: PathBuf,
    pub kernel: PathBuf,
    pub initrd: PathBuf,
    pub boot_cmdline: String,
    /// Operator-owned guest paths that canonical catch-up scripts need while
    /// building but that must never remain in a participant checkpoint.
    #[serde(default)]
    pub guest_build_material_paths: Vec<String>,
    /// Exact guest paths that must be absent from every cold-booted participant
    /// checkpoint. This includes build material plus source-control metadata,
    /// answer keys, facilitator content, and known backup/duplicate trees.
    pub guest_forbidden_participant_paths: Vec<String>,
}

impl WorkshopBuilderConfig {
    pub fn validate(&self) -> Result<()> {
        validate_registry(&self.registry)?;
        if !self.worker.work_root.is_absolute() {
            bail!("worker.work_root must be absolute");
        }
        if self.worker.work_root == Path::new("/") {
            bail!("worker.work_root must not be the filesystem root");
        }
        if self.worker.poll_interval_seconds == 0 {
            bail!("worker.poll_interval_seconds must be positive");
        }
        if self.worker.error_retry_seconds == 0 {
            bail!("worker.error_retry_seconds must be positive");
        }
        if self.worker.max_compressed_bundle_bytes == 0
            || self.worker.max_expanded_bundle_bytes < self.worker.max_compressed_bundle_bytes
        {
            bail!("worker bundle byte limits are invalid");
        }
        if self.worker.max_bundle_entries == 0 {
            bail!("worker.max_bundle_entries must be positive");
        }
        if let Some(signing) = &self.worker.runtime_bundle_signing {
            validate_runtime_bundle_signing(signing)?;
        }
        if self.worker.runtime_bundle_signing.is_some()
            != self.execution.runtime_bundle_verification.is_some()
        {
            bail!(
                "worker.runtime_bundle_signing and execution.runtime_bundle_verification must be configured together"
            );
        }
        if self.worker.architecture != ImageArchitecture::X86_64 {
            bail!("workshop KVM backend v1 supports only worker architecture x86_64");
        }
        validate_execution(&self.execution)?;
        Ok(())
    }
}

fn validate_runtime_bundle_signing(config: &RuntimeBundleSigningConfig) -> Result<()> {
    if !is_safe_id(&config.key_id) {
        bail!("worker.runtime_bundle_signing.key_id is invalid");
    }
    match (&config.private_key_file, &config.private_key_env) {
        (Some(path), None) => {
            if !path.is_absolute() || path == Path::new("/") {
                bail!(
                    "worker.runtime_bundle_signing.private_key_file must be an absolute file path"
                );
            }
        }
        (None, Some(name)) => {
            if !is_safe_environment_name(name) {
                bail!("worker.runtime_bundle_signing.private_key_env is invalid");
            }
        }
        (Some(_), Some(_)) => {
            bail!("worker.runtime_bundle_signing must select exactly one private-key source");
        }
        (None, None) => {
            bail!("worker.runtime_bundle_signing must select a private-key source");
        }
    }
    Ok(())
}

fn validate_execution(config: &KvmExecutionConfig) -> Result<()> {
    for (label, path) in [
        ("execution.work_root", &config.work_root),
        ("execution.qemu_binary", &config.qemu_binary),
        ("execution.e2fsck_binary", &config.e2fsck_binary),
        ("execution.resize2fs_binary", &config.resize2fs_binary),
    ] {
        if !path.is_absolute() {
            bail!("{label} must be absolute");
        }
    }
    if config.work_root == Path::new("/") {
        bail!("execution.work_root must not be the filesystem root");
    }
    if !is_absolute_guest_path(&config.sanitizer_path) {
        bail!("execution.sanitizer_path must be an absolute guest path");
    }
    if !is_safe_guest_name(&config.ssh_username) {
        bail!("execution.ssh_username is invalid");
    }
    if config.require_kvm && config.accelerator.trim() != "kvm" {
        bail!("execution.accelerator must be 'kvm' when require_kvm is true");
    }
    if config.accelerator.trim().is_empty() || config.accelerator.contains([',', '\n', '\r', '\0'])
    {
        bail!("execution.accelerator is invalid");
    }
    for (label, value) in [
        (
            "execution.ssh_wait_timeout_seconds",
            config.ssh_wait_timeout_seconds,
        ),
        (
            "execution.script_timeout_seconds",
            config.script_timeout_seconds,
        ),
        (
            "execution.shutdown_timeout_seconds",
            config.shutdown_timeout_seconds,
        ),
        ("execution.probe_every_seconds", config.probe_every_seconds),
        (
            "execution.probe_timeout_seconds",
            config.probe_timeout_seconds,
        ),
    ] {
        if value == 0 {
            bail!("{label} must be positive");
        }
    }
    if config.images.is_empty() {
        bail!("execution.images must contain at least one trusted base image");
    }
    if let Some(proof) = &config.runtime_bundle_verification {
        if proof.system_image != "debian-13" {
            bail!("execution.runtime_bundle_verification.system_image must be 'debian-13'");
        }
        if proof.architecture != ImageArchitecture::X86_64 {
            bail!("execution.runtime_bundle_verification supports only architecture x86_64");
        }
        for (label, path) in [
            ("disk", &proof.disk),
            ("kernel", &proof.kernel),
            ("initrd", &proof.initrd),
            ("workspace_agent_binary", &proof.workspace_agent_binary),
        ] {
            if !path.is_absolute() || path == Path::new("/") {
                bail!(
                    "execution.runtime_bundle_verification.{label} must be an absolute file path"
                );
            }
        }
        for (label, digest) in [
            ("disk_sha256", proof.disk_sha256.as_str()),
            ("kernel_sha256", proof.kernel_sha256.as_str()),
            ("initrd_sha256", proof.initrd_sha256.as_str()),
            (
                "workspace_agent_sha256",
                proof.workspace_agent_sha256.as_str(),
            ),
        ] {
            if !is_sha256(digest) {
                bail!(
                    "execution.runtime_bundle_verification.{label} must be 64 lowercase hexadecimal characters"
                );
            }
        }
        if proof.boot_cmdline.trim().is_empty() || proof.boot_cmdline.contains(['\n', '\r', '\0']) {
            bail!("execution.runtime_bundle_verification.boot_cmdline is invalid");
        }
    }
    let mut names = BTreeSet::new();
    for image in &config.images {
        if config
            .runtime_bundle_verification
            .as_ref()
            .is_some_and(|proof| proof.disk == image.disk)
        {
            bail!(
                "execution runtime-bundle proof disk must be separate from authored image '{}'",
                image.name
            );
        }
        if !is_safe_id(&image.name) {
            bail!("execution image name '{}' is invalid", image.name);
        }
        if !names.insert(image.name.as_str()) {
            bail!("execution image name '{}' is duplicated", image.name);
        }
        if image.architecture != ImageArchitecture::X86_64 {
            bail!(
                "execution image '{}' uses {:?}; the direct-QEMU workshop backend v1 supports only x86_64",
                image.name,
                image.architecture
            );
        }
        for (label, path) in [
            ("disk", &image.disk),
            ("kernel", &image.kernel),
            ("initrd", &image.initrd),
        ] {
            if !path.is_absolute() {
                bail!(
                    "execution image '{}' {label} path must be absolute",
                    image.name
                );
            }
        }
        if image.boot_cmdline.trim().is_empty() || image.boot_cmdline.contains(['\n', '\r', '\0']) {
            bail!("execution image '{}' boot_cmdline is invalid", image.name);
        }
        let mut forbidden_paths = BTreeSet::new();
        if image.guest_forbidden_participant_paths.is_empty() {
            bail!(
                "execution image '{}' must declare forbidden participant paths",
                image.name
            );
        }
        for path in &image.guest_forbidden_participant_paths {
            if !is_absolute_guest_path(path) || is_broad_guest_path(path) {
                bail!(
                    "execution image '{}' forbidden participant path '{}' is unsafe",
                    image.name,
                    path
                );
            }
            if !forbidden_paths.insert(path.as_str()) {
                bail!(
                    "execution image '{}' forbidden participant path '{}' is duplicated",
                    image.name,
                    path
                );
            }
        }
        if !forbidden_paths.iter().any(|path| path.ends_with("/.git")) {
            bail!(
                "execution image '{}' forbidden participant paths must include the workshop .git path",
                image.name
            );
        }
        let mut guest_paths = BTreeSet::new();
        for path in &image.guest_build_material_paths {
            if !is_absolute_guest_path(path) || is_broad_guest_path(path) {
                bail!(
                    "execution image '{}' guest build-material path '{}' is unsafe",
                    image.name,
                    path
                );
            }
            if !guest_paths.insert(path.as_str()) {
                bail!(
                    "execution image '{}' guest build-material path '{}' is duplicated",
                    image.name,
                    path
                );
            }
            if !forbidden_paths.contains(path.as_str()) {
                bail!(
                    "execution image '{}' build-material path '{}' must also be listed as a forbidden participant path",
                    image.name,
                    path
                );
            }
        }
    }
    Ok(())
}

pub fn load(path: &Path) -> Result<WorkshopBuilderConfig> {
    let source = std::fs::read_to_string(path).with_context(|| {
        format!(
            "failed to read workshop builder config '{}'",
            path.display()
        )
    })?;
    parse(&source)
}

pub fn parse(source: &str) -> Result<WorkshopBuilderConfig> {
    let config: WorkshopBuilderConfig =
        toml::from_str(source).context("failed to parse workshop builder config TOML")?;
    config.validate()?;
    Ok(config)
}

fn validate_registry(config: &RegistryConfig) -> Result<()> {
    let base_url = Url::parse(config.base_url.trim()).context("registry.base_url is invalid")?;
    let is_https = base_url.scheme() == "https";
    let is_loopback_http = base_url.scheme() == "http"
        && base_url
            .host_str()
            .and_then(|host| host.parse::<std::net::IpAddr>().ok())
            .is_some_and(|address| address.is_loopback());
    let is_localhost_http = base_url.scheme() == "http"
        && base_url
            .host_str()
            .is_some_and(|host| host.eq_ignore_ascii_case("localhost"));
    if !(is_https || is_loopback_http || is_localhost_http) {
        bail!("registry.base_url must use HTTPS (HTTP is allowed only for loopback)");
    }
    if base_url.cannot_be_a_base() || base_url.host_str().is_none() {
        bail!("registry.base_url must be an absolute HTTP URL");
    }
    if !is_safe_id(&config.host_id) {
        bail!("registry.host_id is invalid");
    }
    if config.bootstrap_token.trim().is_empty() {
        bail!("registry.bootstrap_token is required");
    }
    if config.http_timeout_seconds == 0 {
        bail!("registry.http_timeout_seconds must be positive");
    }
    Ok(())
}

fn is_safe_id(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn is_safe_guest_name(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn is_safe_environment_name(value: &str) -> bool {
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_uppercase() || byte == b'_')
        && bytes.all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        && value.len() <= 128
}

fn is_absolute_guest_path(value: &str) -> bool {
    value.starts_with('/')
        && !value.contains(['\n', '\r', '\0'])
        && !value.split('/').any(|component| component == "..")
}

fn is_broad_guest_path(value: &str) -> bool {
    matches!(
        value.trim_end_matches('/'),
        "" | "/" | "/etc" | "/home" | "/opt" | "/root" | "/run" | "/tmp" | "/usr" | "/var"
    )
}

const fn default_http_timeout_seconds() -> u64 {
    120
}

fn default_ssh_username() -> String {
    "ubuntu".to_string()
}

fn default_accelerator() -> String {
    "kvm".to_string()
}

const fn default_true() -> bool {
    true
}

const fn default_ssh_wait_timeout_seconds() -> u64 {
    20 * 60
}

const fn default_script_timeout_seconds() -> u64 {
    60 * 60
}

const fn default_shutdown_timeout_seconds() -> u64 {
    5 * 60
}

const fn default_probe_every_seconds() -> u64 {
    10
}

const fn default_probe_timeout_seconds() -> u64 {
    120
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::parse;

    const EXECUTION: &str = r#"
[execution]
work_root = "/var/lib/intar-workshop-builder/executions"
qemu_binary = "/usr/bin/qemu-system-x86_64"
e2fsck_binary = "/usr/sbin/e2fsck"
resize2fs_binary = "/usr/sbin/resize2fs"
sanitizer_path = "/usr/local/sbin/intar-workshop-sanitize"

[[execution.images]]
name = "debian13-workshop"
architecture = "x86_64"
disk = "/var/lib/intar-workshop-builder/bases/debian13.raw"
kernel = "/var/lib/intar-workshop-builder/bases/vmlinuz"
initrd = "/var/lib/intar-workshop-builder/bases/initrd.img"
boot_cmdline = "root=/dev/vda rw console=ttyS0 quiet"
guest_build_material_paths = ["/opt/debian13-workshop/canonical-catch-up"]
guest_forbidden_participant_paths = [
  "/opt/debian13-workshop/.git",
  "/opt/debian13-workshop/canonical-catch-up",
]
"#;

    const RUNTIME_BUNDLE_VERIFICATION: &str = r#"
[execution.runtime_bundle_verification]
system_image = "debian-13"
architecture = "x86_64"
disk = "/var/lib/intar-workshop-builder/bases/clean-debian13.raw"
disk_sha256 = "1111111111111111111111111111111111111111111111111111111111111111"
kernel = "/var/lib/intar-workshop-builder/bases/clean-vmlinuz"
kernel_sha256 = "2222222222222222222222222222222222222222222222222222222222222222"
initrd = "/var/lib/intar-workshop-builder/bases/clean-initrd.img"
initrd_sha256 = "3333333333333333333333333333333333333333333333333333333333333333"
boot_cmdline = "root=/dev/vda rw console=ttyS0 quiet"
workspace_agent_binary = "/usr/local/libexec/intar/intar-workspace-agent"
workspace_agent_sha256 = "4444444444444444444444444444444444444444444444444444444444444444"
"#;

    #[test]
    fn parses_minimal_config_with_safe_defaults() {
        let config = parse(&format!(
            r#"
[registry]
base_url = "https://intar.dev"
host_id = "builder-01"
bootstrap_token = "secret"
{}"#,
            EXECUTION
        ))
        .unwrap();

        assert_eq!(config.worker.poll_interval_seconds, 5);
        assert_eq!(config.worker.max_bundle_entries, 4_096);
        assert_eq!(
            config.worker.architecture,
            intar_contracts::catalog::ImageArchitecture::X86_64
        );
    }

    #[test]
    fn rejects_plaintext_remote_registry() {
        let error = parse(&format!(
            r#"
[registry]
base_url = "http://example.com"
host_id = "builder-01"
bootstrap_token = "secret"
{}"#,
            EXECUTION
        ))
        .unwrap_err();

        assert!(error.to_string().contains("HTTPS"));
    }

    #[test]
    fn rejects_unknown_fields() {
        let error = parse(&format!(
            r#"
[registry]
base_url = "https://intar.dev"
host_id = "builder-01"
bootstrap_token = "secret"
surprise = true
{}"#,
            EXECUTION
        ))
        .unwrap_err();

        assert!(format!("{error:#}").contains("unknown field"));
    }

    #[test]
    fn parses_example_config() {
        parse(include_str!("../config.example.toml")).unwrap();
    }

    #[test]
    fn rejects_broad_guest_build_material_path() {
        let source = format!(
            r#"
[registry]
base_url = "https://intar.dev"
host_id = "builder-01"
bootstrap_token = "secret"
{}"#,
            EXECUTION.replace(
                "guest_build_material_paths = [\"/opt/debian13-workshop/canonical-catch-up\"]",
                "guest_build_material_paths = [\"/opt\"]"
            )
        );
        let error = parse(&source).unwrap_err();
        assert!(format!("{error:#}").contains("build-material path '/opt' is unsafe"));
    }

    #[test]
    fn rejects_build_material_not_forbidden_from_participant_checkpoint() {
        let source = format!(
            r#"
[registry]
base_url = "https://intar.dev"
host_id = "builder-01"
bootstrap_token = "secret"
{}"#,
            EXECUTION.replace("  \"/opt/debian13-workshop/canonical-catch-up\",\n", "")
        );
        let error = parse(&source).unwrap_err();
        assert!(
            format!("{error:#}").contains("must also be listed as a forbidden participant path")
        );
    }

    #[test]
    fn requires_a_source_control_boundary_path() {
        let source = format!(
            r#"
[registry]
base_url = "https://intar.dev"
host_id = "builder-01"
bootstrap_token = "secret"
{}"#,
            EXECUTION.replace("  \"/opt/debian13-workshop/.git\",\n", "")
        );
        let error = parse(&source).unwrap_err();
        assert!(format!("{error:#}").contains("must include the workshop .git path"));
    }

    #[test]
    fn rejects_broad_forbidden_participant_path() {
        let source = format!(
            r#"
[registry]
base_url = "https://intar.dev"
host_id = "builder-01"
bootstrap_token = "secret"
{}"#,
            EXECUTION.replace("  \"/opt/debian13-workshop/.git\",\n", "  \"/opt\",\n")
        );
        let error = parse(&source).unwrap_err();
        assert!(format!("{error:#}").contains("forbidden participant path '/opt' is unsafe"));
    }

    #[test]
    fn rejects_non_x86_worker_before_claiming() {
        let source = format!(
            r#"
[registry]
base_url = "https://intar.dev"
host_id = "builder-01"
bootstrap_token = "secret"

[worker]
architecture = "aarch64"
{}"#,
            EXECUTION
        );
        let error = parse(&source).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("only worker architecture x86_64")
        );
    }

    #[test]
    fn rejects_filesystem_root_as_bundle_work_root() {
        let source = format!(
            r#"
[registry]
base_url = "https://intar.dev"
host_id = "builder-01"
bootstrap_token = "secret"

[worker]
work_root = "/"
{}"#,
            EXECUTION
        );

        let error = parse(&source).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("must not be the filesystem root")
        );
    }

    #[test]
    fn validates_ci_safe_runtime_signing_sources() {
        let configured = parse(&format!(
            r#"
[registry]
base_url = "https://intar.dev"
host_id = "builder-01"
bootstrap_token = "secret"

[worker.runtime_bundle_signing]
key_id = "workshop-runtime-v1"
private_key_env = "INTAR_WORKSHOP_RUNTIME_SIGNING_KEY_B64"
compression = "gzip"
{}
{}"#,
            EXECUTION, RUNTIME_BUNDLE_VERIFICATION
        ))
        .unwrap();
        let signing = configured.worker.runtime_bundle_signing.unwrap();
        assert_eq!(
            signing.compression,
            crate::contracts::RuntimeBundleCompression::Gzip
        );
        assert_eq!(
            signing.private_key_env.as_deref(),
            Some("INTAR_WORKSHOP_RUNTIME_SIGNING_KEY_B64")
        );

        let error = parse(&format!(
            r#"
[registry]
base_url = "https://intar.dev"
host_id = "builder-01"
bootstrap_token = "secret"

[worker.runtime_bundle_signing]
key_id = "workshop-runtime-v1"
private_key_file = "/run/secrets/runtime-key"
private_key_env = "INTAR_WORKSHOP_RUNTIME_SIGNING_KEY_B64"
{}
{}"#,
            EXECUTION, RUNTIME_BUNDLE_VERIFICATION
        ))
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("must select exactly one private-key source")
        );
    }

    #[test]
    fn rejects_partial_direct_cloud_proof_configuration() {
        let error = parse(&format!(
            r#"
[registry]
base_url = "https://intar.dev"
host_id = "builder-01"
bootstrap_token = "secret"

[worker.runtime_bundle_signing]
key_id = "workshop-runtime-v1"
private_key_env = "INTAR_WORKSHOP_RUNTIME_SIGNING_KEY_B64"
{}"#,
            EXECUTION
        ))
        .unwrap_err();
        assert!(error.to_string().contains("must be configured together"));

        let error = parse(&format!(
            r#"
[registry]
base_url = "https://intar.dev"
host_id = "builder-01"
bootstrap_token = "secret"
{}
{}"#,
            EXECUTION, RUNTIME_BUNDLE_VERIFICATION
        ))
        .unwrap_err();
        assert!(error.to_string().contains("must be configured together"));
    }
}
