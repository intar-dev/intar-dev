use std::collections::BTreeMap;
use std::fs;
use std::io::Write as _;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result, bail, ensure};
use fs2::FileExt as _;
use intar_image_scenario::BaseImageSpec;
use serde::{Deserialize, Serialize};
use tar::Archive;

use crate::artifact::sha256_file_hex;
use crate::config::QemuBuildConfig;
use crate::content_hash::sha256_bytes_hex;
use crate::rootfs::{
    BASE_EXT4_LABEL, BaseRootfsArtifact, BaseRootfsLease, RootfsBuildPlan,
    base_rootfs_artifact_from_plan, create_base_ext4, extract_boot_artifacts,
};

const OCI_BASE_CACHE_ABI: &str = "intar-oci-base-v3";
const OCI_IMAGE_NAME: &str = "intar-base:latest";
const OCI_IMAGE_TAG: &str = "latest";
const OCI_REF_NAME_ANNOTATION: &str = "org.opencontainers.image.ref.name";
const METADATA_FILE: &str = "metadata.json";
const ROOTFS_FILE: &str = "root.ext4";
const KERNEL_FILE: &str = "vmlinuz";
const INITRD_FILE: &str = "initrd.img";
const LAST_USED_FILE: &str = "last-used";
const OCI_NEUTRAL_HOSTNAME: &str = "intar-build\n";
const OCI_NEUTRAL_HOSTS: &str = "127.0.0.1 localhost\n127.0.1.1 intar-build\n";
const HOST_CA_BUNDLE_PATH: &str = "/etc/ssl/certs/ca-certificates.crt";
const HOST_CA_BUNDLE_FILE: &str = "intar-host-ca-certificates.crt";
const APT_HTTPS_CA_INFO: &str = "Acquire::https::CaInfo=/etc/ssl/certs/ca-certificates.crt";

static OCI_BUILD_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
struct BaseArtifactRecord {
    abi: String,
    definition_hash: String,
    oci_manifest_digest: String,
    cache_key: String,
    filesystem_size_bytes: u64,
    root_ext4_sha256: String,
    kernel_sha256: String,
    initrd_sha256: String,
    bootstrap_ca_bundle_sha256: String,
}

#[derive(Debug)]
struct BootstrapCaBundle {
    bytes: Vec<u8>,
    sha256: String,
}

#[derive(Debug, Deserialize)]
struct OciIndex {
    manifests: Vec<OciDescriptor>,
}

#[derive(Debug, Deserialize)]
struct OciDescriptor {
    digest: String,
    #[serde(default)]
    annotations: BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
struct OciStagingPaths {
    work_root: PathBuf,
    context_dir: PathBuf,
    archive_path: PathBuf,
    layout_dir: PathBuf,
    bundle_dir: PathBuf,
    artifact_dir: PathBuf,
    rootfs_plan: RootfsBuildPlan,
}

/// Return the cache key for a layered rootfs definition before it has an OCI output digest.
#[must_use]
pub(crate) fn layered_definition_hash(
    base: &BaseImageSpec,
    essential_hook: &str,
    customize_hook: &str,
    config: &QemuBuildConfig,
) -> String {
    let identity = format!(
        "{}\n--hooks--\n{essential_hook}\n--\n{customize_hook}\n--layered-oci--\nabi={OCI_BASE_CACHE_ABI}\nimage={}\nplatform=linux/{}\nfilesystem=ext4\nlabel={BASE_EXT4_LABEL}\nmke2fs={}",
        base.content_identity(),
        config.layered.debian_image,
        base.arch,
        config.mke2fs_binary.display(),
    );
    sha256_bytes_hex(identity.as_bytes())
}

/// Build or reuse the layered OCI rootfs for one base-image definition.
pub(crate) fn ensure_oci_base_rootfs(
    base: &BaseImageSpec,
    config: &QemuBuildConfig,
    plan: &RootfsBuildPlan,
) -> Result<BaseRootfsArtifact> {
    validate_layered_inputs(base, config)?;
    let bootstrap_ca_bundle = read_bootstrap_ca_bundle()?;
    let cache_root = layered_cache_root(config);
    let cache_enabled = persistent_cache_enabled(config, &cache_root)?;
    if cache_enabled {
        let _cache_lock = exclusive_lock(&cache_root.join(".buildkit.lock"), "OCI build cache")?;
        prune_oci_cache(
            &cache_root,
            converted_cache_budget(config.layered.oci_cache_bytes),
        )?;

        if let Some(record) = read_definition_record(&cache_root, &plan.definition_hash)? {
            let cached_dir = converted_artifact_dir(&cache_root, &record.cache_key);
            if layered_artifact_dir_is_valid(
                &cached_dir,
                &record,
                &plan.definition_hash,
                &bootstrap_ca_bundle.sha256,
            )? {
                touch_cache_entry(&cached_dir)?;
                return cached_base_rootfs_artifact(&cache_root, plan, &record);
            }
        }

        let staging_root = cache_root.join(".staging");
        fs::create_dir_all(&staging_root).with_context(|| {
            format!(
                "failed to create OCI staging root '{}'",
                staging_root.display()
            )
        })?;
        let staging = staged_paths(plan, &staging_root, "base")?;
        let build_result = (|| -> Result<BaseRootfsArtifact> {
            let _compute = crate::compute::acquire();
            let record =
                build_staged_oci_base(base, config, plan, &staging, true, &bootstrap_ca_bundle)?;
            publish_cached_artifact(
                &cache_root,
                plan,
                &staging,
                &record,
                config,
                &bootstrap_ca_bundle.sha256,
            )
        })();
        cleanup_staging(&staging, build_result.is_err());
        return build_result;
    }

    let private_dir = private_artifact_directory(config)?;
    let staging = staged_paths(plan, private_dir.path(), "base")?;
    let build_result = (|| -> Result<BaseRootfsArtifact> {
        let _compute = crate::compute::acquire();
        let record =
            build_staged_oci_base(base, config, plan, &staging, false, &bootstrap_ca_bundle)?;
        finalize_private_staging(&staging, &record, private_dir)
    })();
    cleanup_staging(&staging, build_result.is_err());
    build_result
}

fn validate_layered_inputs(base: &BaseImageSpec, config: &QemuBuildConfig) -> Result<()> {
    validate_pinned_image_reference(&config.layered.debian_image)?;
    ensure!(
        base.arch == config.target_arch || (base.arch == "amd64" && config.target_arch == "x86_64"),
        "layered base '{}' has architecture '{}' but builder target is '{}'",
        base.name,
        base.arch,
        config.target_arch,
    );
    validate_apt_token("suite", &base.suite)?;
    validate_apt_mirror(&base.mirror)?;
    for package in std::iter::once(&base.kernel_package).chain(base.packages.iter()) {
        validate_apt_package(package)?;
    }
    Ok(())
}

fn validate_pinned_image_reference(image: &str) -> Result<()> {
    let Some((repository, digest)) = image.rsplit_once("@sha256:") else {
        bail!("layered Debian image must use an immutable sha256 digest");
    };
    ensure!(
        !repository.is_empty()
            && repository.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'/' | b'_' | b'-' | b':')
            }),
        "layered Debian image repository contains unsupported characters"
    );
    ensure!(
        is_sha256_hex(digest),
        "layered Debian image digest must contain 64 lowercase hexadecimal characters"
    );
    Ok(())
}

fn validate_apt_token(label: &str, value: &str) -> Result<()> {
    ensure!(
        !value.is_empty()
            && value
                .bytes()
                .all(|byte| { byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-') }),
        "base image {label} contains unsupported characters"
    );
    Ok(())
}

fn validate_apt_mirror(mirror: &str) -> Result<()> {
    ensure!(
        !mirror.is_empty()
            && mirror.bytes().all(|byte| {
                byte.is_ascii_alphanumeric()
                    || matches!(
                        byte,
                        b':' | b'/' | b'.' | b'-' | b'_' | b'~' | b'%' | b'+' | b'='
                    )
            }),
        "base image mirror contains unsupported characters"
    );
    Ok(())
}

fn validate_apt_package(package: &str) -> Result<()> {
    ensure!(
        !package.is_empty()
            && !package.starts_with('-')
            && package.bytes().all(|byte| {
                byte.is_ascii_alphanumeric()
                    || matches!(byte, b'.' | b'+' | b'-' | b'_' | b':' | b'=')
            }),
        "base image package '{package}' contains unsupported characters"
    );
    Ok(())
}

fn read_bootstrap_ca_bundle() -> Result<BootstrapCaBundle> {
    let path = Path::new(HOST_CA_BUNDLE_PATH);
    let bytes = fs::read(path)
        .with_context(|| format!("failed to read host CA bundle '{}'", path.display()))?;
    bootstrap_ca_bundle_from_bytes(path, bytes)
}

fn bootstrap_ca_bundle_from_bytes(path: &Path, bytes: Vec<u8>) -> Result<BootstrapCaBundle> {
    ensure!(
        !bytes.is_empty(),
        "host CA bundle '{}' is empty",
        path.display()
    );
    ensure!(
        !bytes
            .windows(b"PRIVATE KEY".len())
            .any(|window| window == b"PRIVATE KEY"),
        "host CA bundle '{}' contains a private key",
        path.display()
    );
    ensure!(
        bytes
            .windows(b"BEGIN CERTIFICATE".len())
            .any(|window| window == b"BEGIN CERTIFICATE"),
        "host CA bundle '{}' has no PEM certificate",
        path.display()
    );
    Ok(BootstrapCaBundle {
        sha256: sha256_bytes_hex(&bytes),
        bytes,
    })
}

fn persistent_cache_enabled(config: &QemuBuildConfig, cache_root: &Path) -> Result<bool> {
    if !config.layered.use_cache || converted_cache_budget(config.layered.oci_cache_bytes) == 0 {
        return Ok(false);
    }
    fs::create_dir_all(cache_root)
        .with_context(|| format!("failed to create OCI cache '{}'", cache_root.display()))?;
    let available = fs2::available_space(cache_root)
        .with_context(|| format!("failed to read free space for '{}'", cache_root.display()))?;
    Ok(available >= config.layered.minimum_free_bytes)
}

fn converted_cache_budget(total_budget: u64) -> u64 {
    total_budget / 4
}

fn layered_cache_root(config: &QemuBuildConfig) -> PathBuf {
    config
        .layered
        .oci_cache_root
        .clone()
        .unwrap_or_else(|| config.work_root.join("oci-cache"))
}

fn exclusive_lock(path: &Path, label: &str) -> Result<fs::File> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create lock parent '{}'", parent.display()))?;
    }
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .with_context(|| format!("failed to open {label} lock '{}'", path.display()))?;
    lock.lock_exclusive()
        .with_context(|| format!("failed to lock {label} '{}'", path.display()))?;
    Ok(lock)
}

fn staged_paths(
    plan: &RootfsBuildPlan,
    artifact_parent: &Path,
    artifact_name: &str,
) -> Result<OciStagingPaths> {
    let sequence = OCI_BUILD_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let staging_name = format!(
        ".{artifact_name}.oci-build-{}-{sequence}",
        std::process::id()
    );
    let work_parent = plan
        .paths
        .work_root
        .parent()
        .context("layered base work path has no parent")?;
    let work_root = work_parent.join(&staging_name);
    let artifact_dir = artifact_parent.join(&staging_name);
    let bundle_dir = work_root.join("bundle");
    let mut rootfs_plan = plan.clone();
    rootfs_plan.paths.work_root = work_root.clone();
    rootfs_plan.paths.rootfs_dir = bundle_dir.join("rootfs");
    rootfs_plan.paths.base_ext4_path = artifact_dir.join(ROOTFS_FILE);
    rootfs_plan.paths.kernel_path = artifact_dir.join(KERNEL_FILE);
    rootfs_plan.paths.initrd_path = artifact_dir.join(INITRD_FILE);

    Ok(OciStagingPaths {
        context_dir: work_root.join("context"),
        archive_path: work_root.join("image.oci.tar"),
        layout_dir: work_root.join("layout"),
        bundle_dir,
        work_root,
        artifact_dir,
        rootfs_plan,
    })
}

fn cleanup_staging(staging: &OciStagingPaths, remove_artifact: bool) {
    let _ = fs::remove_dir_all(&staging.work_root);
    if remove_artifact {
        let _ = fs::remove_dir_all(&staging.artifact_dir);
    }
}

fn private_artifact_directory(config: &QemuBuildConfig) -> Result<tempfile::TempDir> {
    let parent = config.work_root.join("private-base-artifacts");
    fs::create_dir_all(&parent).with_context(|| {
        format!(
            "failed to create private base artifact parent '{}'",
            parent.display()
        )
    })?;
    tempfile::Builder::new()
        .prefix("intar-oci-base-")
        .tempdir_in(&parent)
        .with_context(|| {
            format!(
                "failed to create private base artifact in '{}'",
                parent.display()
            )
        })
}

fn finalize_private_staging(
    staging: &OciStagingPaths,
    record: &BaseArtifactRecord,
    private_dir: tempfile::TempDir,
) -> Result<BaseRootfsArtifact> {
    write_artifact_record(&staging.artifact_dir, record)?;
    sync_artifact_files(&staging.artifact_dir)?;
    Ok(base_rootfs_artifact_from_plan(
        &staging.rootfs_plan,
        Arc::new(BaseRootfsLease::Private {
            _directory: private_dir,
        }),
    ))
}

fn publish_private_artifact(
    config: &QemuBuildConfig,
    staging: &OciStagingPaths,
    record: &BaseArtifactRecord,
) -> Result<BaseRootfsArtifact> {
    let private_dir = private_artifact_directory(config)?;
    let destination = private_dir.path().join("artifact");
    fs::create_dir(&destination).with_context(|| {
        format!(
            "failed to create private OCI artifact '{}'",
            destination.display()
        )
    })?;
    let result = (|| -> Result<BaseRootfsArtifact> {
        write_artifact_record(&staging.artifact_dir, record)?;
        sync_artifact_files(&staging.artifact_dir)?;
        for file in [ROOTFS_FILE, KERNEL_FILE, INITRD_FILE, METADATA_FILE] {
            fs::copy(staging.artifact_dir.join(file), destination.join(file))
                .with_context(|| format!("failed to copy private OCI artifact '{}'", file))?;
        }
        sync_artifact_files(&destination)?;
        fs::remove_dir_all(&staging.artifact_dir).with_context(|| {
            format!(
                "failed to remove staged OCI artifact '{}'",
                staging.artifact_dir.display()
            )
        })?;
        let mut plan = staging.rootfs_plan.clone();
        plan.paths.base_ext4_path = destination.join(ROOTFS_FILE);
        plan.paths.kernel_path = destination.join(KERNEL_FILE);
        plan.paths.initrd_path = destination.join(INITRD_FILE);
        Ok(base_rootfs_artifact_from_plan(
            &plan,
            Arc::new(BaseRootfsLease::Private {
                _directory: private_dir,
            }),
        ))
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&destination);
    }
    result
}

fn build_staged_oci_base(
    base: &BaseImageSpec,
    config: &QemuBuildConfig,
    plan: &RootfsBuildPlan,
    staging: &OciStagingPaths,
    cache_enabled: bool,
    bootstrap_ca_bundle: &BootstrapCaBundle,
) -> Result<BaseArtifactRecord> {
    fs::create_dir_all(&staging.context_dir).with_context(|| {
        format!(
            "failed to create OCI build context '{}'",
            staging.context_dir.display()
        )
    })?;
    fs::create_dir_all(&staging.artifact_dir).with_context(|| {
        format!(
            "failed to create OCI artifact staging '{}'",
            staging.artifact_dir.display()
        )
    })?;
    write_oci_build_context(
        base,
        config,
        plan,
        &staging.context_dir,
        bootstrap_ca_bundle,
    )?;
    run_buildctl(base, config, staging, cache_enabled)?;
    unpack_oci_archive(&staging.archive_path, &staging.layout_dir)?;
    let (manifest_digest, image_tag) = read_oci_manifest_reference(&staging.layout_dir)?;
    run_umoci_unpack(config, &staging.layout_dir, &image_tag, &staging.bundle_dir)?;
    ensure!(
        staging.rootfs_plan.paths.rootfs_dir.is_dir(),
        "umoci did not create rootfs '{}'",
        staging.rootfs_plan.paths.rootfs_dir.display()
    );
    write_oci_neutral_host_files(&staging.rootfs_plan.paths.rootfs_dir)?;
    remove_container_policy_rc_d(&staging.rootfs_plan.paths.rootfs_dir)?;
    extract_boot_artifacts(&staging.rootfs_plan)?;
    create_base_ext4(&staging.rootfs_plan, config)?;

    let filesystem_size_bytes = fs::metadata(&staging.rootfs_plan.paths.base_ext4_path)
        .with_context(|| {
            format!(
                "failed to inspect staged ext4 '{}'",
                staging.rootfs_plan.paths.base_ext4_path.display()
            )
        })?
        .len();
    let root_ext4_sha256 = sha256_file_hex(&staging.rootfs_plan.paths.base_ext4_path)?;
    let kernel_sha256 = sha256_file_hex(&staging.rootfs_plan.paths.kernel_path)?;
    let initrd_sha256 = sha256_file_hex(&staging.rootfs_plan.paths.initrd_path)?;
    let cache_key = converted_cache_key(
        &manifest_digest,
        filesystem_size_bytes,
        &kernel_sha256,
        &initrd_sha256,
        &bootstrap_ca_bundle.sha256,
    );
    Ok(BaseArtifactRecord {
        abi: OCI_BASE_CACHE_ABI.to_string(),
        definition_hash: plan.definition_hash.clone(),
        oci_manifest_digest: manifest_digest,
        cache_key,
        filesystem_size_bytes,
        root_ext4_sha256,
        kernel_sha256,
        initrd_sha256,
        bootstrap_ca_bundle_sha256: bootstrap_ca_bundle.sha256.clone(),
    })
}

fn write_oci_build_context(
    base: &BaseImageSpec,
    config: &QemuBuildConfig,
    plan: &RootfsBuildPlan,
    context_dir: &Path,
    bootstrap_ca_bundle: &BootstrapCaBundle,
) -> Result<()> {
    fs::write(
        context_dir.join("Dockerfile"),
        render_oci_dockerfile(base, config)?,
    )
    .with_context(|| {
        format!(
            "failed to write OCI Dockerfile in '{}'",
            context_dir.display()
        )
    })?;
    fs::write(
        context_dir.join("intar-essential-hook.sh"),
        &plan.essential_hook,
    )
    .with_context(|| {
        format!(
            "failed to write OCI essential hook in '{}'",
            context_dir.display()
        )
    })?;
    fs::write(
        context_dir.join("intar-customize-hook.sh"),
        &plan.customize_hook,
    )
    .with_context(|| {
        format!(
            "failed to write OCI customize hook in '{}'",
            context_dir.display()
        )
    })?;
    fs::write(
        context_dir.join("intar-debian.list"),
        render_debian_sources(base),
    )
    .with_context(|| {
        format!(
            "failed to write OCI apt sources in '{}'",
            context_dir.display()
        )
    })?;
    fs::write(
        context_dir.join(HOST_CA_BUNDLE_FILE),
        &bootstrap_ca_bundle.bytes,
    )
    .with_context(|| {
        format!(
            "failed to write OCI bootstrap CA bundle in '{}'",
            context_dir.display()
        )
    })?;
    Ok(())
}

fn render_oci_dockerfile(base: &BaseImageSpec, config: &QemuBuildConfig) -> Result<String> {
    validate_layered_inputs(base, config)?;
    let mut dockerfile = format!(
        "FROM {}\nENV DEBIAN_FRONTEND=noninteractive\n",
        config.layered.debian_image
    );
    dockerfile.push_str(&format!(
        "COPY {HOST_CA_BUNDLE_FILE} {HOST_CA_BUNDLE_PATH}\n"
    ));
    dockerfile.push_str(
        "COPY --chmod=0755 intar-essential-hook.sh /usr/local/libexec/intar/essential-hook.sh\n",
    );
    dockerfile.push_str(
        "COPY --chmod=0755 intar-customize-hook.sh /usr/local/libexec/intar/customize-hook.sh\n",
    );
    dockerfile.push_str(&docker_run([
        "/usr/local/libexec/intar/essential-hook.sh",
        "/",
    ])?);
    dockerfile.push_str(&docker_run([
        "rm",
        "-f",
        "/etc/apt/sources.list",
        "/etc/apt/sources.list.d/debian.sources",
    ])?);
    dockerfile.push_str("COPY intar-debian.list /etc/apt/sources.list\n");
    dockerfile.push_str(&docker_run([
        "apt-get",
        "-o",
        APT_HTTPS_CA_INFO,
        "-o",
        "APT::Update::Error-Mode=any",
        "update",
    ])?);
    let mut packages = vec![
        "apt-get".to_string(),
        "-o".to_string(),
        APT_HTTPS_CA_INFO.to_string(),
        "install".to_string(),
        "-y".to_string(),
    ];
    packages.push(base.kernel_package.clone());
    packages.extend(base.packages.iter().cloned());
    dockerfile.push_str(&docker_run(packages)?);
    dockerfile.push_str(&docker_run(["update-ca-certificates", "--fresh"])?);
    dockerfile.push_str(&docker_run([
        "/usr/local/libexec/intar/customize-hook.sh",
        "/",
    ])?);
    dockerfile.push_str(
        "RUN [\"/bin/sh\", \"-c\", \"rm -rf /var/lib/apt/lists/* /usr/local/libexec/intar\"]\n",
    );
    Ok(dockerfile)
}

fn docker_run(values: impl IntoIterator<Item = impl AsRef<str>>) -> Result<String> {
    let values = values
        .into_iter()
        .map(|value| value.as_ref().to_string())
        .collect::<Vec<_>>();
    Ok(format!(
        "RUN {}\n",
        serde_json::to_string(&values).context("failed to encode OCI Dockerfile command")?
    ))
}

fn render_debian_sources(base: &BaseImageSpec) -> String {
    format!("deb {} {} main\n", base.mirror, base.suite)
}

fn run_buildctl(
    base: &BaseImageSpec,
    config: &QemuBuildConfig,
    staging: &OciStagingPaths,
    cache_enabled: bool,
) -> Result<()> {
    let args = render_buildctl_args(base, config, staging, cache_enabled);
    run_command(&config.layered.buildctl_binary, &args, None)
        .context("BuildKit OCI base build failed")
}

fn render_buildctl_args(
    base: &BaseImageSpec,
    config: &QemuBuildConfig,
    staging: &OciStagingPaths,
    cache_enabled: bool,
) -> Vec<String> {
    let mut args = vec![
        "--addr".to_string(),
        format!(
            "unix://{}",
            layered_cache_root(config).join("buildkitd.sock").display()
        ),
        "build".to_string(),
        "--frontend=dockerfile.v0".to_string(),
        "--local".to_string(),
        format!("context={}", staging.context_dir.display()),
        "--local".to_string(),
        format!("dockerfile={}", staging.context_dir.display()),
        "--opt".to_string(),
        format!("platform=linux/{}", base.arch),
        "--output".to_string(),
        format!(
            "type=oci,name={OCI_IMAGE_NAME},dest={}",
            staging.archive_path.display()
        ),
    ];
    if !cache_enabled {
        args.push("--no-cache".to_string());
    }
    args
}

fn unpack_oci_archive(archive_path: &Path, layout_dir: &Path) -> Result<()> {
    fs::create_dir_all(layout_dir)
        .with_context(|| format!("failed to create OCI layout '{}'", layout_dir.display()))?;
    let archive = fs::File::open(archive_path)
        .with_context(|| format!("failed to open OCI archive '{}'", archive_path.display()))?;
    let mut archive = Archive::new(archive);
    for entry in archive
        .entries()
        .context("failed to read OCI archive entries")?
    {
        let mut entry = entry.context("failed to read OCI archive entry")?;
        let path = entry
            .path()
            .context("failed to read OCI archive entry path")?
            .into_owned();
        ensure!(
            safe_archive_path(&path),
            "OCI archive contains unsafe path '{}'",
            path.display()
        );
        ensure!(
            entry
                .unpack_in(layout_dir)
                .context("failed to unpack OCI archive entry")?,
            "OCI archive entry '{}' escapes the OCI layout",
            path.display()
        );
    }
    Ok(())
}

fn safe_archive_path(path: &Path) -> bool {
    let mut has_normal_component = false;
    for component in path.components() {
        match component {
            Component::Normal(_) => has_normal_component = true,
            Component::CurDir => {}
            Component::Prefix(_) | Component::RootDir | Component::ParentDir => return false,
        }
    }
    has_normal_component
}

fn read_oci_manifest_reference(layout_dir: &Path) -> Result<(String, String)> {
    let index_path = layout_dir.join("index.json");
    let index: OciIndex = serde_json::from_slice(
        &fs::read(&index_path)
            .with_context(|| format!("failed to read OCI index '{}'", index_path.display()))?,
    )
    .with_context(|| format!("failed to parse OCI index '{}'", index_path.display()))?;
    let descriptor = index
        .manifests
        .iter()
        .find(|descriptor| {
            descriptor
                .annotations
                .get(OCI_REF_NAME_ANNOTATION)
                .is_some_and(|name| name == OCI_IMAGE_TAG)
        })
        .context("OCI export has no latest image reference")?;
    let digest = descriptor
        .digest
        .strip_prefix("sha256:")
        .filter(|digest| is_sha256_hex(digest))
        .context("OCI export has an invalid manifest digest")?;
    Ok((format!("sha256:{digest}"), OCI_IMAGE_TAG.to_string()))
}

fn run_umoci_unpack(
    config: &QemuBuildConfig,
    layout_dir: &Path,
    image_tag: &str,
    bundle_dir: &Path,
) -> Result<()> {
    ensure!(
        image_tag == OCI_IMAGE_TAG,
        "OCI export has unexpected image reference '{image_tag}'"
    );
    run_command(
        &config.layered.umoci_binary,
        &[
            "unpack".to_string(),
            "--image".to_string(),
            format!("{}:{image_tag}", layout_dir.display()),
            bundle_dir.display().to_string(),
        ],
        None,
    )
    .context("umoci OCI rootfs unpack failed")
}

fn write_oci_neutral_host_files(rootfs: &Path) -> Result<()> {
    let etc = rootfs.join("etc");
    fs::create_dir_all(&etc).with_context(|| {
        format!(
            "failed to create OCI rootfs etc directory '{}'",
            etc.display()
        )
    })?;
    replace_rootfs_file(&etc.join("hostname"), OCI_NEUTRAL_HOSTNAME)?;
    replace_rootfs_file(&etc.join("hosts"), OCI_NEUTRAL_HOSTS)?;
    let resolv_conf = etc.join("resolv.conf");
    match fs::remove_file(&resolv_conf) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| {
            format!(
                "failed to remove OCI rootfs resolver '{}'",
                resolv_conf.display()
            )
        }),
    }
}

fn remove_container_policy_rc_d(rootfs: &Path) -> Result<()> {
    let path = rootfs.join("usr/sbin/policy-rc.d");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(error).with_context(|| {
                format!("failed to inspect OCI service policy '{}'", path.display())
            });
        }
    };
    if !metadata.file_type().is_file() {
        return Ok(());
    }
    let policy = fs::read(&path)
        .with_context(|| format!("failed to read OCI service policy '{}'", path.display()))?;
    if !is_container_policy_rc_d(&policy) {
        return Ok(());
    }
    fs::remove_file(&path)
        .with_context(|| format!("failed to remove container policy '{}'", path.display()))
}

fn is_container_policy_rc_d(policy: &[u8]) -> bool {
    let policy = String::from_utf8_lossy(policy).to_ascii_lowercase();
    let commands = policy
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect::<Vec<_>>();
    let documented_container_policy = (policy.contains("for most docker users")
        || policy.contains("docker build"))
        && policy.contains("exit 101");
    documented_container_policy || commands == ["exit 101"]
}

fn replace_rootfs_file(path: &Path, contents: &str) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => {
            bail!("OCI rootfs host path '{}' is a directory", path.display());
        }
        Ok(_) => fs::remove_file(path)
            .with_context(|| format!("failed to replace OCI rootfs file '{}'", path.display()))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error).with_context(|| {
                format!("failed to inspect OCI rootfs file '{}'", path.display())
            });
        }
    }
    fs::write(path, contents)
        .with_context(|| format!("failed to write OCI rootfs file '{}'", path.display()))?;
    set_neutral_host_file_mode(path)
}

#[cfg(unix)]
fn set_neutral_host_file_mode(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt as _;

    fs::set_permissions(path, fs::Permissions::from_mode(0o644))
        .with_context(|| format!("failed to chmod OCI rootfs file '{}'", path.display()))
}

#[cfg(not(unix))]
fn set_neutral_host_file_mode(_path: &Path) -> Result<()> {
    Ok(())
}

fn run_command(binary: &Path, args: &[String], current_dir: Option<&Path>) -> Result<()> {
    let mut command = Command::new(binary);
    command
        .args(args)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    if let Some(current_dir) = current_dir {
        command.current_dir(current_dir);
    }
    let status = command
        .status()
        .with_context(|| format!("failed to execute '{}'", binary.display()))?;
    if status.success() {
        return Ok(());
    }
    bail!("command '{}' failed with status {status}", binary.display())
}

fn converted_cache_key(
    manifest_digest: &str,
    filesystem_size_bytes: u64,
    kernel_sha256: &str,
    initrd_sha256: &str,
    bootstrap_ca_bundle_sha256: &str,
) -> String {
    let identity = format!(
        "abi={OCI_BASE_CACHE_ABI}\noci_manifest={manifest_digest}\nfilesystem=ext4\nlabel={BASE_EXT4_LABEL}\nsize={filesystem_size_bytes}\nkernel={kernel_sha256}\ninitrd={initrd_sha256}\nbootstrap_ca={bootstrap_ca_bundle_sha256}"
    );
    sha256_bytes_hex(identity.as_bytes())
}

fn converted_artifact_dir(cache_root: &Path, cache_key: &str) -> PathBuf {
    cache_root.join("converted").join(cache_key)
}

fn cache_entry_lock_path(cache_root: &Path, cache_key: &str) -> PathBuf {
    cache_root.join("locks").join(format!("{cache_key}.lock"))
}

fn cached_base_rootfs_artifact(
    cache_root: &Path,
    plan: &RootfsBuildPlan,
    record: &BaseArtifactRecord,
) -> Result<BaseRootfsArtifact> {
    let lease = shared_cache_entry_lease(cache_root, &record.cache_key)?;
    let directory = converted_artifact_dir(cache_root, &record.cache_key);
    Ok(BaseRootfsArtifact {
        base_ext4_path: directory.join(ROOTFS_FILE),
        kernel_path: directory.join(KERNEL_FILE),
        initrd_path: directory.join(INITRD_FILE),
        definition_hash: plan.definition_hash.clone(),
        lease: Arc::new(BaseRootfsLease::Cache { _lock: lease }),
    })
}

fn shared_cache_entry_lease(cache_root: &Path, cache_key: &str) -> Result<fs::File> {
    let path = cache_entry_lock_path(cache_root, cache_key);
    let parent = path.parent().context("OCI entry lock has no parent")?;
    fs::create_dir_all(parent)
        .with_context(|| format!("failed to create OCI entry locks '{}'", parent.display()))?;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .with_context(|| format!("failed to open OCI entry lock '{}'", path.display()))?;
    lock.lock_shared()
        .with_context(|| format!("failed to lease OCI cache entry '{}'", cache_key))?;
    Ok(lock)
}

fn definition_record_path(cache_root: &Path, definition_hash: &str) -> PathBuf {
    cache_root
        .join("definitions")
        .join(format!("{definition_hash}.json"))
}

fn read_definition_record(
    cache_root: &Path,
    definition_hash: &str,
) -> Result<Option<BaseArtifactRecord>> {
    let path = definition_record_path(cache_root, definition_hash);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| {
                format!("failed to read OCI definition cache '{}'", path.display())
            });
        }
    };
    match serde_json::from_slice::<BaseArtifactRecord>(&bytes) {
        Ok(record) if record.definition_hash == definition_hash && record_is_coherent(&record) => {
            Ok(Some(record))
        }
        Ok(_) | Err(_) => Ok(None),
    }
}

fn publish_cached_artifact(
    cache_root: &Path,
    plan: &RootfsBuildPlan,
    staging: &OciStagingPaths,
    record: &BaseArtifactRecord,
    config: &QemuBuildConfig,
    bootstrap_ca_bundle_sha256: &str,
) -> Result<BaseRootfsArtifact> {
    let staged_bytes = directory_size(&staging.artifact_dir)?;
    let budget = converted_cache_budget(config.layered.oci_cache_bytes);
    if staged_bytes > budget {
        return publish_private_artifact(config, staging, record);
    }
    prune_oci_cache(cache_root, budget.saturating_sub(staged_bytes))?;

    let cached_dir = converted_artifact_dir(cache_root, &record.cache_key);
    if layered_artifact_dir_is_valid(
        &cached_dir,
        record,
        &plan.definition_hash,
        bootstrap_ca_bundle_sha256,
    )? {
        touch_cache_entry(&cached_dir)?;
        return cached_base_rootfs_artifact(cache_root, plan, record);
    }
    if cached_dir.exists() {
        let Some(_entry_lock) = try_exclusive_cache_entry_lock(cache_root, &record.cache_key)?
        else {
            return publish_private_artifact(config, staging, record);
        };
        fs::remove_dir_all(&cached_dir).with_context(|| {
            format!(
                "failed to remove invalid OCI converted cache '{}'",
                cached_dir.display()
            )
        })?;
    }
    if let Some(parent) = cached_dir.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "failed to create OCI converted cache '{}'",
                parent.display()
            )
        })?;
    }
    write_artifact_record(&staging.artifact_dir, record)?;
    sync_artifact_files(&staging.artifact_dir)?;
    fs::rename(&staging.artifact_dir, &cached_dir).with_context(|| {
        format!(
            "failed to publish OCI converted cache '{}'",
            cached_dir.display()
        )
    })?;
    write_definition_record(cache_root, record)?;
    touch_cache_entry(&cached_dir)?;
    cached_base_rootfs_artifact(cache_root, plan, record)
}

fn write_artifact_record(directory: &Path, record: &BaseArtifactRecord) -> Result<()> {
    write_json_atomic(&directory.join(METADATA_FILE), record)
}

fn write_definition_record(cache_root: &Path, record: &BaseArtifactRecord) -> Result<()> {
    write_json_atomic(
        &definition_record_path(cache_root, &record.definition_hash),
        record,
    )
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path.parent().context("cache record has no parent")?;
    fs::create_dir_all(parent).with_context(|| {
        format!(
            "failed to create cache record parent '{}'",
            parent.display()
        )
    })?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .context("cache record has no UTF-8 file name")?;
    let sequence = OCI_BUILD_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let staging = parent.join(format!(
        ".{file_name}.tmp-{}-{sequence}",
        std::process::id()
    ));
    let result = (|| -> Result<()> {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&staging)
            .with_context(|| format!("failed to create cache record '{}'", staging.display()))?;
        serde_json::to_writer_pretty(&mut file, value)
            .context("failed to serialize OCI cache record")?;
        file.write_all(b"\n")
            .context("failed to terminate OCI cache record")?;
        file.sync_all()
            .with_context(|| format!("failed to sync cache record '{}'", staging.display()))?;
        fs::rename(&staging, path)
            .with_context(|| format!("failed to publish cache record '{}'", path.display()))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staging);
    }
    result
}

fn sync_artifact_files(directory: &Path) -> Result<()> {
    for file in [ROOTFS_FILE, KERNEL_FILE, INITRD_FILE, METADATA_FILE] {
        let path = directory.join(file);
        fs::File::open(&path)
            .with_context(|| format!("failed to open staged OCI artifact '{}'", path.display()))?
            .sync_all()
            .with_context(|| format!("failed to sync staged OCI artifact '{}'", path.display()))?;
    }
    Ok(())
}

fn layered_artifact_dir_is_valid(
    directory: &Path,
    record: &BaseArtifactRecord,
    definition_hash: &str,
    bootstrap_ca_bundle_sha256: &str,
) -> Result<bool> {
    if !record_is_coherent(record)
        || record.definition_hash != definition_hash
        || record.bootstrap_ca_bundle_sha256 != bootstrap_ca_bundle_sha256
    {
        return Ok(false);
    }
    let metadata_path = directory.join(METADATA_FILE);
    let stored_record = match fs::read(&metadata_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<BaseArtifactRecord>(&bytes).ok())
    {
        Some(stored_record) => stored_record,
        None => return Ok(false),
    };
    if stored_record != *record {
        return Ok(false);
    }
    let rootfs = directory.join(ROOTFS_FILE);
    let kernel = directory.join(KERNEL_FILE);
    let initrd = directory.join(INITRD_FILE);
    if !regular_file(&rootfs) || !regular_file(&kernel) || !regular_file(&initrd) {
        return Ok(false);
    }
    if fs::metadata(&rootfs)?.len() != record.filesystem_size_bytes {
        return Ok(false);
    }
    let root_hash = match sha256_file_hex(&rootfs) {
        Ok(hash) => hash,
        Err(_) => return Ok(false),
    };
    let kernel_hash = match sha256_file_hex(&kernel) {
        Ok(hash) => hash,
        Err(_) => return Ok(false),
    };
    let initrd_hash = match sha256_file_hex(&initrd) {
        Ok(hash) => hash,
        Err(_) => return Ok(false),
    };
    Ok(root_hash == record.root_ext4_sha256
        && kernel_hash == record.kernel_sha256
        && initrd_hash == record.initrd_sha256)
}

fn record_is_coherent(record: &BaseArtifactRecord) -> bool {
    record.abi == OCI_BASE_CACHE_ABI
        && is_digest(&record.oci_manifest_digest)
        && is_sha256_hex(&record.root_ext4_sha256)
        && is_sha256_hex(&record.kernel_sha256)
        && is_sha256_hex(&record.initrd_sha256)
        && is_sha256_hex(&record.bootstrap_ca_bundle_sha256)
        && record.cache_key
            == converted_cache_key(
                &record.oci_manifest_digest,
                record.filesystem_size_bytes,
                &record.kernel_sha256,
                &record.initrd_sha256,
                &record.bootstrap_ca_bundle_sha256,
            )
}

fn regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_file())
        .unwrap_or(false)
}

fn is_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(is_sha256_hex)
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn touch_cache_entry(directory: &Path) -> Result<()> {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    fs::write(directory.join(LAST_USED_FILE), seconds.to_string()).with_context(|| {
        format!(
            "failed to update OCI cache use marker in '{}'",
            directory.display()
        )
    })
}

fn prune_oci_cache(cache_root: &Path, budget: u64) -> Result<()> {
    let converted_root = cache_root.join("converted");
    if !converted_root.is_dir() {
        return Ok(());
    }
    let mut used = directory_size(&converted_root)?;
    if used <= budget {
        return Ok(());
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(&converted_root).with_context(|| {
        format!(
            "failed to read OCI converted cache '{}'",
            converted_root.display()
        )
    })? {
        let path = entry
            .with_context(|| format!("failed to read '{}'", converted_root.display()))?
            .path();
        if path.is_dir() {
            entries.push((cache_entry_age(&path), directory_size(&path)?, path));
        }
    }
    entries.sort_by_key(|(age, _, _)| *age);
    for (_, size, path) in entries {
        if used <= budget {
            break;
        }
        let Some(cache_key) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !is_sha256_hex(cache_key) {
            continue;
        }
        let Some(_entry_lock) = try_exclusive_cache_entry_lock(cache_root, cache_key)? else {
            continue;
        };
        fs::remove_dir_all(&path)
            .with_context(|| format!("failed to evict OCI cache '{}'", path.display()))?;
        used = used.saturating_sub(size);
    }
    Ok(())
}

fn try_exclusive_cache_entry_lock(cache_root: &Path, cache_key: &str) -> Result<Option<fs::File>> {
    let path = cache_entry_lock_path(cache_root, cache_key);
    let parent = path.parent().context("OCI entry lock has no parent")?;
    fs::create_dir_all(parent)
        .with_context(|| format!("failed to create OCI entry locks '{}'", parent.display()))?;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .with_context(|| format!("failed to open OCI entry lock '{}'", path.display()))?;
    match lock.try_lock_exclusive() {
        Ok(()) => Ok(Some(lock)),
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(None),
        Err(error) => {
            Err(error).with_context(|| format!("failed to lock OCI cache entry '{}'", cache_key))
        }
    }
}

fn cache_entry_age(path: &Path) -> u64 {
    fs::read_to_string(path.join(LAST_USED_FILE))
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(0)
}

fn directory_size(path: &Path) -> Result<u64> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("failed to stat cache path '{}'", path.display()))?;
    if metadata.file_type().is_symlink() {
        return Ok(0);
    }
    if metadata.is_file() {
        return Ok(metadata.len());
    }
    if !metadata.is_dir() {
        return Ok(0);
    }
    let mut size = 0_u64;
    for entry in fs::read_dir(path)
        .with_context(|| format!("failed to read cache path '{}'", path.display()))?
    {
        size = size.saturating_add(directory_size(
            &entry
                .with_context(|| format!("failed to read cache path '{}'", path.display()))?
                .path(),
        )?);
    }
    Ok(size)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt as _;

    use intar_image_scenario::BaseImageCatalog;
    use tar::{Archive, Builder, EntryType, Header};

    use super::{
        BaseArtifactRecord, BootstrapCaBundle, HOST_CA_BUNDLE_FILE, INITRD_FILE, KERNEL_FILE,
        METADATA_FILE, OCI_BASE_CACHE_ABI, OCI_NEUTRAL_HOSTNAME, OCI_NEUTRAL_HOSTS, ROOTFS_FILE,
        bootstrap_ca_bundle_from_bytes, cached_base_rootfs_artifact, converted_artifact_dir,
        converted_cache_key, finalize_private_staging, layered_artifact_dir_is_valid,
        layered_definition_hash, private_artifact_directory, prune_oci_cache,
        read_oci_manifest_reference, remove_container_policy_rc_d, render_buildctl_args,
        render_oci_dockerfile, staged_paths, unpack_oci_archive, write_artifact_record,
        write_oci_build_context, write_oci_neutral_host_files,
    };
    use crate::config::QemuBuildConfig;
    use crate::content_hash::sha256_bytes_hex;
    use crate::rootfs::render_rootfs_build_plan;

    fn base_image() -> intar_image_scenario::BaseImageSpec {
        let catalog = BaseImageCatalog::parse(
            r#"
base_image "trixie" {
  suite          = "trixie"
  mirror         = "https://deb.debian.org/debian"
  arch           = "amd64"
  kernel_package = "linux-image-cloud-amd64"
  packages       = ["acpid", "openssh-server", "ca-certificates", "curl", "iproute2", "e2fsprogs", "kmod", "systemd-sysv", "udev", "sudo"]
}
"#,
        )
        .unwrap();
        catalog.base_image_by_name("trixie").unwrap().clone()
    }

    fn layered_config(root: &std::path::Path) -> QemuBuildConfig {
        let mut config = QemuBuildConfig {
            output_root: root.join("dist"),
            work_root: root.join("work"),
            ..QemuBuildConfig::default()
        };
        config.layered.oci_cache_root = Some(root.join("oci-cache"));
        config.layered.minimum_free_bytes = 0;
        config.layered.oci_cache_bytes = 8 * 1024 * 1024;
        config
    }

    #[test]
    fn dockerfile_uses_a_pinned_debian_base_and_current_bootstrap_contract() {
        let root = tempfile::tempdir().unwrap();
        let base = base_image();
        let dockerfile = render_oci_dockerfile(&base, &layered_config(root.path())).unwrap();

        assert!(!dockerfile.starts_with("# syntax="));
        assert!(dockerfile.contains("FROM docker.io/library/debian@sha256:"));
        let ca_copy = dockerfile
            .find("COPY intar-host-ca-certificates.crt /etc/ssl/certs/ca-certificates.crt")
            .unwrap();
        let apt_update = dockerfile.find("APT::Update::Error-Mode=any").unwrap();
        assert!(ca_copy < apt_update);
        assert_eq!(dockerfile.matches("Acquire::https::CaInfo=").count(), 2);
        assert!(dockerfile.contains("COPY --chmod=0755 intar-essential-hook.sh"));
        assert!(dockerfile.contains("COPY --chmod=0755 intar-customize-hook.sh"));
        assert!(dockerfile.contains("linux-image-cloud-amd64"));
        assert!(dockerfile.contains("systemd-sysv"));
        assert!(dockerfile.contains("openssh-server"));
        assert!(dockerfile.contains("apt-get"));
        assert!(dockerfile.contains("update-ca-certificates\",\"--fresh"));
        assert!(dockerfile.contains("/var/lib/apt/lists/*"));
        assert!(dockerfile.contains("essential-hook.sh\",\"/\""));
        assert!(dockerfile.contains("customize-hook.sh\",\"/\""));
    }

    #[test]
    fn oci_unpack_replaces_buildkit_host_mount_files_with_neutral_vm_files() {
        let root = tempfile::tempdir().unwrap();
        let etc = root.path().join("etc");
        fs::create_dir_all(&etc).unwrap();
        fs::write(etc.join("hostname"), "builder-host\n").unwrap();
        fs::write(etc.join("hosts"), "10.0.0.9 builder-host\n").unwrap();
        fs::write(etc.join("resolv.conf"), "nameserver 10.0.0.53\n").unwrap();

        write_oci_neutral_host_files(root.path()).unwrap();

        assert_eq!(
            fs::read_to_string(etc.join("hostname")).unwrap(),
            OCI_NEUTRAL_HOSTNAME
        );
        assert_eq!(
            fs::read_to_string(etc.join("hosts")).unwrap(),
            OCI_NEUTRAL_HOSTS
        );
        assert!(!etc.join("resolv.conf").exists());
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(etc.join("hostname"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o644
        );
    }

    #[test]
    fn oci_unpack_removes_only_the_container_service_start_policy() {
        let root = tempfile::tempdir().unwrap();
        let policy_dir = root.path().join("usr/sbin");
        fs::create_dir_all(&policy_dir).unwrap();
        let policy = policy_dir.join("policy-rc.d");
        fs::write(
            &policy,
            "#!/bin/sh\n# For most Docker users, apt installs run during docker build.\nexit 101\n",
        )
        .unwrap();

        remove_container_policy_rc_d(root.path()).unwrap();
        assert!(!policy.exists());

        fs::write(&policy, "#!/bin/sh\nexit 101\n").unwrap();
        remove_container_policy_rc_d(root.path()).unwrap();
        assert!(!policy.exists());

        fs::write(&policy, "#!/bin/sh\nexit 0\n").unwrap();
        remove_container_policy_rc_d(root.path()).unwrap();
        assert!(policy.is_file());
    }

    #[test]
    fn oci_context_writes_only_the_supplied_public_ca_bundle() {
        let root = tempfile::tempdir().unwrap();
        let context = root.path().join("context");
        fs::create_dir_all(&context).unwrap();
        let base = base_image();
        let config = layered_config(root.path());
        let plan = render_rootfs_build_plan(&base, &config);
        let bytes =
            b"-----BEGIN CERTIFICATE-----\npublic test certificate\n-----END CERTIFICATE-----\n"
                .to_vec();
        let ca_bundle = BootstrapCaBundle {
            sha256: sha256_bytes_hex(&bytes),
            bytes,
        };

        write_oci_build_context(&base, &config, &plan, &context, &ca_bundle).unwrap();

        assert_eq!(
            fs::read(context.join(HOST_CA_BUNDLE_FILE)).unwrap(),
            ca_bundle.bytes
        );
    }

    #[test]
    fn bootstrap_ca_bundle_rejects_private_key_material() {
        let path = std::path::Path::new("/test/ca-certificates.crt");
        let error = bootstrap_ca_bundle_from_bytes(
            path,
            b"-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n".to_vec(),
        )
        .unwrap_err();

        assert!(format!("{error:#}").contains("contains a private key"));
    }

    #[test]
    fn layered_definition_hash_covers_the_pinned_base_and_generated_hooks() {
        let root = tempfile::tempdir().unwrap();
        let base = base_image();
        let config = layered_config(root.path());
        let original = layered_definition_hash(&base, "essential", "customize", &config);

        let mut changed_image = config.clone();
        changed_image.layered.debian_image =
            format!("docker.io/library/debian@sha256:{}", "b".repeat(64));
        assert_ne!(
            original,
            layered_definition_hash(&base, "essential", "customize", &changed_image)
        );
        assert_ne!(
            original,
            layered_definition_hash(&base, "changed-essential", "customize", &config)
        );
        assert_ne!(
            original,
            layered_definition_hash(&base, "essential", "changed-customize", &config)
        );
        let mut changed_mke2fs = config.clone();
        changed_mke2fs.mke2fs_binary = "/opt/intar/mke2fs".into();
        assert_ne!(
            original,
            layered_definition_hash(&base, "essential", "customize", &changed_mke2fs)
        );
    }

    #[test]
    fn buildctl_plan_exports_an_oci_archive_through_the_isolated_builder_socket() {
        let root = tempfile::tempdir().unwrap();
        let base = base_image();
        let config = layered_config(root.path());
        let plan = render_rootfs_build_plan(&base, &config);
        let artifact_parent = plan.paths.base_ext4_path.parent().unwrap();
        let staging = staged_paths(&plan, artifact_parent, "base").unwrap();

        let no_cache = render_buildctl_args(&base, &config, &staging, false);
        assert!(no_cache.iter().any(|arg| arg == "--no-cache"));
        assert!(
            no_cache
                .iter()
                .any(|arg| arg.contains("type=oci,name=intar-base:latest"))
        );
        assert!(no_cache.iter().any(|arg| arg == "platform=linux/amd64"));
        assert!(
            no_cache
                .iter()
                .any(|arg| arg.ends_with("oci-cache/buildkitd.sock"))
        );

        let with_cache = render_buildctl_args(&base, &config, &staging, true);
        assert!(!with_cache.iter().any(|arg| arg == "--no-cache"));
        assert!(!with_cache.iter().any(|arg| arg == "--export-cache"));
    }

    #[test]
    fn oci_index_requires_the_exported_latest_reference() {
        let root = tempfile::tempdir().unwrap();
        let digest = format!("sha256:{}", "a".repeat(64));
        fs::write(
            root.path().join("index.json"),
            format!(
                r#"{{"schemaVersion":2,"manifests":[{{"digest":"{digest}","annotations":{{"org.opencontainers.image.ref.name":"latest"}}}}]}}"#
            ),
        )
        .unwrap();

        assert_eq!(
            read_oci_manifest_reference(root.path()).unwrap(),
            (digest, "latest".to_string())
        );

        fs::write(
            root.path().join("index.json"),
            format!(
                r#"{{"schemaVersion":2,"manifests":[{{"digest":"sha256:{}"}}]}}"#,
                "a".repeat(64)
            ),
        )
        .unwrap();
        assert!(read_oci_manifest_reference(root.path()).is_err());
    }

    #[test]
    fn oci_archive_extraction_preserves_whiteout_layer_blobs() {
        let root = tempfile::tempdir().unwrap();
        let archive_path = root.path().join("image.oci.tar");
        let mut layer = Vec::new();
        {
            let mut builder = Builder::new(&mut layer);
            let mut header = Header::new_gnu();
            header.set_size(0);
            header.set_mode(0o600);
            header.set_entry_type(EntryType::character_special());
            header.set_device_major(0).unwrap();
            header.set_device_minor(0).unwrap();
            header.set_cksum();
            builder
                .append_data(&mut header, "etc/.wh.removed", std::io::empty())
                .unwrap();
            builder.finish().unwrap();
        }
        let layer_digest = sha256_bytes_hex(&layer);
        {
            let archive = fs::File::create(&archive_path).unwrap();
            let mut builder = Builder::new(archive);
            let mut header = Header::new_gnu();
            header.set_size(layer.len() as u64);
            header.set_mode(0o600);
            header.set_cksum();
            builder
                .append_data(
                    &mut header,
                    format!("blobs/sha256/{layer_digest}"),
                    &layer[..],
                )
                .unwrap();
            builder.finish().unwrap();
        }

        let layout = root.path().join("layout");
        unpack_oci_archive(&archive_path, &layout).unwrap();
        let layer_path = layout.join(format!("blobs/sha256/{layer_digest}"));
        let mut layer = Archive::new(fs::File::open(&layer_path).unwrap());
        let mut entries = layer.entries().unwrap();
        let entry = entries.next().unwrap().unwrap();
        assert_eq!(
            entry.path().unwrap(),
            std::path::Path::new("etc/.wh.removed")
        );
        assert!(entry.header().entry_type().is_character_special());
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(&layer_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn converted_key_binds_oci_digest_filesystem_and_boot_artifacts() {
        let manifest = format!("sha256:{}", "a".repeat(64));
        let kernel = "b".repeat(64);
        let initrd = "c".repeat(64);
        let bootstrap_ca = "d".repeat(64);
        let original = converted_cache_key(
            &manifest,
            384 * 1024 * 1024,
            &kernel,
            &initrd,
            &bootstrap_ca,
        );

        assert_ne!(
            original,
            converted_cache_key(
                &format!("sha256:{}", "d".repeat(64)),
                384 * 1024 * 1024,
                &kernel,
                &initrd,
                &bootstrap_ca,
            )
        );
        assert_ne!(
            original,
            converted_cache_key(
                &manifest,
                512 * 1024 * 1024,
                &kernel,
                &initrd,
                &bootstrap_ca,
            )
        );
        assert_ne!(
            original,
            converted_cache_key(
                &manifest,
                384 * 1024 * 1024,
                &"e".repeat(64),
                &initrd,
                &bootstrap_ca,
            )
        );
        assert_ne!(
            original,
            converted_cache_key(
                &manifest,
                384 * 1024 * 1024,
                &kernel,
                &"f".repeat(64),
                &bootstrap_ca,
            )
        );
        assert_ne!(
            original,
            converted_cache_key(
                &manifest,
                384 * 1024 * 1024,
                &kernel,
                &initrd,
                &"e".repeat(64),
            )
        );
    }

    #[test]
    fn converted_artifact_is_verified_before_reuse() {
        let root = tempfile::tempdir().unwrap();
        let base = base_image();
        let config = layered_config(root.path());
        let plan = render_rootfs_build_plan(&base, &config);
        let source = root.path().join("converted");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join(ROOTFS_FILE), b"rootfs").unwrap();
        fs::write(source.join(KERNEL_FILE), b"kernel").unwrap();
        fs::write(source.join(INITRD_FILE), b"initrd").unwrap();
        let root_hash = sha256_bytes_hex(b"rootfs");
        let kernel_hash = sha256_bytes_hex(b"kernel");
        let initrd_hash = sha256_bytes_hex(b"initrd");
        let bootstrap_ca_hash = "d".repeat(64);
        let manifest = format!("sha256:{}", "a".repeat(64));
        let record = BaseArtifactRecord {
            abi: OCI_BASE_CACHE_ABI.to_string(),
            definition_hash: plan.definition_hash.clone(),
            oci_manifest_digest: manifest.clone(),
            cache_key: converted_cache_key(
                &manifest,
                6,
                &kernel_hash,
                &initrd_hash,
                &bootstrap_ca_hash,
            ),
            filesystem_size_bytes: 6,
            root_ext4_sha256: root_hash,
            kernel_sha256: kernel_hash,
            initrd_sha256: initrd_hash,
            bootstrap_ca_bundle_sha256: bootstrap_ca_hash.clone(),
        };
        write_artifact_record(&source, &record).unwrap();
        assert!(source.join(METADATA_FILE).is_file());
        assert!(
            layered_artifact_dir_is_valid(
                &source,
                &record,
                &plan.definition_hash,
                &bootstrap_ca_hash,
            )
            .unwrap()
        );

        fs::write(source.join(METADATA_FILE), b"corrupt metadata").unwrap();
        assert!(
            !layered_artifact_dir_is_valid(
                &source,
                &record,
                &plan.definition_hash,
                &bootstrap_ca_hash,
            )
            .unwrap()
        );
        write_artifact_record(&source, &record).unwrap();
        fs::write(source.join(ROOTFS_FILE), b"corrupt").unwrap();
        assert!(
            !layered_artifact_dir_is_valid(
                &source,
                &record,
                &plan.definition_hash,
                &bootstrap_ca_hash,
            )
            .unwrap()
        );
    }

    #[test]
    fn active_base_lease_prevents_converted_cache_eviction() {
        let root = tempfile::tempdir().unwrap();
        let base = base_image();
        let config = layered_config(root.path());
        let plan = render_rootfs_build_plan(&base, &config);
        let cache_root = config.layered.oci_cache_root.clone().unwrap();
        let manifest = format!("sha256:{}", "a".repeat(64));
        let root_hash = sha256_bytes_hex(b"rootfs");
        let kernel_hash = sha256_bytes_hex(b"kernel");
        let initrd_hash = sha256_bytes_hex(b"initrd");
        let bootstrap_ca_hash = "d".repeat(64);
        let cache_key =
            converted_cache_key(&manifest, 6, &kernel_hash, &initrd_hash, &bootstrap_ca_hash);
        let source = converted_artifact_dir(&cache_root, &cache_key);
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join(ROOTFS_FILE), b"rootfs").unwrap();
        fs::write(source.join(KERNEL_FILE), b"kernel").unwrap();
        fs::write(source.join(INITRD_FILE), b"initrd").unwrap();
        let record = BaseArtifactRecord {
            abi: OCI_BASE_CACHE_ABI.to_string(),
            definition_hash: plan.definition_hash.clone(),
            oci_manifest_digest: manifest,
            cache_key,
            filesystem_size_bytes: 6,
            root_ext4_sha256: root_hash,
            kernel_sha256: kernel_hash,
            initrd_sha256: initrd_hash,
            bootstrap_ca_bundle_sha256: bootstrap_ca_hash,
        };
        write_artifact_record(&source, &record).unwrap();

        let artifact = cached_base_rootfs_artifact(&cache_root, &plan, &record).unwrap();
        prune_oci_cache(&cache_root, 0).unwrap();
        assert!(source.is_dir());

        drop(artifact);
        prune_oci_cache(&cache_root, 0).unwrap();
        assert!(!source.exists());
    }

    #[test]
    fn private_base_artifact_stays_alive_until_its_lease_is_dropped() {
        let root = tempfile::tempdir().unwrap();
        let base = base_image();
        let config = layered_config(root.path());
        let plan = render_rootfs_build_plan(&base, &config);
        let private_dir = private_artifact_directory(&config).unwrap();
        let staging = staged_paths(&plan, private_dir.path(), "base").unwrap();
        fs::create_dir_all(&staging.artifact_dir).unwrap();
        fs::write(staging.artifact_dir.join(ROOTFS_FILE), b"rootfs").unwrap();
        fs::write(staging.artifact_dir.join(KERNEL_FILE), b"kernel").unwrap();
        fs::write(staging.artifact_dir.join(INITRD_FILE), b"initrd").unwrap();
        let root_hash = sha256_bytes_hex(b"rootfs");
        let kernel_hash = sha256_bytes_hex(b"kernel");
        let initrd_hash = sha256_bytes_hex(b"initrd");
        let bootstrap_ca_hash = "d".repeat(64);
        let manifest = format!("sha256:{}", "a".repeat(64));
        let record = BaseArtifactRecord {
            abi: OCI_BASE_CACHE_ABI.to_string(),
            definition_hash: plan.definition_hash.clone(),
            oci_manifest_digest: manifest.clone(),
            cache_key: converted_cache_key(
                &manifest,
                6,
                &kernel_hash,
                &initrd_hash,
                &bootstrap_ca_hash,
            ),
            filesystem_size_bytes: 6,
            root_ext4_sha256: root_hash,
            kernel_sha256: kernel_hash,
            initrd_sha256: initrd_hash,
            bootstrap_ca_bundle_sha256: bootstrap_ca_hash,
        };

        let artifact = finalize_private_staging(&staging, &record, private_dir).unwrap();
        let artifact_path = artifact.base_ext4_path.clone();
        let lease = artifact.lease.clone();
        assert_ne!(artifact_path, plan.paths.base_ext4_path);
        drop(artifact);
        assert!(artifact_path.is_file());

        drop(lease);
        assert!(!artifact_path.exists());
    }
}
