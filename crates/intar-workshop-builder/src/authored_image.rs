use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read as _, Write as _};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result, bail, ensure};
use intar_contracts::catalog::ImageArchitecture;
use intar_image_build::{QemuBuildConfig, prepare_scenario_disk, render_scenario_disk_plan};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tar::{Builder, EntryType, Header, HeaderMode};
use tokio_util::sync::CancellationToken;
use tracing::info;

use crate::bundle::prepare_local_bundle;
use crate::config::{
    AuthoredImagePreparationConfig, BuilderExecutionMode, KvmExecutionConfig,
    WorkshopBaseImageConfig, WorkshopBuilderConfig,
};
use crate::kvm::{GuestBootRequest, KvmWorkshopBackend, boot_authored_image_guest};
use crate::staging::{mark_staging_directory, unmark_staging_directory};

const PROVENANCE_FILE: &str = "provenance.json";
const DISK_FILE: &str = "disk.raw";
const SOURCE_ARCHIVE: &str = "learner-source.tar";
const SOURCE_CHECKSUMS: &str = "learner-source.sha256";
const PREPARE_SCRIPT: &str = "prepare-authored-image.sh";
const CLEANUP_SCRIPT: &str = "clean-authored-image.sh";
const TALOS_IMAGE: &str = "ghcr.io/siderolabs/talos@sha256:f2e2b7e5812b2b59c1acfe6af7516231aeeef79fb1ffff6b57ad987f8dd47a6e";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeConfig {
    schema_version: u32,
    install_root: String,
}

#[derive(Debug, Clone, Serialize)]
struct SourceEntry {
    path: String,
    mode: u32,
    size_bytes: u64,
    sha256: String,
}

#[derive(Debug)]
struct SourcePayload {
    archive: PathBuf,
    checksums: PathBuf,
    tree_sha256: String,
    entries: usize,
    size_bytes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GuestProof {
    schema_version: u32,
    source_git_commit: String,
    talos_image_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AuthoredImageProvenance {
    pub schema_version: u32,
    pub workshop_slug: String,
    pub image_name: String,
    pub architecture: ImageArchitecture,
    pub created_at_unix_seconds: u64,
    pub workshop_bundle_sha256: String,
    pub source_tree_sha256: String,
    pub source_entry_count: usize,
    pub source_size_bytes: u64,
    pub install_root: String,
    pub image_verifier: String,
    pub participant_boundary_sha256: String,
    pub runtime_bootstrap_sha256: String,
    pub image_lock_sha256: String,
    pub base_disk_sha256: String,
    pub kernel_sha256: String,
    pub initrd_sha256: String,
    pub workspace_agent_sha256: String,
    pub kino_sha256: String,
    pub sanitizer_sha256: String,
    pub boot_cmdline: String,
    pub output_disk_sha256: String,
    pub output_disk_size_bytes: u64,
    pub source_git_commit: String,
    pub talos_image: String,
    pub talos_image_id: String,
    pub build_log_sha256: String,
    pub serial_log_sha256: String,
    pub qemu_log_sha256: String,
}

/// Build and atomically promote the one configured authored workshop image.
/// This is an explicit operator command; publication never mutates a base.
pub fn prepare_authored_image(
    config: &WorkshopBuilderConfig,
    cancellation: CancellationToken,
) -> Result<AuthoredImageProvenance> {
    ensure!(
        config.execution_mode == BuilderExecutionMode::AgentKvm,
        "authored-image preparation is forbidden in direct_provider_only execution mode"
    );
    let preparation = config
        .execution
        .authored_image_preparation
        .as_ref()
        .context("execution.authored_image_preparation is not configured")?;
    let proof = config
        .execution
        .runtime_bundle_verification
        .as_ref()
        .context("authored-image preparation requires runtime_bundle_verification")?;
    let image = configured_image(&config.execution, preparation)?;

    KvmWorkshopBackend::preflight_for_authored_image(&config.execution, true)?;
    KvmWorkshopBackend::preflight_bundle_work_root(&config.worker.work_root, true)?;
    verify_input(
        preparation.workshop_bundle.as_path(),
        &preparation.workshop_bundle_sha256,
        false,
    )?;
    verify_input(
        preparation.kino_binary.as_path(),
        &preparation.kino_sha256,
        true,
    )?;
    verify_input(
        preparation.sanitizer_binary.as_path(),
        &preparation.sanitizer_sha256,
        true,
    )?;
    ensure!(
        !cancellation.is_cancelled(),
        "authored-image preparation cancelled"
    );

    let bundle = prepare_local_bundle(
        &preparation.workshop_bundle,
        &preparation.workshop_bundle_sha256,
        &config.worker,
    )?;
    ensure!(
        bundle.workshop.manifest.workspace.vms.len() == 1,
        "authored-image preparation requires exactly one workshop VM"
    );
    let vm = &bundle.workshop.manifest.workspace.vms[0];
    ensure!(
        vm.image == image.name,
        "workshop VM image '{}' does not match configured authored image '{}'",
        vm.image,
        image.name
    );
    ensure!(
        image.architecture == ImageArchitecture::X86_64,
        "authored-image preparation supports only x86_64"
    );

    let runtime_root = bundle.root.join("runtime");
    let runtime_config_path = runtime_root.join("runtime.json");
    let runtime_config: RuntimeConfig =
        serde_json::from_slice(&fs::read(&runtime_config_path).with_context(|| {
            format!(
                "workshop bundle is missing '{}'",
                runtime_config_path.display()
            )
        })?)
        .context("runtime/runtime.json is invalid")?;
    ensure!(
        runtime_config.schema_version == 1,
        "runtime/runtime.json schema_version must be 1"
    );
    validate_install_root(&runtime_config.install_root)?;
    let source_root = runtime_root.join("source");
    let bootstrap = runtime_root.join("bootstrap.sh");
    let image_lock = runtime_root.join("images.lock");
    for (label, path) in [
        ("runtime source", &source_root),
        ("runtime bootstrap", &bootstrap),
        ("runtime image lock", &image_lock),
    ] {
        let metadata = fs::symlink_metadata(path)
            .with_context(|| format!("workshop bundle is missing {label} '{}'", path.display()))?;
        ensure!(
            !metadata.file_type().is_symlink(),
            "{label} '{}' is a symlink",
            path.display()
        );
    }
    ensure!(
        fs::read(&image_lock)? == fs::read(source_root.join("scripts/images.lock"))?,
        "runtime/images.lock does not match runtime/source/scripts/images.lock"
    );
    let _module_zero = bundle
        .workshop
        .manifest
        .modules
        .iter()
        .find(|module| module.id == "00")
        .context("authored-image workshop must contain module '00'")?;
    let verifier_relative = validate_image_verifier(&source_root, &preparation.image_verifier)?;

    let output_parent = preparation
        .output_directory
        .parent()
        .context("authored-image output directory has no parent")?;
    prepare_output_parent(output_parent)?;
    let nominal_disk_bytes = u64::from(vm.disk_gib)
        .checked_mul(1024 * 1024 * 1024)
        .context("workshop disk size overflow")?;
    let conservative_peak_bytes = nominal_disk_bytes
        .checked_mul(2)
        .context("workshop peak disk budget overflow")?;
    let required_free_bytes = preparation
        .minimum_free_space_bytes
        .max(conservative_peak_bytes);
    verify_free_space(output_parent, required_free_bytes, "authored-image output")?;
    verify_free_space(
        &config.execution.work_root,
        required_free_bytes,
        "checkpoint execution work",
    )?;
    reject_existing_output(&preparation.output_directory)?;
    let staging = tempfile::Builder::new()
        .prefix("publication-authored-image-")
        .tempdir_in(output_parent)
        .context("failed to create authored-image staging directory")?;
    mark_staging_directory(staging.path())?;
    let staging_root = staging.path();
    let disk = staging_root.join(DISK_FILE);

    let qemu = QemuBuildConfig {
        target_arch: "amd64".to_owned(),
        qemu_binary: config.execution.qemu_binary.clone(),
        e2fsck_binary: config.execution.e2fsck_binary.clone(),
        resize2fs_binary: config.execution.resize2fs_binary.clone(),
        accelerator: config.execution.accelerator.clone(),
        build_cpus: vm.vcpu_millis.div_ceil(1_000).max(1),
        build_memory_mb: vm.memory_mib,
        work_root: staging_root.to_path_buf(),
        output_root: staging_root.to_path_buf(),
        ssh_wait_timeout_seconds: config.execution.ssh_wait_timeout_seconds,
        provision_timeout_seconds: config.execution.script_timeout_seconds,
        qemu_exit_timeout_seconds: config.execution.shutdown_timeout_seconds,
        ..QemuBuildConfig::default()
    };
    let disk_plan = render_scenario_disk_plan(&proof.disk, &disk, vm.disk_gib, &qemu);
    prepare_scenario_disk(&disk_plan)
        .context("failed to clone and size the pinned clean Debian disk")?;
    ensure!(
        !cancellation.is_cancelled(),
        "authored-image preparation cancelled"
    );

    let source_payload = build_source_payload(&source_root, staging_root, &config.worker)?;
    let prepare_script = staging_root.join(PREPARE_SCRIPT);
    let cleanup_script = staging_root.join(CLEANUP_SCRIPT);
    fs::write(
        &prepare_script,
        render_prepare_script(
            &runtime_config.install_root,
            &verifier_relative,
            &preparation.kino_sha256,
            &preparation.sanitizer_sha256,
            &config.execution.sanitizer_path,
            &image.guest_build_material_paths,
            &image.guest_forbidden_participant_paths,
        ),
    )
    .context("failed to write fixed authored-image preparation script")?;
    fs::write(&cleanup_script, cleanup_script_source())
        .context("failed to write fixed authored-image cleanup script")?;

    let seed_disk = staging_root.join("seed.img");
    let mut guest = boot_authored_image_guest(
        &config.execution,
        GuestBootRequest {
            generation_root: staging_root.to_path_buf(),
            root_disk: disk.clone(),
            seed_disk: seed_disk.clone(),
            kernel: proof.kernel.clone(),
            initrd: proof.initrd.clone(),
            boot_cmdline: proof.boot_cmdline.clone(),
            cpu_count: vm.vcpu_millis.div_ceil(1_000).max(1),
            memory_mib: vm.memory_mib,
        },
        cancellation.clone(),
    )
    .context("failed to boot authored-image preparation guest")?;

    let guest_result = (|| -> Result<GuestProof> {
        guest.upload(
            &source_payload.archive,
            "/tmp/intar-learner-source.tar",
            0o600,
        )?;
        guest.upload(
            &source_payload.checksums,
            "/tmp/intar-learner-source.sha256",
            0o600,
        )?;
        guest.upload(&bootstrap, "/tmp/intar-runtime-bootstrap.sh", 0o700)?;
        guest.upload(&image_lock, "/tmp/intar-runtime-images.lock", 0o600)?;
        guest.upload(&preparation.kino_binary, "/tmp/intar-kino", 0o700)?;
        guest.upload(
            &preparation.sanitizer_binary,
            "/tmp/intar-workshop-sanitize",
            0o700,
        )?;
        guest.upload(&prepare_script, "/tmp/intar-prepare-authored-image", 0o700)?;
        guest.run_fixed("sudo -- /bin/bash -- /tmp/intar-prepare-authored-image")?;
        let proof_path = staging_root.join("guest-proof.json");
        guest.download("/tmp/intar-authored-image-proof.json", &proof_path)?;
        let guest_proof: GuestProof = serde_json::from_slice(&fs::read(&proof_path)?)
            .context("guest authored-image proof is invalid")?;
        validate_guest_proof(&guest_proof)?;
        guest.upload(&cleanup_script, "/tmp/intar-clean-authored-image", 0o700)?;
        guest.run_fixed("sudo -- /bin/bash -- /tmp/intar-clean-authored-image")?;
        guest.shutdown()?;
        Ok(guest_proof)
    })();
    let guest_proof = match guest_result {
        Ok(proof) => proof,
        Err(error) => {
            guest.kill();
            return Err(error).context("authored-image guest preparation failed");
        }
    };

    repair_and_verify_filesystem(&config.execution.e2fsck_binary, &disk)?;
    for transient in [
        source_payload.archive.as_path(),
        source_payload.checksums.as_path(),
        prepare_script.as_path(),
        cleanup_script.as_path(),
        seed_disk.as_path(),
        staging_root.join("guest-proof.json").as_path(),
        staging_root.join("qmp.sock").as_path(),
    ] {
        remove_file_if_present(transient)?;
    }

    let provenance = AuthoredImageProvenance {
        schema_version: 1,
        workshop_slug: bundle.workshop.manifest.workshop.id.clone(),
        image_name: image.name.clone(),
        architecture: image.architecture.clone(),
        created_at_unix_seconds: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .context("system time is before the Unix epoch")?
            .as_secs(),
        workshop_bundle_sha256: preparation.workshop_bundle_sha256.clone(),
        source_tree_sha256: source_payload.tree_sha256,
        source_entry_count: source_payload.entries,
        source_size_bytes: source_payload.size_bytes,
        install_root: runtime_config.install_root,
        image_verifier: preparation.image_verifier.clone(),
        participant_boundary_sha256: participant_boundary_sha256(image)?,
        runtime_bootstrap_sha256: sha256_file(&bootstrap)?,
        image_lock_sha256: sha256_file(&image_lock)?,
        base_disk_sha256: proof.disk_sha256.clone(),
        kernel_sha256: proof.kernel_sha256.clone(),
        initrd_sha256: proof.initrd_sha256.clone(),
        workspace_agent_sha256: proof.workspace_agent_sha256.clone(),
        kino_sha256: preparation.kino_sha256.clone(),
        sanitizer_sha256: preparation.sanitizer_sha256.clone(),
        boot_cmdline: proof.boot_cmdline.clone(),
        output_disk_sha256: sha256_file(&disk)?,
        output_disk_size_bytes: fs::metadata(&disk)?.len(),
        source_git_commit: guest_proof.source_git_commit,
        talos_image: TALOS_IMAGE.to_owned(),
        talos_image_id: guest_proof.talos_image_id,
        build_log_sha256: sha256_required_log(&staging_root.join("build.log"))?,
        serial_log_sha256: sha256_required_log(&staging_root.join("serial.log"))?,
        qemu_log_sha256: sha256_required_log(&staging_root.join("qemu.log"))?,
    };
    let mut provenance_json =
        serde_json::to_vec_pretty(&provenance).context("failed to serialize image provenance")?;
    provenance_json.push(b'\n');
    write_synced(&staging_root.join(PROVENANCE_FILE), &provenance_json)?;
    sync_file(&disk)?;
    make_promoted_tree_read_only(staging_root)?;
    unmark_staging_directory(staging_root)?;
    reject_existing_output(&preparation.output_directory)?;
    fs::rename(staging.path(), &preparation.output_directory).with_context(|| {
        format!(
            "failed to atomically promote authored image to '{}'",
            preparation.output_directory.display()
        )
    })?;
    let _promoted_staging_path = staging.keep();
    sync_directory(output_parent)?;

    info!(
        image = %provenance.image_name,
        workshop = %provenance.workshop_slug,
        disk_sha256 = %provenance.output_disk_sha256,
        output = %preparation.output_directory.display(),
        "atomically promoted authored workshop image"
    );
    Ok(provenance)
}

/// Re-hash the promoted disk and every pinned input before publication can
/// claim work. This prevents a stale or partially copied directory from being
/// treated as a trusted authored base.
pub(crate) fn verify_prepared_authored_image(config: &KvmExecutionConfig) -> Result<()> {
    let Some(preparation) = &config.authored_image_preparation else {
        return Ok(());
    };
    let proof = config
        .runtime_bundle_verification
        .as_ref()
        .context("authored-image provenance requires runtime_bundle_verification")?;
    let image = configured_image(config, preparation)?;
    let output_metadata =
        fs::symlink_metadata(&preparation.output_directory).with_context(|| {
            format!(
                "authored image '{}' has not been prepared at '{}'",
                image.name,
                preparation.output_directory.display()
            )
        })?;
    ensure!(
        output_metadata.is_dir() && !output_metadata.file_type().is_symlink(),
        "authored-image output is not a real directory"
    );
    let provenance_path = preparation.output_directory.join(PROVENANCE_FILE);
    verify_regular_file(&provenance_path)?;
    let provenance: AuthoredImageProvenance =
        serde_json::from_slice(&fs::read(&provenance_path).with_context(|| {
            format!(
                "failed to read authored-image provenance '{}'",
                provenance_path.display()
            )
        })?)
        .context("authored-image provenance is invalid")?;
    ensure!(
        provenance.schema_version == 1,
        "unsupported image provenance"
    );
    ensure!(
        provenance.image_name == image.name,
        "image provenance name changed"
    );
    ensure!(
        provenance.architecture == image.architecture,
        "image provenance architecture changed"
    );
    ensure!(
        provenance.workshop_bundle_sha256 == preparation.workshop_bundle_sha256,
        "image provenance workshop bundle changed"
    );
    ensure!(
        provenance.base_disk_sha256 == proof.disk_sha256
            && provenance.kernel_sha256 == proof.kernel_sha256
            && provenance.initrd_sha256 == proof.initrd_sha256
            && provenance.workspace_agent_sha256 == proof.workspace_agent_sha256,
        "image provenance clean proof inputs changed"
    );
    ensure!(
        provenance.kino_sha256 == preparation.kino_sha256
            && provenance.sanitizer_sha256 == preparation.sanitizer_sha256,
        "image provenance guest binary inputs changed"
    );
    ensure!(
        provenance.image_verifier == preparation.image_verifier
            && provenance.participant_boundary_sha256 == participant_boundary_sha256(image)?
            && provenance.boot_cmdline == proof.boot_cmdline
            && provenance.talos_image == TALOS_IMAGE,
        "image provenance authored-image contract changed"
    );
    verify_input(
        &preparation.workshop_bundle,
        &preparation.workshop_bundle_sha256,
        false,
    )?;
    verify_input(&preparation.kino_binary, &preparation.kino_sha256, true)?;
    verify_input(
        &preparation.sanitizer_binary,
        &preparation.sanitizer_sha256,
        true,
    )?;
    verify_regular_file(&image.disk)?;
    let disk_metadata = fs::metadata(&image.disk)
        .with_context(|| format!("failed to inspect authored disk '{}'", image.disk.display()))?;
    ensure!(
        disk_metadata.len() == provenance.output_disk_size_bytes,
        "authored disk size changed after promotion"
    );
    ensure!(
        sha256_file(&image.disk)? == provenance.output_disk_sha256,
        "authored disk digest changed after promotion"
    );
    for (name, expected) in [
        ("build.log", provenance.build_log_sha256.as_str()),
        ("serial.log", provenance.serial_log_sha256.as_str()),
        ("qemu.log", provenance.qemu_log_sha256.as_str()),
    ] {
        let path = preparation.output_directory.join(name);
        verify_regular_file(&path)?;
        ensure!(
            sha256_file(&path)? == expected,
            "authored-image log '{}' changed after promotion",
            path.display()
        );
    }
    Ok(())
}

fn configured_image<'a>(
    config: &'a KvmExecutionConfig,
    preparation: &AuthoredImagePreparationConfig,
) -> Result<&'a WorkshopBaseImageConfig> {
    config
        .images
        .iter()
        .find(|image| image.name == preparation.image_name)
        .with_context(|| {
            format!(
                "authored-image preparation selects missing image '{}'",
                preparation.image_name
            )
        })
}

fn participant_boundary_sha256(image: &WorkshopBaseImageConfig) -> Result<String> {
    #[derive(Serialize)]
    struct ParticipantBoundary<'a> {
        build_material_paths: BTreeSet<&'a str>,
        forbidden_participant_paths: BTreeSet<&'a str>,
    }

    let boundary = ParticipantBoundary {
        build_material_paths: image
            .guest_build_material_paths
            .iter()
            .map(String::as_str)
            .collect(),
        forbidden_participant_paths: image
            .guest_forbidden_participant_paths
            .iter()
            .map(String::as_str)
            .collect(),
    };
    Ok(sha256_bytes(&serde_json::to_vec(&boundary).context(
        "failed to serialize authored-image participant boundary",
    )?))
}

fn build_source_payload(
    source_root: &Path,
    staging_root: &Path,
    worker: &crate::config::WorkerConfig,
) -> Result<SourcePayload> {
    let mut entries = Vec::new();
    collect_source_entries(source_root, source_root, &mut entries, worker)?;
    ensure!(!entries.is_empty(), "runtime/source contains no files");
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    let size_bytes = entries.iter().try_fold(0_u64, |total, entry| {
        total
            .checked_add(entry.size_bytes)
            .context("runtime source byte count overflow")
    })?;
    let manifest_json =
        serde_json::to_vec(&entries).context("failed to serialize source manifest")?;
    let tree_sha256 = sha256_bytes(&manifest_json);
    let archive_path = staging_root.join(SOURCE_ARCHIVE);
    let archive_file = File::create(&archive_path)
        .with_context(|| format!("failed to create '{}'", archive_path.display()))?;
    let mut archive = Builder::new(archive_file);
    archive.mode(HeaderMode::Deterministic);
    for entry in &entries {
        let source = source_root.join(&entry.path);
        let mut file = File::open(&source)
            .with_context(|| format!("failed to open '{}'", source.display()))?;
        let mut header = Header::new_gnu();
        header.set_entry_type(EntryType::Regular);
        header.set_size(entry.size_bytes);
        header.set_mode(entry.mode);
        header.set_uid(0);
        header.set_gid(0);
        header.set_mtime(0);
        header.set_cksum();
        archive
            .append_data(&mut header, &entry.path, &mut file)
            .with_context(|| format!("failed to archive '{}'", entry.path))?;
    }
    archive
        .into_inner()
        .context("failed to finish runtime source archive")?
        .sync_all()
        .context("failed to sync runtime source archive")?;
    let checksums_path = staging_root.join(SOURCE_CHECKSUMS);
    let mut checksums = String::new();
    for entry in &entries {
        checksums.push_str(&entry.sha256);
        checksums.push_str("  ./");
        checksums.push_str(&entry.path);
        checksums.push('\n');
    }
    write_synced(&checksums_path, checksums.as_bytes())?;
    Ok(SourcePayload {
        archive: archive_path,
        checksums: checksums_path,
        tree_sha256,
        entries: entries.len(),
        size_bytes,
    })
}

fn collect_source_entries(
    root: &Path,
    directory: &Path,
    entries: &mut Vec<SourceEntry>,
    worker: &crate::config::WorkerConfig,
) -> Result<()> {
    let mut children = fs::read_dir(directory)
        .with_context(|| format!("failed to read runtime source '{}'", directory.display()))?
        .collect::<std::result::Result<Vec<_>, _>>()
        .context("failed to enumerate runtime source")?;
    children.sort_by_key(std::fs::DirEntry::file_name);
    for child in children {
        let path = child.path();
        let metadata = fs::symlink_metadata(&path)
            .with_context(|| format!("failed to inspect '{}'", path.display()))?;
        ensure!(
            !metadata.file_type().is_symlink(),
            "runtime source contains symlink '{}'",
            path.display()
        );
        if metadata.is_dir() {
            collect_source_entries(root, &path, entries, worker)?;
            continue;
        }
        ensure!(
            metadata.is_file(),
            "runtime source contains unsupported file '{}'",
            path.display()
        );
        ensure!(
            entries.len() < worker.max_bundle_entries,
            "runtime source exceeds the {} entry limit",
            worker.max_bundle_entries
        );
        let relative = path
            .strip_prefix(root)
            .context("runtime source path escaped its root")?;
        validate_relative_payload_path(relative)?;
        let relative = relative
            .to_str()
            .context("runtime source path is not UTF-8")?
            .replace('\\', "/");
        let mode = source_mode(&metadata);
        entries.push(SourceEntry {
            path: relative,
            mode,
            size_bytes: metadata.len(),
            sha256: sha256_file(&path)?,
        });
    }
    let total = entries.iter().try_fold(0_u64, |total, entry| {
        total
            .checked_add(entry.size_bytes)
            .context("runtime source byte count overflow")
    })?;
    ensure!(
        total <= worker.max_expanded_bundle_bytes,
        "runtime source exceeds the {} byte expanded limit",
        worker.max_expanded_bundle_bytes
    );
    Ok(())
}

#[cfg(unix)]
fn source_mode(metadata: &fs::Metadata) -> u32 {
    if metadata.permissions().mode() & 0o111 == 0 {
        0o644
    } else {
        0o755
    }
}

#[cfg(not(unix))]
fn source_mode(_metadata: &fs::Metadata) -> u32 {
    0o644
}

fn render_prepare_script(
    install_root: &str,
    verifier_relative: &str,
    kino_sha256: &str,
    sanitizer_sha256: &str,
    sanitizer_path: &str,
    build_material_paths: &[String],
    forbidden_paths: &[String],
) -> String {
    let verifier = shell_quote(&format!("{install_root}/{verifier_relative}"));
    let install_root = shell_quote(install_root);
    let sanitizer_path = shell_quote(sanitizer_path);
    let mut script = format!(
        r#"#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root
export LANG=C.UTF-8
readonly install_root={install_root}
readonly staging="${{install_root}}.intar-preparing"

[[ "$(id -u)" == 0 ]]
[[ "$(uname -m)" == x86_64 ]]
. /etc/os-release
[[ "${{ID}}" == debian && "${{VERSION_ID}}" == 13 ]]
[[ ! -e "${{install_root}}" ]]
rm -rf -- "${{staging}}"
install -d -m 0755 -- "${{staging}}"
tar --extract --file /tmp/intar-learner-source.tar --directory "${{staging}}" --no-same-owner --same-permissions
(
  cd "${{staging}}"
  sha256sum --check --strict /tmp/intar-learner-source.sha256
)
printf 'intar-authored-runtime-v1\n' > "${{staging}}/.intar-runtime-owner"
mv -- "${{staging}}" "${{install_root}}"
printf '%s  %s\n' '{kino_sha256}' /tmp/intar-kino | sha256sum --check --strict
printf '%s  %s\n' '{sanitizer_sha256}' /tmp/intar-workshop-sanitize | sha256sum --check --strict
install -o root -g root -m 0755 /tmp/intar-kino /usr/local/bin/kino
install -D -o root -g root -m 0755 /tmp/intar-workshop-sanitize {sanitizer_path}
/usr/local/bin/kino --help >/dev/null
/bin/bash -n {sanitizer_path}
cmp --silent /tmp/intar-runtime-images.lock "${{install_root}}/scripts/images.lock"
env -i \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  HOME=/root LANG=C.UTF-8 \
  INTAR_WORKSHOP_INSTALL_ROOT="${{install_root}}" \
  INTAR_WORKSHOP_IMAGE_LOCK=/tmp/intar-runtime-images.lock \
  /bin/bash -- /tmp/intar-runtime-bootstrap.sh
{verifier}
/usr/local/bin/kino --help >/dev/null
docker info >/dev/null
talos_id="$(docker image inspect --format '{{{{.Id}}}}' '{TALOS_IMAGE}')"
[[ "${{talos_id}}" =~ ^sha256:[a-f0-9]{{64}}$ ]]
[[ "$(docker images --all --no-trunc --quiet | sort -u | sed '/^$/d' | wc -l)" == 1 ]]
[[ ! -e /usr/local/bin/intar-workspace-agent ]]
[[ ! -e /usr/local/sbin/intar-workspace-agent ]]
git_commit="$(git -C "${{install_root}}" rev-parse HEAD)"
[[ "${{git_commit}}" =~ ^[a-f0-9]{{40}}$ ]]
[[ -z "$(git -C "${{install_root}}" status --porcelain=v1 --untracked-files=all)" ]]
git -C "${{install_root}}" fsck --full --strict
printf '{{"schema_version":1,"source_git_commit":"%s","talos_image_id":"%s"}}\n' \
  "${{git_commit}}" "${{talos_id}}" > /tmp/intar-authored-image-proof.json
chmod 0644 /tmp/intar-authored-image-proof.json
"#
    );
    for path in build_material_paths {
        script.push_str("test -e ");
        script.push_str(&shell_quote(path));
        script.push('\n');
    }
    let build_material = build_material_paths.iter().collect::<BTreeSet<_>>();
    for path in forbidden_paths {
        if !build_material.contains(path) {
            script.push_str("test ! -e ");
            script.push_str(&shell_quote(path));
            script.push('\n');
        }
    }
    script
}

fn cleanup_script_source() -> &'static str {
    r#"#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
[[ "$(id -u)" == 0 ]]
docker builder prune --all --force >/dev/null 2>&1 || true
apt-get clean
rm -rf -- /var/lib/apt/lists/* /var/cache/apt/archives/*
rm -rf -- /var/cache/intar-mise /root/.cache/mise /home/ubuntu/.cache/mise
rm -f -- /root/.bash_history /home/ubuntu/.bash_history
rm -f -- /etc/udev/rules.d/70-persistent-net.rules
rm -f -- /var/lib/dbus/machine-id
rm -rf -- /var/lib/cloud/instances
journalctl --rotate >/dev/null 2>&1 || true
journalctl --vacuum-time=1s >/dev/null 2>&1 || true
find /var/log -xdev -type f -exec truncate -s 0 -- {} +
truncate -s 0 /etc/machine-id
rm -f -- /tmp/intar-learner-source.tar /tmp/intar-learner-source.sha256
rm -f -- /tmp/intar-runtime-bootstrap.sh /tmp/intar-runtime-images.lock
rm -f -- /tmp/intar-kino /tmp/intar-workshop-sanitize
rm -f -- /tmp/intar-prepare-authored-image /tmp/intar-authored-image-proof.json
rm -f -- /root/.ssh/authorized_keys /home/ubuntu/.ssh/authorized_keys
rm -f -- /etc/pam.d/intar-build
rm -f -- /etc/ssh/ssh_host_*
find /tmp /var/tmp -mindepth 1 -maxdepth 1 -xdev -exec rm -rf -- {} +
sync
fstrim -av >/dev/null 2>&1 || true
"#
}

fn validate_install_root(value: &str) -> Result<()> {
    let path = Path::new(value);
    ensure!(
        path.is_absolute() && path.starts_with("/opt") && path != Path::new("/opt"),
        "runtime install_root must be a child of /opt"
    );
    ensure!(
        !value.contains(['\n', '\r', '\0', '\t']),
        "runtime install_root contains control characters"
    );
    for component in path.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(value) => {
                let value = value
                    .to_str()
                    .context("runtime install_root is not UTF-8")?;
                ensure!(
                    !value.is_empty()
                        && value.bytes().all(|byte| {
                            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')
                        }),
                    "runtime install_root contains an unsafe component"
                );
            }
            _ => bail!("runtime install_root contains an unsafe component"),
        }
    }
    Ok(())
}

fn validate_image_verifier(source_root: &Path, relative: &str) -> Result<String> {
    let relative_path = Path::new(relative);
    validate_relative_payload_path(relative_path)?;
    let path = source_root.join(relative_path);
    let metadata = fs::symlink_metadata(&path)
        .with_context(|| format!("image verifier '{}' is missing", path.display()))?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "image verifier '{}' is not a regular file",
        path.display()
    );
    #[cfg(unix)]
    ensure!(
        metadata.permissions().mode() & 0o111 != 0,
        "image verifier '{}' is not executable",
        path.display()
    );
    Ok(relative.to_owned())
}

fn validate_relative_payload_path(path: &Path) -> Result<()> {
    ensure!(!path.as_os_str().is_empty(), "runtime source path is empty");
    for component in path.components() {
        let Component::Normal(value) = component else {
            bail!("runtime source path '{}' is unsafe", path.display());
        };
        let value = value.to_str().context("runtime source path is not UTF-8")?;
        ensure!(
            !value.is_empty()
                && value.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')
                }),
            "runtime source path '{}' contains an unsafe component",
            path.display()
        );
    }
    Ok(())
}

fn validate_guest_proof(proof: &GuestProof) -> Result<()> {
    ensure!(proof.schema_version == 1, "guest proof schema is invalid");
    ensure!(
        proof.source_git_commit.len() == 40
            && proof
                .source_git_commit
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')),
        "guest proof Git commit is invalid"
    );
    let digest = proof
        .talos_image_id
        .strip_prefix("sha256:")
        .context("guest proof Talos image ID is invalid")?;
    ensure!(
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')),
        "guest proof Talos image ID is invalid"
    );
    Ok(())
}

fn repair_and_verify_filesystem(e2fsck: &Path, disk: &Path) -> Result<()> {
    let repaired = Command::new(e2fsck)
        .args(["-f", "-y"])
        .arg(disk)
        .stdin(Stdio::null())
        .status()
        .with_context(|| format!("failed to execute '{}'", e2fsck.display()))?;
    ensure!(
        matches!(repaired.code(), Some(0 | 1)),
        "post-shutdown e2fsck repair failed with {repaired}"
    );
    let verified = Command::new(e2fsck)
        .args(["-f", "-n"])
        .arg(disk)
        .stdin(Stdio::null())
        .status()
        .with_context(|| format!("failed to execute '{}'", e2fsck.display()))?;
    ensure!(
        verified.success(),
        "post-repair e2fsck verification failed with {verified}"
    );
    Ok(())
}

fn prepare_output_parent(parent: &Path) -> Result<()> {
    create_directory_without_symlinks(parent)?;
    let metadata = fs::symlink_metadata(parent)
        .with_context(|| format!("failed to inspect output parent '{}'", parent.display()))?;
    ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "authored-image output parent must be a real directory"
    );
    #[cfg(unix)]
    ensure!(
        metadata.permissions().mode() & 0o022 == 0,
        "authored-image output parent is group/world writable"
    );
    let probe = parent.join(format!(".intar-authored-preflight-{}", std::process::id()));
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .with_context(|| {
            format!(
                "authored-image output parent '{}' is not writable",
                parent.display()
            )
        })?;
    fs::remove_file(&probe).context("failed to remove authored-image output probe")?;
    Ok(())
}

fn create_directory_without_symlinks(path: &Path) -> Result<()> {
    ensure!(path.is_absolute(), "host path must be absolute");
    let mut current = PathBuf::new();
    for component in path.components() {
        match component {
            Component::RootDir => current.push(Path::new("/")),
            Component::Normal(value) => current.push(value),
            _ => bail!(
                "host path '{}' contains an unsafe component",
                path.display()
            ),
        }
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).with_context(|| {
                    format!("failed to create path component '{}'", current.display())
                })?;
                fs::symlink_metadata(&current).with_context(|| {
                    format!(
                        "failed to inspect new path component '{}'",
                        current.display()
                    )
                })?
            }
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("failed to inspect path component '{}'", current.display())
                });
            }
        };
        ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "host path component '{}' is not a real directory",
            current.display()
        );
    }
    Ok(())
}

fn verify_free_space(path: &Path, required_bytes: u64, label: &str) -> Result<()> {
    let available_bytes = fs2::available_space(path)
        .with_context(|| format!("failed to inspect free space at '{}'", path.display()))?;
    ensure!(
        available_bytes >= required_bytes,
        "{label} filesystem at '{}' has {} free bytes; authored-image preparation requires at least {} bytes",
        path.display(),
        available_bytes,
        required_bytes
    );
    info!(
        path = %path.display(),
        available_bytes,
        required_bytes,
        "{label} free-space preflight passed"
    );
    Ok(())
}

fn reject_existing_output(output: &Path) -> Result<()> {
    match fs::symlink_metadata(output) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| {
            format!(
                "failed to inspect authored-image output '{}'",
                output.display()
            )
        }),
        Ok(_) => bail!(
            "authored-image output '{}' already exists; preparation never overwrites it",
            output.display()
        ),
    }
}

fn verify_input(path: &Path, expected_sha256: &str, executable: bool) -> Result<()> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("failed to inspect trusted input '{}'", path.display()))?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() > 0,
        "trusted input '{}' is not a non-empty regular file",
        path.display()
    );
    #[cfg(unix)]
    ensure!(
        metadata.permissions().mode() & 0o022 == 0,
        "trusted input '{}' is group/world writable",
        path.display()
    );
    #[cfg(unix)]
    if executable {
        ensure!(
            metadata.permissions().mode() & 0o111 != 0,
            "trusted input '{}' is not executable",
            path.display()
        );
    }
    let _ = executable;
    ensure!(
        sha256_file(path)? == expected_sha256,
        "trusted input '{}' SHA-256 changed",
        path.display()
    );
    Ok(())
}

fn verify_regular_file(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("failed to inspect promoted file '{}'", path.display()))?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "promoted file '{}' is not a regular file",
        path.display()
    );
    Ok(())
}

fn sha256_required_log(path: &Path) -> Result<String> {
    let metadata = fs::metadata(path)
        .with_context(|| format!("required build log '{}' is missing", path.display()))?;
    ensure!(
        metadata.is_file(),
        "'{}' is not a build log file",
        path.display()
    );
    sha256_file(path)
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file = File::open(path)
        .with_context(|| format!("failed to open '{}' for hashing", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .with_context(|| format!("failed to hash '{}'", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex_digest(&hasher.finalize()))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    hex_digest(&Sha256::digest(bytes))
}

fn hex_digest(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn write_synced(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .with_context(|| format!("failed to create '{}'", path.display()))?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .with_context(|| format!("failed to write '{}'", path.display()))
}

fn sync_file(path: &Path) -> Result<()> {
    File::open(path)
        .with_context(|| format!("failed to open '{}' for syncing", path.display()))?
        .sync_all()
        .with_context(|| format!("failed to sync '{}'", path.display()))
}

fn sync_directory(path: &Path) -> Result<()> {
    File::open(path)
        .with_context(|| format!("failed to open directory '{}' for syncing", path.display()))?
        .sync_all()
        .with_context(|| format!("failed to sync directory '{}'", path.display()))
}

fn remove_file_if_present(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error)
            .with_context(|| format!("failed to remove staging file '{}'", path.display())),
    }
}

fn make_promoted_tree_read_only(root: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        for name in [
            DISK_FILE,
            PROVENANCE_FILE,
            "build.log",
            "serial.log",
            "qemu.log",
        ] {
            let path = root.join(name);
            fs::set_permissions(&path, fs::Permissions::from_mode(0o440))
                .with_context(|| format!("failed to make '{}' read-only", path.display()))?;
        }
        fs::set_permissions(root, fs::Permissions::from_mode(0o750)).with_context(|| {
            format!(
                "failed to set authored-image directory mode '{}'",
                root.display()
            )
        })?;
    }
    Ok(())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::path::Path;

    use super::{
        cleanup_script_source, render_prepare_script, validate_guest_proof,
        validate_image_verifier, validate_install_root, verify_free_space,
    };

    #[test]
    fn install_root_is_limited_to_a_safe_opt_child() {
        validate_install_root("/opt/platform-engineering-workshop").unwrap();
        for value in [
            "/",
            "/opt",
            "/tmp/workshop",
            "/opt/../root",
            "/opt/name with space",
        ] {
            assert!(validate_install_root(value).is_err(), "{value}");
        }
    }

    #[test]
    fn guest_proof_requires_exact_lowercase_digests() {
        let valid = super::GuestProof {
            schema_version: 1,
            source_git_commit: "a".repeat(40),
            talos_image_id: format!("sha256:{}", "b".repeat(64)),
        };
        validate_guest_proof(&valid).unwrap();
        let invalid = super::GuestProof {
            talos_image_id: "sha256:ABC".to_owned(),
            ..valid
        };
        assert!(validate_guest_proof(&invalid).is_err());
    }

    #[test]
    fn preparation_script_creates_sanitizer_parent_and_preserves_material_boundaries() {
        let script = render_prepare_script(
            "/opt/workshop",
            "lab/00/verify.sh",
            &"1".repeat(64),
            &"2".repeat(64),
            "/usr/local/libexec/intar/intar-workshop-sanitize",
            &["/opt/workshop/.git".to_owned()],
            &[
                "/opt/workshop/.git".to_owned(),
                "/opt/workshop/solutions".to_owned(),
            ],
        );
        assert!(script.contains("test -e '/opt/workshop/.git'"));
        assert!(script.contains("test ! -e '/opt/workshop/solutions'"));
        assert!(!script.contains("test ! -e '/opt/workshop/.git'"));
        assert!(script.contains("docker images --all --no-trunc --quiet"));
        assert!(script.contains("--same-permissions"));
        assert!(script.contains(
            "install -D -o root -g root -m 0755 /tmp/intar-workshop-sanitize \
             '/usr/local/libexec/intar/intar-workshop-sanitize'"
        ));
        let staged = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(staged.path(), &script).unwrap();
        assert!(
            std::process::Command::new("bash")
                .arg("-n")
                .arg(staged.path())
                .status()
                .unwrap()
                .success()
        );
    }

    #[test]
    fn free_space_preflight_fails_before_an_impossible_peak() {
        let root = tempfile::tempdir().unwrap();
        let error = verify_free_space(root.path(), u64::MAX, "test").unwrap_err();
        assert!(error.to_string().contains("requires at least"));
    }

    #[test]
    fn platform_image_verifier_is_curated_runtime_source_not_canonical_wrapper() {
        let workshop_root =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../workshops/platform-engineering");
        let workshop = intar_workshop_manifest::load_and_validate(&workshop_root).unwrap();
        let module_zero = workshop
            .manifest
            .modules
            .iter()
            .find(|module| module.id == "00")
            .unwrap();
        assert_eq!(module_zero.verify_script, "scripts/verify-00.sh");

        let runtime_source = workshop_root.join("runtime/source");
        assert_eq!(
            validate_image_verifier(&runtime_source, "lab/00-setup/verify.sh").unwrap(),
            "lab/00-setup/verify.sh"
        );
    }

    #[test]
    fn fixed_cleanup_script_has_valid_shell_syntax() {
        let staged = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(staged.path(), cleanup_script_source()).unwrap();
        assert!(
            cleanup_script_source().contains("rm -f -- /etc/pam.d/intar-build"),
            "authored images must not retain the build-only PAM policy"
        );
        assert!(
            std::process::Command::new("bash")
                .arg("-n")
                .arg(staged.path())
                .status()
                .unwrap()
                .success()
        );
    }
}
