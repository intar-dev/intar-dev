//! The cache layout, the launch-ready descriptor of a prepared image, and
//! what a pulled machine config must say before jailerd sees it.

use std::collections::HashMap;
use std::sync::Mutex as StdMutex;

use intar_contracts::guest::GUEST_CONTRACT;
use intar_contracts::oci::{IMAGE_FORMAT, MachineConfigV1, OciManifestV1, WakeV1};
use intar_jailer_protocol::{WAKE_CPU_PROFILE_FILE, WAKE_RAM_FILE, WAKE_STUB_FILE, WakeArtifacts};

use crate::config::WakeConfig;

use super::*;

/// The descriptor's `schema_version`. Version 1 lived in `launch-v3/`.
const READY_DESCRIPTOR_SCHEMA_VERSION: u8 = 2;

/// Directories under the cache root this layout uses; the startup sweep
/// removes every other one.
const CACHE_LAYOUT_DIRS: [&str; 3] = ["oci", "launch", ".capabilities"];

/// `launch/<image hex>.ready.json`: the image jailerd prepared, and how to
/// boot it.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct ReadyDescriptorV2 {
    schema_version: u8,
    image: OciDigest,
    config: OciDigest,
    kernel: OciDigest,
    initrd: Option<OciDigest>,
    cmdline: String,
    disk_size_bytes: u64,
    prepared_image: PreparedImageV3Result,
    /// The image's suspended guest, whether or not it was prepared.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    wake: Option<WakeV1>,
}

/// A prepared image a VM can launch from.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ReadyImage {
    pub(crate) image: OciDigest,
    pub(crate) cmdline: String,
    pub(crate) disk_size_bytes: u64,
    pub(crate) prepared_image: PreparedImageV3Result,
    /// The machine config's `wake`; `prepared_image.wake` says whether its
    /// files were prepared.
    pub(crate) wake: Option<WakeV1>,
}

/// Whether this host wants an image's suspended guest prepared: wake is on
/// and the image's CPU profile is one the operator pinned here.
pub(super) fn wants_wake(wake: &WakeConfig, config: &MachineConfigV1) -> bool {
    wake.enabled
        && config
            .wake
            .as_ref()
            .is_some_and(|image| wake.profiles.contains(&image.cpu_profile))
}

/// jailerd's wake descriptors of an image: its own template files, the RAM
/// writable, each with a digest.
pub(crate) fn check_prepared_wake(image_hex: &str, wake: &WakeArtifacts) -> Result<()> {
    for (source, file_name, access) in [
        (&wake.ram, WAKE_RAM_FILE, ArtifactAccess::ReadWrite),
        (&wake.stub, WAKE_STUB_FILE, ArtifactAccess::ReadOnly),
        (
            &wake.cpu_profile,
            WAKE_CPU_PROFILE_FILE,
            ArtifactAccess::ReadOnly,
        ),
    ] {
        anyhow::ensure!(
            source.source_root == PREPARED_IMAGE_SOURCE_ROOT
                && source.relative_path == PathBuf::from(image_hex).join(file_name)
                && source.sha256.is_some()
                && source.access == access,
            "prepared wake {file_name} source mismatch"
        );
    }
    Ok(())
}

fn descriptor_path(cache_root: &Path, image: &OciDigest) -> PathBuf {
    cache_root
        .join("launch")
        .join(format!("{}.ready.json", image.hex()))
}

/// Refuse an image this agent's Kino contract cannot boot.
pub(crate) fn check_machine_config(config: &MachineConfigV1) -> Result<()> {
    anyhow::ensure!(
        config.guest_contract == GUEST_CONTRACT,
        "guest_contract_mismatch: the image speaks guest contract {}, this agent {GUEST_CONTRACT}",
        config.guest_contract
    );
    anyhow::ensure!(
        config.image_format == IMAGE_FORMAT,
        "unsupported_artifact: image format {:?}, this agent reads {IMAGE_FORMAT:?}",
        config.image_format
    );
    Ok(())
}

pub(crate) async fn mark_template_ready(
    cache_root: &Path,
    pulled: &PulledMachine,
    prepared: &PreparedImageV3Result,
) -> Result<()> {
    let descriptor = ReadyDescriptorV2 {
        schema_version: READY_DESCRIPTOR_SCHEMA_VERSION,
        image: pulled.image.clone(),
        config: pulled.manifest.config.digest.clone(),
        kernel: pulled.kernel.clone(),
        initrd: pulled.initrd.clone(),
        cmdline: pulled.config.boot.cmdline.clone(),
        disk_size_bytes: pulled.config.disk.size_bytes,
        prepared_image: prepared.clone(),
        wake: pulled.config.wake.clone(),
    };
    validate_descriptor(&pulled.image, descriptor.clone())?;
    let path = descriptor_path(cache_root, &pulled.image);
    let directory = path.parent().context("launch descriptor parent")?;
    tokio::fs::create_dir_all(directory).await?;
    let (temporary, mut output) =
        create_tmp_file(directory, &format!("{}.ready.json", pulled.image.hex())).await?;
    output.write_all(&serde_json::to_vec(&descriptor)?).await?;
    output.sync_all().await?;
    drop(output);
    tokio::fs::rename(temporary, path).await?;
    clear_image_failure(&pulled.image);
    Ok(())
}

pub(crate) async fn require_ready_image(
    cache_root: &Path,
    image: &OciDigest,
) -> Result<ReadyImage> {
    let bytes = tokio::fs::read(descriptor_path(cache_root, image))
        .await
        .context("the image's launch descriptor is unavailable")?;
    validate_descriptor(image, serde_json::from_slice(&bytes)?)
}

pub(crate) fn is_image_ready(cache_root: &Path, image: &OciDigest) -> bool {
    std::fs::read(descriptor_path(cache_root, image))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .is_some_and(|descriptor| validate_descriptor(image, descriptor).is_ok())
}

/// Whether the cache pass has work for a pinned image: it is not ready, or
/// this host wants its suspended guest, which was not prepared and has not
/// failed to prepare since this agent started.
pub(super) fn needs_prepare(cache_root: &Path, image: &OciDigest, wake: &WakeConfig) -> bool {
    let ready = std::fs::read(descriptor_path(cache_root, image))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .and_then(|descriptor| validate_descriptor(image, descriptor).ok());
    match ready {
        None => true,
        Some(ready) => {
            ready.prepared_image.wake.is_none()
                && wake.enabled
                && ready
                    .wake
                    .is_some_and(|guest| wake.profiles.contains(&guest.cpu_profile))
                && wake_prepare_failure(image).is_none()
        }
    }
}

fn validate_descriptor(image: &OciDigest, descriptor: ReadyDescriptorV2) -> Result<ReadyImage> {
    anyhow::ensure!(
        descriptor.schema_version == READY_DESCRIPTOR_SCHEMA_VERSION,
        "unsupported launch descriptor"
    );
    anyhow::ensure!(descriptor.image == *image, "stale launch descriptor");
    let prepared = &descriptor.prepared_image;
    anyhow::ensure!(
        prepared.image_id.as_str() == image.hex()
            && prepared.chunk_manifest_sha256.as_str() == descriptor.config.hex()
            && prepared.virtual_size_bytes == descriptor.disk_size_bytes
            && prepared.fast_template_store,
        "prepared image identity mismatch"
    );
    validate_prepared_source(
        &prepared.root_disk,
        image.hex(),
        "root.raw",
        image.hex(),
        ArtifactAccess::ReadWrite,
    )?;
    validate_prepared_source(
        &prepared.kernel,
        image.hex(),
        "kernel",
        descriptor.kernel.hex(),
        ArtifactAccess::ReadOnly,
    )?;
    match (&prepared.initrd, &descriptor.initrd) {
        (Some(source), Some(initrd)) => validate_prepared_source(
            source,
            image.hex(),
            "initrd",
            initrd.hex(),
            ArtifactAccess::ReadOnly,
        )?,
        (None, None) => {}
        _ => anyhow::bail!("prepared image initrd shape mismatch"),
    }
    if let Some(wake) = &prepared.wake {
        anyhow::ensure!(
            descriptor.wake.is_some(),
            "prepared wake files of an image without a suspended guest"
        );
        check_prepared_wake(image.hex(), wake)?;
    }
    Ok(ReadyImage {
        image: descriptor.image,
        cmdline: descriptor.cmdline,
        disk_size_bytes: descriptor.disk_size_bytes,
        prepared_image: descriptor.prepared_image,
        wake: descriptor.wake,
    })
}

/// The blobs a stored manifest names: its config and its layers. A missing
/// or unreadable manifest names nothing.
pub(super) fn manifest_references(store: &BlobStore, manifest: &OciDigest) -> Vec<OciDigest> {
    let Some(parsed) = std::fs::read(store.path(manifest))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<OciManifestV1>(&bytes).ok())
    else {
        return Vec::new();
    };
    std::iter::once(parsed.config.digest)
        .chain(parsed.layers.into_iter().map(|layer| layer.digest))
        .collect()
}

/// Remove every directory under the cache root that this layout does not
/// use (an older layout's `manifests`, `chunks`, `artifacts`, `tools`,
/// `launch-v3`). Files at the top are left alone.
pub(crate) fn sweep_cache_layout(cache_root: &Path) -> Result<Vec<PathBuf>> {
    let entries = match std::fs::read_dir(cache_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error).context("read the image cache root"),
    };
    let mut removed = Vec::new();
    for entry in entries {
        let entry = entry?;
        let keep = entry
            .file_name()
            .to_str()
            .is_some_and(|name| CACHE_LAYOUT_DIRS.contains(&name));
        // `file_type` does not follow a symlink, so a link is never walked.
        if keep || !entry.file_type()?.is_dir() {
            continue;
        }
        std::fs::remove_dir_all(entry.path())
            .with_context(|| format!("remove {}", entry.path().display()))?;
        info!(path = %entry.path().display(), "removed a directory of an older image cache layout");
        removed.push(entry.path());
    }
    Ok(removed)
}

/// Why an image could not be prepared, and whether retrying can fix it.
#[derive(Clone)]
struct ImageFailure {
    message: String,
    definitive: bool,
}

fn image_failures() -> &'static StdMutex<HashMap<OciDigest, ImageFailure>> {
    static FAILURES: OnceLock<StdMutex<HashMap<OciDigest, ImageFailure>>> = OnceLock::new();
    FAILURES.get_or_init(Default::default)
}

/// The error codes of a failure that no retry fixes: the registry neither
/// has nor grants the image, a fresh transfer's bytes are not its digest, or
/// this agent cannot run it. Anything else (network, a 5xx, jailerd) is transient.
const DEFINITIVE_FAILURE_CODES: &[&str] = &[
    "image_not_found:",
    "image_denied:",
    "digest_mismatch:",
    "unsupported_artifact:",
    "guest_contract_mismatch:",
];

pub(crate) fn is_definitive_failure(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        let message = cause.to_string();
        DEFINITIVE_FAILURE_CODES
            .iter()
            .any(|code| message.starts_with(code))
    })
}

/// Keep why an image could not be prepared, for the state report and for a
/// launch that waits on it.
pub(crate) fn record_image_failure(image: &OciDigest, error: &anyhow::Error) {
    if let Ok(mut failures) = image_failures().lock() {
        failures.insert(
            image.clone(),
            ImageFailure {
                message: format!("{error:#}"),
                definitive: is_definitive_failure(error),
            },
        );
    }
}

fn clear_image_failure(image: &OciDigest) {
    if let Ok(mut failures) = image_failures().lock() {
        failures.remove(image);
    }
}

pub(crate) fn image_failure(image: &OciDigest) -> Option<String> {
    Some(image_failures().lock().ok()?.get(image)?.message.clone())
}

/// Why the image could not be prepared, and whether no retry can fix it.
pub(crate) fn image_failure_state(image: &OciDigest) -> Option<(String, bool)> {
    let failures = image_failures().lock().ok()?;
    let failure = failures.get(image)?;
    Some((failure.message.clone(), failure.definitive))
}

fn wake_prepare_failures() -> &'static StdMutex<HashMap<OciDigest, String>> {
    static FAILURES: OnceLock<StdMutex<HashMap<OciDigest, String>>> = OnceLock::new();
    FAILURES.get_or_init(Default::default)
}

/// Keep why an image's suspended guest could not be prepared. The image
/// was prepared without it; the pass does not try again until a restart.
pub(super) fn record_wake_prepare_failure(image: &OciDigest, error: &anyhow::Error) {
    if let Ok(mut failures) = wake_prepare_failures().lock() {
        failures.insert(image.clone(), format!("{error:#}"));
    }
}

pub(super) fn wake_prepare_failure(image: &OciDigest) -> Option<String> {
    wake_prepare_failures().lock().ok()?.get(image).cloned()
}
