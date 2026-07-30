#![allow(clippy::missing_errors_doc)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::future::Future;
#[cfg(target_os = "linux")]
use std::io::Read as _;
use std::net::TcpListener;
#[cfg(target_os = "linux")]
use std::os::unix::fs::{FileTypeExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context as _, Error, Result, bail, ensure};
use intar_contracts::catalog::{ImageArchitecture, ImageFormat};
use intar_image_build::{
    BuildSeedInput, BuildSshKey, BuildSshSession, DirectBootQemuInput, DirectQemuShutdownInput,
    QemuBuildConfig, acknowledged_qmp_shutdown_with_cancel, expand_raw_zstd_sparse_with_cancel,
    generate_build_ssh_key, prepare_scenario_disk, render_direct_boot_qemu_command,
    render_scenario_disk_plan, write_build_seed, write_raw_zstd_artifact_with_cancel,
};
use intar_workshop_manifest::{WorkshopManifest, WorkspaceVm};
use sha2::{Digest as _, Sha256};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::backend::{
    BeginWorkshopBuild, CanonicalScript, CanonicalScriptKind, RuntimeBundleColdBoot,
    RuntimeBundleColdBootProof, SealCheckpoint, SealedVmArtifact, WorkshopExecutionBackend,
};
use crate::config::{KvmExecutionConfig, WorkshopBaseImageConfig};
use crate::staging::mark_staging_directory;

const SSH_HOST: &str = "127.0.0.1";
const QMP_SOCKET_NAME: &str = "qmp.sock";
const SSH_POLL_INTERVAL: Duration = Duration::from_secs(2);
const PROBE_RUNNER_REMOTE: &str = "/usr/local/lib/intar-workshop/run-probe";
const VERIFIER_ROOT_REMOTE: &str = "/usr/local/lib/intar-workshop/verifiers";
const CATCH_UP_ROOT_REMOTE: &str = "/run/intar-workshop-build";

type AllowedCanonicalScripts = BTreeMap<(String, CanonicalScriptKind), PathBuf>;

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum GuestMode {
    Mutable,
    ColdProof,
}

#[derive(Debug, Clone)]
pub(crate) struct GuestBootRequest {
    pub(crate) generation_root: PathBuf,
    pub(crate) root_disk: PathBuf,
    pub(crate) seed_disk: PathBuf,
    pub(crate) kernel: PathBuf,
    pub(crate) initrd: PathBuf,
    pub(crate) boot_cmdline: String,
    pub(crate) cpu_count: u32,
    pub(crate) memory_mib: u32,
}

/// Narrow process seam: workshop author input can only select validated files
/// passed to the typed methods below. It can never supply a guest command.
trait BuildGuest: Send {
    fn install_runtime_assets(
        &mut self,
        probe_runner: &Path,
        probe_config: &Path,
        sanitizer_path: &str,
    ) -> Result<()>;
    fn run_catch_up(&mut self, module_id: &str, source: &Path) -> Result<()>;
    fn install_verifier(&mut self, module_id: &str, source: &Path) -> Result<()>;
    fn run_installed_verifier(&mut self, module_id: &str) -> Result<()>;
    fn capture_build_material(&mut self, guest_paths: &[String], destination: &Path) -> Result<()>;
    fn restore_build_material(&mut self, guest_paths: &[String], source: &Path) -> Result<()>;
    fn scrub_transient_author_material(
        &mut self,
        module_ids: &[String],
        guest_build_material_paths: &[String],
    ) -> Result<()>;
    fn assert_participant_boundary(
        &mut self,
        module_ids: &[String],
        guest_forbidden_participant_paths: &[String],
    ) -> Result<()>;
    fn verify_runtime_bundle(
        &mut self,
        agent_binary: &Path,
        request: &RuntimeBundleColdBoot<'_>,
    ) -> Result<()>;
    fn sanitize(&mut self, sanitizer_path: &str) -> Result<()>;
    fn shutdown(&mut self) -> Result<()>;
    fn kill(&mut self);
}

trait GuestLauncher: Send {
    fn boot(&mut self, request: GuestBootRequest) -> Result<Box<dyn BuildGuest>>;
}

struct JobState {
    _work: tempfile::TempDir,
    root: PathBuf,
    bundle_root: PathBuf,
    vm: WorkspaceVm,
    image: WorkshopBaseImageConfig,
    allowed_scripts: AllowedCanonicalScripts,
    module_ids: Vec<String>,
    build_material_archive: Option<PathBuf>,
    active: Option<Box<dyn BuildGuest>>,
    mode: GuestMode,
    mutable_disk: PathBuf,
    generation: u32,
    stopped_for_seal: bool,
}

pub struct KvmWorkshopBackend {
    config: KvmExecutionConfig,
    launcher: Box<dyn GuestLauncher>,
    cancellation: CancellationToken,
    job: Option<JobState>,
}

impl KvmWorkshopBackend {
    pub fn new(config: KvmExecutionConfig) -> Self {
        Self::new_with_cancellation(config, CancellationToken::new())
    }

    pub fn new_with_cancellation(
        config: KvmExecutionConfig,
        cancellation: CancellationToken,
    ) -> Self {
        let launcher = Box::new(QemuGuestLauncher::new(config.clone(), cancellation.clone()));
        Self {
            config,
            launcher,
            cancellation,
            job: None,
        }
    }

    #[cfg(test)]
    fn with_launcher(config: KvmExecutionConfig, launcher: Box<dyn GuestLauncher>) -> Self {
        Self::with_launcher_and_cancellation(config, launcher, CancellationToken::new())
    }

    #[cfg(test)]
    fn with_launcher_and_cancellation(
        config: KvmExecutionConfig,
        launcher: Box<dyn GuestLauncher>,
        cancellation: CancellationToken,
    ) -> Self {
        Self {
            config,
            launcher,
            cancellation,
            job: None,
        }
    }

    /// Validate every trusted host dependency before registry authentication or
    /// publication claiming. `prepare` creates the private work root for `run`;
    /// doctor mode can pass false for a read-only inspection of an existing root.
    pub fn preflight(config: &KvmExecutionConfig, prepare: bool) -> Result<()> {
        Self::preflight_impl(config, prepare, true)?;
        crate::authored_image::verify_prepared_authored_image(config)
    }

    /// Preflight the trusted host and clean proof inputs without requiring the
    /// authored output disk to exist yet.
    pub(crate) fn preflight_for_authored_image(
        config: &KvmExecutionConfig,
        prepare: bool,
    ) -> Result<()> {
        Self::preflight_impl(config, prepare, false)
    }

    fn preflight_impl(
        config: &KvmExecutionConfig,
        prepare: bool,
        require_authored_images: bool,
    ) -> Result<()> {
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (config, prepare, require_authored_images);
            bail!("the workshop KVM backend is supported only on Linux builder hosts");
        }

        #[cfg(target_os = "linux")]
        {
            if prepare {
                fs::create_dir_all(&config.work_root).with_context(|| {
                    format!(
                        "failed to create workshop execution root '{}'",
                        config.work_root.display()
                    )
                })?;
            }
            validate_private_directory(&config.work_root)?;
            for (label, path) in [
                ("QEMU", &config.qemu_binary),
                ("e2fsck", &config.e2fsck_binary),
                ("resize2fs", &config.resize2fs_binary),
            ] {
                validate_executable(path).with_context(|| format!("{label} preflight failed"))?;
            }
            if require_authored_images {
                for image in &config.images {
                    for (label, path) in [
                        ("disk", &image.disk),
                        ("kernel", &image.kernel),
                        ("initrd", &image.initrd),
                    ] {
                        validate_regular_file(path).with_context(|| {
                            format!("trusted image '{}' {label} preflight failed", image.name)
                        })?;
                    }
                }
            }
            if let Some(proof) = &config.runtime_bundle_verification {
                for (label, path, expected) in [
                    ("disk", &proof.disk, proof.disk_sha256.as_str()),
                    ("kernel", &proof.kernel, proof.kernel_sha256.as_str()),
                    ("initrd", &proof.initrd, proof.initrd_sha256.as_str()),
                    (
                        "workspace agent",
                        &proof.workspace_agent_binary,
                        proof.workspace_agent_sha256.as_str(),
                    ),
                ] {
                    validate_regular_file(path)
                        .with_context(|| format!("direct-cloud proof {label} preflight failed"))?;
                    verify_file_sha256(path, expected).with_context(|| {
                        format!("direct-cloud proof {label} digest preflight failed")
                    })?;
                }
                validate_executable(&proof.workspace_agent_binary)
                    .context("direct-cloud proof workspace agent preflight failed")?;
            }
            if config.require_kvm {
                let metadata = fs::metadata("/dev/kvm").context("/dev/kvm is unavailable")?;
                ensure!(
                    metadata.file_type().is_char_device(),
                    "/dev/kvm is not a character device"
                );
                OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open("/dev/kvm")
                    .context("builder cannot open /dev/kvm read-write")?;
            }
            Ok(())
        }
    }

    pub fn preflight_bundle_work_root(path: &Path, prepare: bool) -> Result<()> {
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (path, prepare);
            bail!("the workshop KVM backend is supported only on Linux builder hosts");
        }
        #[cfg(target_os = "linux")]
        {
            if prepare {
                fs::create_dir_all(path).with_context(|| {
                    format!("failed to create bundle work root '{}'", path.display())
                })?;
            }
            validate_private_directory(path)
        }
    }

    fn ensure_idle(&self) -> Result<()> {
        ensure!(
            self.job.is_none(),
            "workshop backend already has an active job"
        );
        Ok(())
    }

    fn boot_job_generation(&mut self, job: &mut JobState, disk: PathBuf) -> Result<()> {
        let generation_root = job.root.join(format!("generation-{}", job.generation));
        fs::create_dir(&generation_root).with_context(|| {
            format!(
                "failed to create generation '{}'",
                generation_root.display()
            )
        })?;
        let seed_disk = generation_root.join("intarbuild.img");
        let cpu_count = job.vm.vcpu_millis.div_ceil(1_000).max(1);
        let guest = self.launcher.boot(GuestBootRequest {
            generation_root,
            root_disk: disk.clone(),
            seed_disk,
            kernel: job.image.kernel.clone(),
            initrd: job.image.initrd.clone(),
            boot_cmdline: job.image.boot_cmdline.clone(),
            cpu_count,
            memory_mib: job.vm.memory_mib,
        })?;
        job.mutable_disk = disk;
        job.active = Some(guest);
        job.stopped_for_seal = false;
        Ok(())
    }

    fn require_job(&mut self) -> Result<&mut JobState> {
        self.job
            .as_mut()
            .context("workshop backend has no active job")
    }
}

impl WorkshopExecutionBackend for KvmWorkshopBackend {
    fn begin(&mut self, request: &BeginWorkshopBuild<'_>) -> Result<()> {
        ensure!(
            !self.cancellation.is_cancelled(),
            "workshop build cancelled"
        );
        self.ensure_idle()?;
        enforce_single_vm_contract(request.manifest)?;
        let vm = request.manifest.workspace.vms[0].clone();
        let image = self
            .config
            .images
            .iter()
            .find(|candidate| candidate.name == vm.image)
            .cloned()
            .with_context(|| {
                format!(
                    "workspace image '{}' has no trusted execution mapping",
                    vm.image
                )
            })?;
        ensure!(
            image.architecture == request.architecture,
            "workspace image '{}' is configured for {:?}, not {:?}",
            vm.image,
            image.architecture,
            request.architecture
        );

        let bundle_root = request
            .bundle_root
            .canonicalize()
            .context("failed to canonicalize validated workshop bundle root")?;
        let (allowed_scripts, module_ids) = allowed_script_map(request.manifest, &bundle_root)?;
        let verifier_sources = module_ids
            .iter()
            .map(|module_id| {
                allowed_scripts
                    .get(&(module_id.clone(), CanonicalScriptKind::Verify))
                    .cloned()
                    .map(|path| (module_id.clone(), path))
                    .with_context(|| format!("module '{module_id}' has no validated verifier"))
            })
            .collect::<Result<Vec<_>>>()?;
        let work = tempfile::Builder::new()
            .prefix(&format!("publication-{}-", request.publication_id))
            .tempdir_in(&self.config.work_root)
            .context("failed to create private workshop execution directory")?;
        mark_staging_directory(work.path())?;
        let root = work.path().to_path_buf();
        let mutable_disk = root.join("mutable-0.raw");
        let qemu = qemu_config(&self.config, &root, &vm, &image.architecture);
        let disk_plan = render_scenario_disk_plan(&image.disk, &mutable_disk, vm.disk_gib, &qemu);
        prepare_scenario_disk(&disk_plan).context("failed to clone and size trusted base disk")?;
        ensure!(
            !self.cancellation.is_cancelled(),
            "workshop build cancelled"
        );

        let probe_runner = root.join("run-probe");
        let probe_config = root.join("kino.hcl.tpl");
        fs::write(&probe_runner, probe_runner_script())
            .context("failed to write fixed workshop probe runner")?;
        fs::write(
            &probe_config,
            render_probe_config(
                request.manifest,
                self.config.probe_every_seconds,
                self.config.probe_timeout_seconds,
            )?,
        )
        .context("failed to write workshop Kino probe configuration")?;

        let mut job = JobState {
            _work: work,
            root,
            bundle_root,
            vm,
            image,
            allowed_scripts,
            module_ids,
            build_material_archive: None,
            active: None,
            mode: GuestMode::Mutable,
            mutable_disk: mutable_disk.clone(),
            generation: 0,
            stopped_for_seal: false,
        };
        self.boot_job_generation(&mut job, mutable_disk)?;
        let install: Result<()> = (|| {
            let guest = job
                .active
                .as_mut()
                .context("new mutable generation is missing its guest")?;
            guest.install_runtime_assets(
                &probe_runner,
                &probe_config,
                &self.config.sanitizer_path,
            )?;
            // Every participant checkpoint must contain every declared manual
            // verifier. In particular, checkpoint N is the predecessor from
            // which a learner starts module N+1, so installing a verifier only
            // after its catch-up would make normal learner probes impossible.
            for (module_id, source) in &verifier_sources {
                guest.install_verifier(module_id, source).with_context(|| {
                    format!("failed to install verifier for module '{module_id}'")
                })?;
            }
            Ok(())
        })();
        if let Err(error) = install {
            if let Some(mut guest) = job.active.take() {
                guest.kill();
            }
            return Err(error).context("failed to install workshop runtime assets and verifiers");
        }
        if !job.image.guest_build_material_paths.is_empty() {
            let archive = job.root.join("trusted-build-material.tar.gz");
            let capture = job
                .active
                .as_mut()
                .context("new mutable generation is missing its guest")?
                .capture_build_material(&job.image.guest_build_material_paths, &archive);
            if let Err(error) = capture {
                if let Some(mut guest) = job.active.take() {
                    guest.kill();
                }
                return Err(error).context("failed to capture trusted guest build material");
            }
            job.build_material_archive = Some(archive);
        }
        info!(
            publication_id = request.publication_id,
            image = %job.image.name,
            "started trusted workshop build generation"
        );
        self.job = Some(job);
        Ok(())
    }

    fn run_canonical_script(&mut self, script: &CanonicalScript<'_>) -> Result<()> {
        ensure!(
            !self.cancellation.is_cancelled(),
            "workshop build cancelled"
        );
        let job = self.require_job()?;
        let expected = job
            .allowed_scripts
            .get(&(script.module_id.to_string(), script.kind))
            .with_context(|| {
                format!(
                    "module '{}' {:?} script is not in the validated allowlist",
                    script.module_id, script.kind
                )
            })?;
        let actual = script.source_path.canonicalize().with_context(|| {
            format!(
                "failed to canonicalize canonical script '{}'",
                script.source_path.display()
            )
        })?;
        ensure!(
            actual == *expected && actual.starts_with(&job.bundle_root),
            "canonical script path does not match the validated workshop manifest"
        );
        let guest = job
            .active
            .as_mut()
            .context("workshop build generation is not running")?;
        match (job.mode, script.kind) {
            (GuestMode::Mutable, CanonicalScriptKind::CatchUp) => {
                guest.run_catch_up(script.module_id, &actual)
            }
            (GuestMode::Mutable, CanonicalScriptKind::Verify) => {
                // Verifier sources are installed once before checkpoint 00 is
                // sealed. Running the retained copy proves the same command
                // Kino and participants will have in every generation.
                guest.run_installed_verifier(script.module_id)
            }
            (GuestMode::ColdProof, CanonicalScriptKind::Verify) => {
                // Deliberately do not upload the source again: cold-boot proof
                // establishes that the participant image retained its manual
                // verifier and generated Kino mapping.
                guest.run_installed_verifier(script.module_id)
            }
            (GuestMode::ColdProof, CanonicalScriptKind::CatchUp) => {
                bail!("catch-up scripts cannot run in a cold-proof generation")
            }
        }
    }

    fn sanitize_and_shutdown(&mut self, checkpoint_id: &str) -> Result<()> {
        ensure!(
            !self.cancellation.is_cancelled(),
            "workshop build cancelled"
        );
        let sanitizer_path = self.config.sanitizer_path.clone();
        let job = self.require_job()?;
        ensure!(
            job.mode == GuestMode::Mutable,
            "only mutable generations can be sealed"
        );
        ensure!(
            !job.stopped_for_seal,
            "generation is already stopped for sealing"
        );
        let mut guest = job
            .active
            .take()
            .context("mutable workshop generation is not running")?;
        let result = (|| {
            // Catch-up scripts are the only canonical solve material ever
            // uploaded. Solutions, facilitator notes, and source content never
            // cross the bundle/guest boundary. Scrub the exact transient path
            // set before invoking the fixed preinstalled sanitizer.
            guest.scrub_transient_author_material(
                &job.module_ids,
                &job.image.guest_build_material_paths,
            )?;
            guest.sanitize(&sanitizer_path)?;
            guest.shutdown()
        })();
        if let Err(error) = result {
            guest.kill();
            return Err(error).with_context(|| {
                format!("failed to sanitize and stop checkpoint '{checkpoint_id}'")
            });
        }
        job.stopped_for_seal = true;
        Ok(())
    }

    fn seal_checkpoint(&mut self, request: &SealCheckpoint<'_>) -> Result<Vec<SealedVmArtifact>> {
        ensure!(
            !self.cancellation.is_cancelled(),
            "workshop build cancelled"
        );
        let cancellation = self.cancellation.clone();
        let job = self.require_job()?;
        ensure!(
            job.mode == GuestMode::Mutable,
            "cold-proof generation cannot be sealed"
        );
        ensure!(
            job.stopped_for_seal,
            "mutable generation must be sanitized and stopped first"
        );
        ensure!(
            request.targets.len() == 1,
            "one-VM backend requires exactly one seal target"
        );
        let target = &request.targets[0];
        ensure!(
            target.vm_id == job.vm.id,
            "seal target VM does not match workspace VM"
        );
        let output = job
            .root
            .join(format!("checkpoint-{}.raw.zst", request.checkpoint_id));
        let checksum = job.root.join(format!(
            "checkpoint-{}.raw.zst.sha256",
            request.checkpoint_id
        ));
        let raw =
            write_raw_zstd_artifact_with_cancel(&job.mutable_disk, &output, &checksum, || {
                cancellation.is_cancelled()
            })
            .context("failed to seal raw-zstd workshop checkpoint")?;
        fs::remove_file(&job.mutable_disk)
            .context("failed to remove stopped mutable disk after sealing")?;
        Ok(vec![SealedVmArtifact {
            vm_id: job.vm.id.clone(),
            image_key: target.image_key.clone(),
            image_path: raw.compressed_path,
            image_format: ImageFormat::RawZstd,
            image_virtual_size_bytes: raw.virtual_size_bytes,
            kernel_path: job.image.kernel.clone(),
            initrd_path: job.image.initrd.clone(),
            boot_cmdline: job.image.boot_cmdline.clone(),
        }])
    }

    fn cold_boot_checkpoint(
        &mut self,
        checkpoint_id: &str,
        artifacts: &[SealedVmArtifact],
    ) -> Result<()> {
        ensure!(
            !self.cancellation.is_cancelled(),
            "workshop build cancelled"
        );
        let cancellation = self.cancellation.clone();
        let mut job = self
            .job
            .take()
            .context("workshop backend has no active job")?;
        let result = (|| {
            ensure!(job.active.is_none(), "a guest is already running");
            ensure!(
                job.stopped_for_seal,
                "checkpoint was not stopped for sealing"
            );
            let artifact = single_matching_artifact(&job, artifacts)?;
            job.generation = job.generation.saturating_add(1);
            let proof_disk = job.root.join(format!("cold-{checkpoint_id}.raw"));
            expand_raw_zstd_sparse_with_cancel(
                &artifact.image_path,
                &proof_disk,
                artifact.image_virtual_size_bytes,
                || cancellation.is_cancelled(),
            )?;
            job.mode = GuestMode::ColdProof;
            self.boot_job_generation(&mut job, proof_disk)?;
            job.active
                .as_mut()
                .context("cold-proof generation is missing its guest")?
                .assert_participant_boundary(
                    &job.module_ids,
                    &job.image.guest_forbidden_participant_paths,
                )
        })();
        self.job = Some(job);
        result.with_context(|| format!("failed to start cold proof for '{checkpoint_id}'"))
    }

    fn finish_cold_boot(&mut self, checkpoint_id: &str) -> Result<()> {
        ensure!(
            !self.cancellation.is_cancelled(),
            "workshop build cancelled"
        );
        let job = self.require_job()?;
        ensure!(
            job.mode == GuestMode::ColdProof,
            "no cold-proof generation is running"
        );
        let mut guest = job
            .active
            .take()
            .context("cold-proof generation is not running")?;
        if let Err(error) = guest.shutdown() {
            guest.kill();
            return Err(error)
                .with_context(|| format!("failed to stop cold proof for '{checkpoint_id}'"));
        }
        fs::remove_file(&job.mutable_disk)
            .context("failed to remove cold-proof disk after shutdown")?;
        job.stopped_for_seal = true;
        Ok(())
    }

    fn cold_boot_runtime_bundle(
        &mut self,
        request: &RuntimeBundleColdBoot<'_>,
    ) -> Result<RuntimeBundleColdBootProof> {
        ensure!(
            !self.cancellation.is_cancelled(),
            "workshop build cancelled"
        );
        ensure!(
            is_safe_id(request.checkpoint_id),
            "runtime-bundle checkpoint ID is unsafe"
        );
        ensure!(
            !request.bytes.is_empty()
                && u64::try_from(request.bytes.len()).unwrap_or(u64::MAX)
                    <= request.max_checkpoint_bytes,
            "runtime bundle is outside the configured proof size limit"
        );
        ensure!(
            sha256_bytes(request.bytes) == request.artifact.sha256,
            "runtime bundle bytes do not match their signed artifact digest"
        );
        let proof =
            self.config.runtime_bundle_verification.clone().context(
                "direct-cloud publication requires execution.runtime_bundle_verification",
            )?;
        ensure!(
            proof.system_image == request.system_image,
            "direct-cloud proof base '{}' does not match workshop system image '{}'",
            proof.system_image,
            request.system_image
        );
        // Freeze the comparatively small boot and verifier inputs into this
        // private generation before QEMU opens them. Preflight already checks
        // the operator-pinned files before claiming work; hashing the exact
        // bytes again here closes the long-build window for the guest agent
        // whose digest is recorded in the immutable publication.
        let workspace_agent_bytes = fs::read(&proof.workspace_agent_binary)
            .context("failed to stage direct-cloud proof workspace agent")?;
        ensure!(
            sha256_bytes(&workspace_agent_bytes) == proof.workspace_agent_sha256,
            "direct-cloud proof workspace agent changed after preflight"
        );
        let kernel_bytes =
            fs::read(&proof.kernel).context("failed to stage direct-cloud proof kernel")?;
        ensure!(
            sha256_bytes(&kernel_bytes) == proof.kernel_sha256,
            "direct-cloud proof kernel changed after preflight"
        );
        let initrd_bytes =
            fs::read(&proof.initrd).context("failed to stage direct-cloud proof initrd")?;
        ensure!(
            sha256_bytes(&initrd_bytes) == proof.initrd_sha256,
            "direct-cloud proof initrd changed after preflight"
        );

        let mut job = self
            .job
            .take()
            .context("workshop backend has no active job")?;
        let result = (|| {
            ensure!(job.active.is_none(), "a workshop guest is already running");
            ensure!(
                job.mode == GuestMode::ColdProof && job.stopped_for_seal,
                "sealed checkpoint cold proof must finish before direct-cloud proof"
            );
            ensure!(
                proof.disk != job.image.disk,
                "direct-cloud proof must use a separate clean base disk"
            );
            job.generation = job.generation.saturating_add(1);
            let generation_root = job.root.join(format!(
                "runtime-bundle-proof-{}-{}",
                request.checkpoint_id, job.generation
            ));
            fs::create_dir(&generation_root).with_context(|| {
                format!(
                    "failed to create direct-cloud proof directory '{}'",
                    generation_root.display()
                )
            })?;
            let root_disk = generation_root.join("clean-debian.raw");
            let seed_disk = generation_root.join("intarbuild.img");
            let staged_agent = generation_root.join("intar-workspace-agent");
            let staged_kernel = generation_root.join("vmlinuz");
            let staged_initrd = generation_root.join("initrd.img");
            fs::write(&staged_agent, &workspace_agent_bytes)
                .context("failed to write staged direct-cloud proof workspace agent")?;
            fs::write(&staged_kernel, &kernel_bytes)
                .context("failed to write staged direct-cloud proof kernel")?;
            fs::write(&staged_initrd, &initrd_bytes)
                .context("failed to write staged direct-cloud proof initrd")?;
            let qemu = qemu_config(&self.config, &generation_root, &job.vm, &proof.architecture);
            let disk_plan =
                render_scenario_disk_plan(&proof.disk, &root_disk, job.vm.disk_gib, &qemu);
            prepare_scenario_disk(&disk_plan)
                .context("failed to clone and size clean direct-cloud proof disk")?;
            let mut guest = self.launcher.boot(GuestBootRequest {
                generation_root,
                root_disk: root_disk.clone(),
                seed_disk,
                kernel: staged_kernel,
                initrd: staged_initrd,
                boot_cmdline: proof.boot_cmdline.clone(),
                cpu_count: job.vm.vcpu_millis.div_ceil(1_000).max(1),
                memory_mib: job.vm.memory_mib,
            })?;
            if let Err(error) = guest.verify_runtime_bundle(&staged_agent, request) {
                guest.kill();
                return Err(error).context(
                    "workspace agent rejected or failed to apply the exact reconstruction bundle",
                );
            }
            if let Err(error) = guest.shutdown() {
                guest.kill();
                return Err(error).context("failed to stop direct-cloud proof guest");
            }
            fs::remove_file(&root_disk)
                .context("failed to remove clean direct-cloud proof disk after shutdown")?;
            Ok(RuntimeBundleColdBootProof {
                workspace_agent_sha256: proof.workspace_agent_sha256.clone(),
            })
        })();
        self.job = Some(job);
        result.with_context(|| {
            format!(
                "failed to cold-boot exact runtime bundle for checkpoint '{}'",
                request.checkpoint_id
            )
        })
    }

    fn resume_from_checkpoint(
        &mut self,
        checkpoint_id: &str,
        artifacts: &[SealedVmArtifact],
    ) -> Result<()> {
        ensure!(
            !self.cancellation.is_cancelled(),
            "workshop build cancelled"
        );
        let cancellation = self.cancellation.clone();
        let mut job = self
            .job
            .take()
            .context("workshop backend has no active job")?;
        let result = (|| {
            ensure!(
                job.mode == GuestMode::ColdProof,
                "checkpoint was not cold-booted"
            );
            ensure!(job.active.is_none(), "cold-proof guest is still running");
            let artifact = single_matching_artifact(&job, artifacts)?;
            let artifact_path = artifact.image_path.clone();
            let artifact_size = artifact.image_virtual_size_bytes;
            job.generation = job.generation.saturating_add(1);
            let mutable_disk = job.root.join(format!("mutable-{}.raw", job.generation));
            expand_raw_zstd_sparse_with_cancel(
                &artifact_path,
                &mutable_disk,
                artifact_size,
                || cancellation.is_cancelled(),
            )?;
            job.mode = GuestMode::Mutable;
            self.boot_job_generation(&mut job, mutable_disk)?;
            if let Some(archive) = job.build_material_archive.as_deref() {
                job.active
                    .as_mut()
                    .context("resumed mutable generation is missing its guest")?
                    .restore_build_material(&job.image.guest_build_material_paths, archive)?;
            }
            fs::remove_file(&artifact_path)
                .context("failed to remove uploaded checkpoint staging image")?;
            Ok(())
        })();
        self.job = Some(job);
        result
            .with_context(|| format!("failed to resume mutable generation from '{checkpoint_id}'"))
    }

    fn finish(&mut self) -> Result<()> {
        ensure!(
            !self.cancellation.is_cancelled(),
            "workshop build cancelled"
        );
        let job = self
            .job
            .take()
            .context("workshop backend has no active job")?;
        ensure!(
            job.active.is_none(),
            "cannot finish while a guest is running"
        );
        ensure!(
            job.mode == GuestMode::ColdProof,
            "final checkpoint has not completed cold-boot proof"
        );
        // Dropping the private TempDir removes raw generations, seeds, logs,
        // and uploaded checkpoint staging files only after the orchestrator has
        // hashed and uploaded them.
        drop(job);
        Ok(())
    }

    fn abort(&mut self) {
        if let Some(mut job) = self.job.take() {
            if let Some(mut guest) = job.active.take() {
                guest.kill();
            }
            // TempDir drop is intentionally the sole recursive cleanup target;
            // it can never resolve to the configured root itself.
            drop(job);
        }
    }
}

impl Drop for KvmWorkshopBackend {
    fn drop(&mut self) {
        self.abort();
    }
}

fn enforce_single_vm_contract(manifest: &WorkshopManifest) -> Result<()> {
    ensure!(
        manifest.workspace.vms.len() == 1,
        "workshop KVM backend v1 supports exactly one workspace VM; found {}",
        manifest.workspace.vms.len()
    );
    Ok(())
}

fn allowed_script_map(
    manifest: &WorkshopManifest,
    bundle_root: &Path,
) -> Result<(AllowedCanonicalScripts, Vec<String>)> {
    let mut allowed = BTreeMap::new();
    let mut module_ids = Vec::with_capacity(manifest.modules.len());
    for module in &manifest.modules {
        ensure!(
            is_safe_id(&module.id),
            "module ID '{}' is not guest-path safe",
            module.id
        );
        module_ids.push(module.id.clone());
        for (kind, relative) in [
            (
                CanonicalScriptKind::CatchUp,
                module.catch_up_script.as_str(),
            ),
            (CanonicalScriptKind::Verify, module.verify_script.as_str()),
        ] {
            let path = bundle_root
                .join(relative)
                .canonicalize()
                .with_context(|| format!("failed to resolve canonical script '{relative}'"))?;
            ensure!(
                path.starts_with(bundle_root),
                "canonical script escapes bundle root"
            );
            ensure!(path.is_file(), "canonical script is not a regular file");
            allowed.insert((module.id.clone(), kind), path);
        }
    }
    Ok((allowed, module_ids))
}

fn single_matching_artifact<'a>(
    job: &JobState,
    artifacts: &'a [SealedVmArtifact],
) -> Result<&'a SealedVmArtifact> {
    ensure!(
        artifacts.len() == 1,
        "one-VM backend requires one sealed artifact"
    );
    let artifact = &artifacts[0];
    ensure!(
        artifact.vm_id == job.vm.id,
        "sealed artifact VM does not match workspace VM"
    );
    ensure!(
        artifact.image_format == ImageFormat::RawZstd,
        "sealed artifact format is not raw-zstd"
    );
    ensure!(
        artifact.kernel_path == job.image.kernel,
        "sealed artifact kernel changed"
    );
    ensure!(
        artifact.initrd_path == job.image.initrd,
        "sealed artifact initrd changed"
    );
    ensure!(
        artifact.boot_cmdline == job.image.boot_cmdline,
        "sealed artifact boot command line changed"
    );
    ensure!(
        artifact.image_path.starts_with(&job.root),
        "sealed artifact is outside the private publication root"
    );
    Ok(artifact)
}

fn qemu_config(
    config: &KvmExecutionConfig,
    root: &Path,
    vm: &WorkspaceVm,
    architecture: &ImageArchitecture,
) -> QemuBuildConfig {
    QemuBuildConfig {
        target_arch: match architecture {
            ImageArchitecture::X86_64 => "amd64".to_string(),
            ImageArchitecture::Aarch64 => "arm64".to_string(),
        },
        qemu_binary: config.qemu_binary.clone(),
        e2fsck_binary: config.e2fsck_binary.clone(),
        resize2fs_binary: config.resize2fs_binary.clone(),
        accelerator: config.accelerator.clone(),
        build_cpus: vm.vcpu_millis.div_ceil(1_000).max(1),
        build_memory_mb: vm.memory_mib,
        work_root: root.to_path_buf(),
        output_root: root.to_path_buf(),
        ssh_wait_timeout_seconds: config.ssh_wait_timeout_seconds,
        provision_timeout_seconds: config.script_timeout_seconds,
        qemu_exit_timeout_seconds: config.shutdown_timeout_seconds,
        ..QemuBuildConfig::default()
    }
}

fn render_probe_config(
    manifest: &WorkshopManifest,
    every_seconds: u64,
    timeout_seconds: u64,
) -> Result<String> {
    let mut lines = vec![
        "server {".to_string(),
        "  bind = \"vsock://__INTAR_KINO_CID__:__INTAR_KINO_PORT__\"".to_string(),
        "}".to_string(),
        String::new(),
        "defaults {".to_string(),
        format!("  every_seconds = {every_seconds}"),
        format!("  timeout_seconds = {timeout_seconds}"),
        "}".to_string(),
        String::new(),
    ];
    let mut seen = BTreeSet::new();
    for module in &manifest.modules {
        ensure!(
            is_safe_id(&module.id),
            "module ID '{}' is not probe-safe",
            module.id
        );
        let verifier = verifier_remote_path(&module.id);
        for probe in &module.probes {
            ensure!(is_safe_id(probe), "probe ID '{probe}' is not safe");
            ensure!(
                seen.insert(probe.as_str()),
                "probe ID '{probe}' is duplicated"
            );
            lines.extend([
                format!("probe {} {{", json_string(probe)?),
                "  kind = \"command_json_path\"".to_string(),
                format!(
                    "  argv = [{}, {}]",
                    json_string(PROBE_RUNNER_REMOTE)?,
                    json_string(&verifier)?
                ),
                "  json_path = \"$.passed\"".to_string(),
                "  expected = true".to_string(),
                "}".to_string(),
                String::new(),
            ]);
        }
    }
    Ok(format!("{}\n", lines.join("\n").trim_end()))
}

fn json_string(value: &str) -> Result<String> {
    serde_json::to_string(value).context("failed to encode trusted Kino string")
}

fn probe_runner_script() -> &'static str {
    r#"#!/usr/bin/env bash
set -uo pipefail
verifier="${1:?missing verifier path}"
set +e
"${verifier}" >/var/log/intar/workshop-probe-last.log 2>&1
status=$?
set -e
if [ "${status}" -eq 0 ]; then
  printf '{"passed":true}\n'
else
  printf '{"passed":false}\n'
fi
exit 0
"#
}

fn verifier_remote_path(module_id: &str) -> String {
    format!("{VERIFIER_ROOT_REMOTE}/{module_id}.sh")
}

fn catch_up_remote_path(module_id: &str) -> String {
    format!("{CATCH_UP_ROOT_REMOTE}/{module_id}.sh")
}

fn is_safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        && !matches!(value, "." | "..")
}

#[cfg(target_os = "linux")]
fn validate_private_directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("failed to inspect directory '{}'", path.display()))?;
    ensure!(
        !metadata.file_type().is_symlink(),
        "'{}' is a symlink",
        path.display()
    );
    ensure!(metadata.is_dir(), "'{}' is not a directory", path.display());
    let mode = metadata.permissions().mode();
    ensure!(
        mode & 0o022 == 0,
        "'{}' is group/world writable",
        path.display()
    );
    let probe = path.join(format!(".preflight-{}", std::process::id()));
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .with_context(|| format!("directory '{}' is not writable", path.display()))?;
    fs::remove_file(&probe).context("failed to remove workshop preflight file")?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn validate_regular_file(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("failed to inspect '{}'", path.display()))?;
    ensure!(
        !metadata.file_type().is_symlink(),
        "'{}' is a symlink",
        path.display()
    );
    ensure!(
        metadata.is_file(),
        "'{}' is not a regular file",
        path.display()
    );
    ensure!(metadata.len() > 0, "'{}' is empty", path.display());
    fs::File::open(path).with_context(|| format!("'{}' is not readable", path.display()))?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn verify_file_sha256(path: &Path, expected: &str) -> Result<()> {
    let mut file = fs::File::open(path)
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
    let actual = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    ensure!(
        actual == expected,
        "'{}' SHA-256 mismatch: expected {}, received {}",
        path.display(),
        expected,
        actual
    );
    Ok(())
}

#[cfg(target_os = "linux")]
fn validate_executable(path: &Path) -> Result<()> {
    validate_regular_file(path)?;
    let metadata = fs::metadata(path)?;
    ensure!(
        metadata.permissions().mode() & 0o111 != 0,
        "'{}' is not executable",
        path.display()
    );
    Command::new(path)
        .arg("--help")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .with_context(|| format!("failed to execute '{} --help'", path.display()))?;
    Ok(())
}

struct QemuGuestLauncher {
    config: KvmExecutionConfig,
    cancellation: CancellationToken,
}

impl QemuGuestLauncher {
    fn new(config: KvmExecutionConfig, cancellation: CancellationToken) -> Self {
        Self {
            config,
            cancellation,
        }
    }

    fn boot_concrete(&mut self, request: GuestBootRequest) -> Result<QemuBuildGuest> {
        ensure!(
            !self.cancellation.is_cancelled(),
            "workshop build cancelled"
        );
        let key = generate_build_ssh_key().context("failed to generate ephemeral build key")?;
        write_build_seed(&BuildSeedInput {
            path: &request.seed_disk,
            ssh_authorized_keys_openssh: std::slice::from_ref(&key.public_key_openssh),
            guest_ip_cidr: "10.0.2.15/24",
            gateway: "10.0.2.2",
            dns: "10.0.2.3",
            iface: None,
        })?;
        let ssh_port = allocate_ssh_port()?;
        let serial_log = request.generation_root.join("serial.log");
        let process_log = request.generation_root.join("qemu.log");
        let qmp_socket = request.generation_root.join(QMP_SOCKET_NAME);
        let qemu_config = QemuBuildConfig {
            qemu_binary: self.config.qemu_binary.clone(),
            accelerator: self.config.accelerator.clone(),
            ..QemuBuildConfig::default()
        };
        let command = render_direct_boot_qemu_command(&DirectBootQemuInput {
            config: &qemu_config,
            root_disk_path: &request.root_disk,
            seed_disk_path: &request.seed_disk,
            kernel_path: &request.kernel,
            initrd_path: &request.initrd,
            serial_log_path: &serial_log,
            qmp_socket_path: Path::new(QMP_SOCKET_NAME),
            ssh_host_port: ssh_port,
            memory_mib: request.memory_mib,
            cpu_count: request.cpu_count,
            boot_cmdline: &request.boot_cmdline,
        });
        let stdout = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&process_log)
            .context("failed to open QEMU process log")?;
        let stderr = stdout
            .try_clone()
            .context("failed to clone QEMU process log")?;
        let mut child = Command::new(&command.binary)
            .args(&command.args)
            .current_dir(&request.generation_root)
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr))
            .spawn()
            .with_context(|| format!("failed to launch '{}'", command.binary.display()))?;
        if self.cancellation.is_cancelled() {
            let _ = terminate_child(&mut child);
            bail!("workshop build cancelled");
        }
        if let Err(error) = wait_for_guest_ssh(
            &mut child,
            ssh_port,
            &self.config.ssh_username,
            &key,
            self.config.ssh_wait_timeout_seconds,
            &serial_log,
            &self.cancellation,
        ) {
            let _ = terminate_child(&mut child);
            return Err(error);
        }
        Ok(QemuBuildGuest {
            child: Some(child),
            ssh_port,
            ssh_username: self.config.ssh_username.clone(),
            key,
            qmp_socket,
            serial_log,
            build_log: request.generation_root.join("build.log"),
            script_timeout: Duration::from_secs(self.config.script_timeout_seconds),
            shutdown_timeout: Duration::from_secs(self.config.shutdown_timeout_seconds),
            cancellation: self.cancellation.clone(),
        })
    }
}

impl GuestLauncher for QemuGuestLauncher {
    fn boot(&mut self, request: GuestBootRequest) -> Result<Box<dyn BuildGuest>> {
        Ok(Box::new(self.boot_concrete(request)?))
    }
}

struct QemuBuildGuest {
    child: Option<Child>,
    ssh_port: u16,
    ssh_username: String,
    key: BuildSshKey,
    qmp_socket: PathBuf,
    serial_log: PathBuf,
    build_log: PathBuf,
    script_timeout: Duration,
    shutdown_timeout: Duration,
    cancellation: CancellationToken,
}

pub(crate) struct AuthoredImageGuest {
    inner: QemuBuildGuest,
}

impl AuthoredImageGuest {
    pub(crate) fn upload(&self, local: &Path, remote: &str, mode: u32) -> Result<()> {
        self.inner.upload(local, remote, mode)
    }

    pub(crate) fn run_fixed(&self, command: &str) -> Result<()> {
        self.inner.run_fixed(command)
    }

    pub(crate) fn download(&self, remote: &str, local: &Path) -> Result<()> {
        self.inner.download(remote, local)
    }

    pub(crate) fn shutdown(&mut self) -> Result<()> {
        self.inner.shutdown()
    }

    pub(crate) fn kill(&mut self) {
        self.inner.kill();
    }
}

pub(crate) fn boot_authored_image_guest(
    config: &KvmExecutionConfig,
    request: GuestBootRequest,
    cancellation: CancellationToken,
) -> Result<AuthoredImageGuest> {
    let mut launcher = QemuGuestLauncher::new(config.clone(), cancellation);
    Ok(AuthoredImageGuest {
        inner: launcher.boot_concrete(request)?,
    })
}

impl QemuBuildGuest {
    fn run_cancellable<T>(&self, future: impl Future<Output = Result<T>>) -> Result<T> {
        let cancellation = self.cancellation.clone();
        run_guest_future(async move {
            tokio::select! {
                biased;
                () = cancellation.cancelled() => bail!("workshop build cancelled"),
                result = future => result,
            }
        })
    }

    fn upload(&self, local: &Path, remote: &str, mode: u32) -> Result<()> {
        self.run_cancellable(async {
            let mut ssh = BuildSshSession::connect(
                SSH_HOST,
                self.ssh_port,
                &self.ssh_username,
                &self.key.private_key,
            )
            .await?;
            tokio::time::timeout(self.script_timeout, ssh.upload_file(local, remote, mode))
                .await
                .context("guest upload timed out")??;
            Ok(())
        })
    }

    fn run_fixed(&self, command: &str) -> Result<()> {
        self.run_cancellable(async {
            let mut ssh = BuildSshSession::connect(
                SSH_HOST,
                self.ssh_port,
                &self.ssh_username,
                &self.key.private_key,
            )
            .await?;
            tokio::time::timeout(
                self.script_timeout,
                ssh.run_logged(command, true, &self.build_log),
            )
            .await
            .context("guest operation timed out")??;
            Ok(())
        })
    }

    fn download(&self, remote: &str, local: &Path) -> Result<()> {
        self.run_cancellable(async {
            let mut ssh = BuildSshSession::connect(
                SSH_HOST,
                self.ssh_port,
                &self.ssh_username,
                &self.key.private_key,
            )
            .await?;
            tokio::time::timeout(self.script_timeout, ssh.download_file(remote, local))
                .await
                .context("guest download timed out")??;
            Ok(())
        })
    }
}

impl BuildGuest for QemuBuildGuest {
    fn install_runtime_assets(
        &mut self,
        probe_runner: &Path,
        probe_config: &Path,
        sanitizer_path: &str,
    ) -> Result<()> {
        self.upload(probe_runner, "/tmp/intar-workshop-run-probe", 0o700)?;
        self.upload(probe_config, "/tmp/intar-workshop-kino.hcl.tpl", 0o600)?;
        for command in [
            "sudo -- /usr/bin/install -d -m 0755 /usr/local/lib/intar-workshop/verifiers",
            "sudo -- /usr/bin/install -m 0755 /tmp/intar-workshop-run-probe /usr/local/lib/intar-workshop/run-probe",
            "sudo -- /usr/bin/install -d -m 0755 /etc/kino",
            "sudo -- /usr/bin/install -m 0644 /tmp/intar-workshop-kino.hcl.tpl /etc/kino/kino.hcl.tpl",
            "rm -f -- /tmp/intar-workshop-run-probe /tmp/intar-workshop-kino.hcl.tpl",
        ] {
            self.run_fixed(command)?;
        }
        self.run_fixed(&format!(
            "sudo -- /usr/bin/test -x {}",
            shell_quote(sanitizer_path)
        ))
        .context("fixed workshop sanitizer is absent or not executable")
    }

    fn run_catch_up(&mut self, module_id: &str, source: &Path) -> Result<()> {
        ensure!(is_safe_id(module_id), "unsafe module ID");
        let remote = catch_up_remote_path(module_id);
        self.run_fixed("sudo -- /usr/bin/install -d -m 0700 /run/intar-workshop-build")?;
        let upload = format!("/tmp/intar-workshop-catch-up-{module_id}");
        self.upload(source, &upload, 0o700)?;
        self.run_fixed(&format!(
            "sudo -- /usr/bin/install -m 0700 {} {}",
            shell_quote(&upload),
            shell_quote(&remote)
        ))?;
        self.run_fixed(&format!("sudo -- /bin/bash -- {}", shell_quote(&remote)))?;
        self.run_fixed(&format!(
            "sudo -- /usr/bin/rm -f -- {} {}",
            shell_quote(&remote),
            shell_quote(&upload)
        ))
    }

    fn install_verifier(&mut self, module_id: &str, source: &Path) -> Result<()> {
        ensure!(is_safe_id(module_id), "unsafe module ID");
        let upload = format!("/tmp/intar-workshop-verify-{module_id}");
        let retained = verifier_remote_path(module_id);
        self.upload(source, &upload, 0o700)?;
        self.run_fixed(&format!(
            "sudo -- /usr/bin/install -m 0755 {} {}",
            shell_quote(&upload),
            shell_quote(&retained)
        ))?;
        self.run_fixed(&format!("rm -f -- {}", shell_quote(&upload)))
    }

    fn run_installed_verifier(&mut self, module_id: &str) -> Result<()> {
        ensure!(is_safe_id(module_id), "unsafe module ID");
        self.run_fixed(&format!(
            "sudo -- {}",
            shell_quote(&verifier_remote_path(module_id))
        ))
    }

    fn capture_build_material(&mut self, guest_paths: &[String], destination: &Path) -> Result<()> {
        ensure!(!guest_paths.is_empty(), "build-material path set is empty");
        let mut command = String::from(
            "sudo -- /usr/bin/tar --create --gzip --absolute-names --file /tmp/intar-workshop-build-material.tar.gz --",
        );
        for path in guest_paths {
            command.push(' ');
            command.push_str(&shell_quote(path));
        }
        self.run_fixed(&command)?;
        self.run_fixed("sudo -- /usr/bin/chmod 0644 /tmp/intar-workshop-build-material.tar.gz")?;
        self.download("/tmp/intar-workshop-build-material.tar.gz", destination)?;
        self.run_fixed(captured_build_material_cleanup_command())
    }

    fn restore_build_material(&mut self, guest_paths: &[String], source: &Path) -> Result<()> {
        ensure!(!guest_paths.is_empty(), "build-material path set is empty");
        self.upload(source, "/tmp/intar-workshop-build-material.tar.gz", 0o600)?;
        self.run_fixed(
            "sudo -- /usr/bin/tar --extract --gzip --absolute-names --file /tmp/intar-workshop-build-material.tar.gz",
        )?;
        self.run_fixed("rm -f -- /tmp/intar-workshop-build-material.tar.gz")
    }

    fn scrub_transient_author_material(
        &mut self,
        module_ids: &[String],
        guest_build_material_paths: &[String],
    ) -> Result<()> {
        for module_id in module_ids {
            ensure!(is_safe_id(module_id), "unsafe module ID");
            self.run_fixed(&format!(
                "sudo -- /usr/bin/rm -f -- {} {}",
                shell_quote(&catch_up_remote_path(module_id)),
                shell_quote(&format!("/tmp/intar-workshop-catch-up-{module_id}"))
            ))?;
        }
        for path in guest_build_material_paths {
            self.run_fixed(&format!("sudo -- /usr/bin/rm -rf -- {}", shell_quote(path)))?;
        }
        self.run_fixed(
            "sudo -- /usr/bin/rmdir --ignore-fail-on-non-empty /run/intar-workshop-build",
        )
    }

    fn assert_participant_boundary(
        &mut self,
        module_ids: &[String],
        guest_forbidden_participant_paths: &[String],
    ) -> Result<()> {
        for module_id in module_ids {
            ensure!(is_safe_id(module_id), "unsafe module ID");
            self.run_fixed(&format!(
                "sudo -- /usr/bin/test ! -e {}",
                shell_quote(&catch_up_remote_path(module_id))
            ))?;
            self.run_fixed(&format!(
                "sudo -- /usr/bin/test -x {}",
                shell_quote(&verifier_remote_path(module_id))
            ))?;
        }
        for path in guest_forbidden_participant_paths {
            self.run_fixed(&format!("sudo -- /usr/bin/test ! -e {}", shell_quote(path)))?;
        }
        self.run_fixed("sudo -- /usr/bin/test ! -e /tmp/intar-workshop-build-material.tar.gz")
    }

    fn verify_runtime_bundle(
        &mut self,
        agent_binary: &Path,
        request: &RuntimeBundleColdBoot<'_>,
    ) -> Result<()> {
        let compression = match request.artifact.compression {
            crate::contracts::RuntimeBundleCompression::None => "none",
            crate::contracts::RuntimeBundleCompression::Gzip => "gzip",
            crate::contracts::RuntimeBundleCompression::Zstd => "zstd",
        };
        let bundle = tempfile::NamedTempFile::new()
            .context("failed to stage exact runtime bundle for guest upload")?;
        fs::write(bundle.path(), request.bytes)
            .context("failed to write exact runtime bundle for guest upload")?;
        ensure!(
            sha256_bytes(&fs::read(bundle.path())?) == request.artifact.sha256,
            "staged runtime bundle changed before guest upload"
        );
        self.upload(
            agent_binary,
            "/tmp/intar-workspace-agent-runtime-proof",
            0o700,
        )?;
        self.upload(bundle.path(), "/tmp/intar-workshop-runtime-bundle", 0o600)?;
        let command = format!(
            "sudo -- /tmp/intar-workspace-agent-runtime-proof verify-bundle \
             --bundle-path {} --checkpoint-id {} --sha256 {} --size-bytes {} \
             --compression {} --signature-b64 {} --signing-key-id {} \
             --signing-public-key-b64 {} --tmpfs-root {} --max-checkpoint-bytes {}",
            shell_quote("/tmp/intar-workshop-runtime-bundle"),
            shell_quote(request.checkpoint_id),
            shell_quote(&request.artifact.sha256),
            request.bytes.len(),
            compression,
            shell_quote(&request.artifact.signature_b64),
            shell_quote(&request.artifact.signing_key_id),
            shell_quote(request.signing_public_key_b64),
            shell_quote("/run/intar-workshop-runtime-proof"),
            request.max_checkpoint_bytes,
        );
        self.run_fixed(&command)?;
        self.run_fixed(
            "sudo -- /usr/bin/rm -f -- /tmp/intar-workspace-agent-runtime-proof /tmp/intar-workshop-runtime-bundle",
        )?;
        self.run_fixed(
            "sudo -- /usr/bin/test ! -e /tmp/intar-workspace-agent-runtime-proof && sudo -- /usr/bin/test ! -e /tmp/intar-workshop-runtime-bundle",
        )
    }

    fn sanitize(&mut self, sanitizer_path: &str) -> Result<()> {
        self.run_fixed(&format!("sudo -- {}", shell_quote(sanitizer_path)))
    }

    fn shutdown(&mut self) -> Result<()> {
        let child = self
            .child
            .as_mut()
            .context("QEMU guest is already stopped")?;
        acknowledged_qmp_shutdown_with_cancel(
            child,
            &DirectQemuShutdownInput {
                qmp_socket_path: &self.qmp_socket,
                serial_log_path: &self.serial_log,
                build_log_path: &self.build_log,
                timeout_seconds: self.shutdown_timeout.as_secs(),
            },
            || self.cancellation.is_cancelled(),
        )?;
        self.child = None;
        Ok(())
    }

    fn kill(&mut self) {
        if let Some(mut child) = self.child.take()
            && let Err(error) = terminate_child(&mut child)
        {
            warn!(error = %error, pid = child.id(), "failed to terminate workshop QEMU guest");
        }
    }
}

impl Drop for QemuBuildGuest {
    fn drop(&mut self) {
        self.kill();
    }
}

fn current_thread_runtime() -> Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("failed to create workshop guest SSH runtime")
}

/// Run one asynchronous guest operation from the synchronous execution
/// backend. Run and run-once invoke this code from Tokio's multi-thread
/// runtime, where starting a nested runtime would panic. `block_in_place`
/// hands the worker thread back to Tokio before using the existing runtime
/// handle. Authored-image preparation and unit callers outside a runtime retain
/// a small local runtime for only the supplied future. Runtime-backed tasks or
/// handles must therefore never escape that future.
fn run_guest_future<T>(future: impl Future<Output = Result<T>>) -> Result<T> {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => tokio::task::block_in_place(|| handle.block_on(future)),
        Err(_) => current_thread_runtime()?.block_on(future),
    }
}

fn allocate_ssh_port() -> Result<u16> {
    let listener = TcpListener::bind((SSH_HOST, 0))
        .context("failed to allocate loopback workshop SSH port")?;
    Ok(listener.local_addr()?.port())
}

fn wait_for_guest_ssh(
    child: &mut Child,
    port: u16,
    username: &str,
    key: &BuildSshKey,
    timeout_seconds: u64,
    serial_log: &Path,
    cancellation: &CancellationToken,
) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(timeout_seconds.max(1));
    let mut last_error = None;
    while Instant::now() < deadline {
        ensure!(!cancellation.is_cancelled(), "workshop build cancelled");
        if let Some(status) = child
            .try_wait()
            .context("failed to poll QEMU during SSH wait")?
        {
            bail!(
                "QEMU exited before workshop build SSH was ready with {status}; serial log: {}",
                serial_log.display()
            );
        }
        match run_guest_future(probe_guest_ssh(port, username, key, cancellation)) {
            Ok(()) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
        thread::sleep(SSH_POLL_INTERVAL);
    }
    if let Some(error) = last_error {
        bail!(
            "timed out waiting for workshop build SSH: {error:#}; serial log: {}",
            serial_log.display()
        );
    }
    bail!(
        "timed out waiting for workshop build SSH; serial log: {}",
        serial_log.display()
    )
}

async fn probe_guest_ssh(
    port: u16,
    username: &str,
    key: &BuildSshKey,
    cancellation: &CancellationToken,
) -> Result<()> {
    tokio::select! {
        biased;
        () = cancellation.cancelled() => bail!("workshop build cancelled"),
        result = async {
            // Russh owns a connection-driver task on the runtime used by
            // `connect`. Keep the readiness command in the same bridged future
            // so synchronous callers do not drop that runtime between
            // authentication and opening the session channel.
            let mut ssh = BuildSshSession::connect(
                SSH_HOST,
                port,
                username,
                &key.private_key,
            )
            .await?;
            ssh.run("true", false).await
        } => result,
    }
}

fn terminate_child(child: &mut Child) -> Result<ExitStatus> {
    let pid = child.id();
    match child.kill() {
        Ok(()) => child
            .wait()
            .with_context(|| format!("failed to reap QEMU pid {pid}")),
        Err(kill_error) => {
            match child.try_wait() {
                Ok(Some(status)) => Ok(status),
                Ok(None) => Err(Error::new(kill_error)
                    .context(format!("failed to kill running QEMU pid {pid}"))),
                Err(poll_error) => bail!(
                    "failed to kill QEMU pid {pid}: {kill_error}; poll also failed: {poll_error}"
                ),
            }
        }
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn captured_build_material_cleanup_command() -> &'static str {
    // The capture archive is created by sudo tar and remains root-owned in
    // sticky /tmp even after chmod makes it readable by the SSH user.
    "sudo -- /usr/bin/rm -f -- /tmp/intar-workshop-build-material.tar.gz"
}

fn sha256_bytes(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::io::Write as _;
    use std::sync::{Arc, Mutex};

    use intar_contracts::catalog::ImageKey;
    use intar_workshop_manifest::ValidatedWorkshop;
    use russh::{
        Channel, ChannelId,
        server::{self, Auth, Msg, Server as _, Session},
    };

    use super::*;

    #[derive(Clone)]
    struct ReadinessSshServer {
        allowed_public_key: russh::keys::ssh_key::PublicKey,
        host_key: russh::keys::PrivateKey,
    }

    impl server::Server for ReadinessSshServer {
        type Handler = Self;

        fn new_client(&mut self, _peer_addr: Option<std::net::SocketAddr>) -> Self::Handler {
            self.clone()
        }
    }

    impl server::Handler for ReadinessSshServer {
        type Error = anyhow::Error;

        async fn auth_publickey(
            &mut self,
            user: &str,
            public_key: &russh::keys::ssh_key::PublicKey,
        ) -> std::result::Result<Auth, Self::Error> {
            if user == "ubuntu" && public_key == &self.allowed_public_key {
                Ok(Auth::Accept)
            } else {
                Ok(Auth::reject())
            }
        }

        async fn channel_open_session(
            &mut self,
            _channel: Channel<Msg>,
            reply: server::ChannelOpenHandle,
            _session: &mut Session,
        ) -> std::result::Result<(), Self::Error> {
            reply.accept().await;
            Ok(())
        }

        async fn exec_request(
            &mut self,
            channel: ChannelId,
            data: &[u8],
            session: &mut Session,
        ) -> std::result::Result<(), Self::Error> {
            ensure!(data == b"true", "unexpected readiness command");
            session.channel_success(channel)?;
            session.exit_status_request(channel, 0)?;
            session.close(channel)?;
            Ok(())
        }
    }

    #[derive(Clone)]
    struct FakeLauncher {
        events: Arc<Mutex<Vec<String>>>,
    }

    struct FakeGuest {
        events: Arc<Mutex<Vec<String>>>,
    }

    impl GuestLauncher for FakeLauncher {
        fn boot(&mut self, request: GuestBootRequest) -> Result<Box<dyn BuildGuest>> {
            self.events
                .lock()
                .unwrap()
                .push(format!("boot:{}:{}", request.cpu_count, request.memory_mib));
            Ok(Box::new(FakeGuest {
                events: Arc::clone(&self.events),
            }))
        }
    }

    impl BuildGuest for FakeGuest {
        fn install_runtime_assets(
            &mut self,
            _probe_runner: &Path,
            _probe_config: &Path,
            _sanitizer_path: &str,
        ) -> Result<()> {
            self.events.lock().unwrap().push("assets".to_string());
            Ok(())
        }

        fn run_catch_up(&mut self, module_id: &str, _source: &Path) -> Result<()> {
            self.events
                .lock()
                .unwrap()
                .push(format!("catch:{module_id}"));
            Ok(())
        }

        fn install_verifier(&mut self, module_id: &str, _source: &Path) -> Result<()> {
            self.events
                .lock()
                .unwrap()
                .push(format!("verifier-install:{module_id}"));
            Ok(())
        }

        fn run_installed_verifier(&mut self, module_id: &str) -> Result<()> {
            self.events
                .lock()
                .unwrap()
                .push(format!("verify-retained:{module_id}"));
            Ok(())
        }

        fn capture_build_material(
            &mut self,
            _guest_paths: &[String],
            destination: &Path,
        ) -> Result<()> {
            fs::write(destination, b"trusted-build-material")?;
            self.events
                .lock()
                .unwrap()
                .push("capture-build".to_string());
            Ok(())
        }

        fn restore_build_material(
            &mut self,
            _guest_paths: &[String],
            _source: &Path,
        ) -> Result<()> {
            self.events
                .lock()
                .unwrap()
                .push("restore-build".to_string());
            Ok(())
        }

        fn scrub_transient_author_material(
            &mut self,
            module_ids: &[String],
            guest_build_material_paths: &[String],
        ) -> Result<()> {
            self.events.lock().unwrap().push(format!(
                "scrub:{}:{}",
                module_ids.join(","),
                guest_build_material_paths.join(",")
            ));
            Ok(())
        }

        fn assert_participant_boundary(
            &mut self,
            _module_ids: &[String],
            guest_forbidden_participant_paths: &[String],
        ) -> Result<()> {
            self.events.lock().unwrap().push(format!(
                "assert-participant-boundary:{}",
                guest_forbidden_participant_paths.join(",")
            ));
            Ok(())
        }

        fn verify_runtime_bundle(
            &mut self,
            _agent_binary: &Path,
            request: &RuntimeBundleColdBoot<'_>,
        ) -> Result<()> {
            self.events
                .lock()
                .unwrap()
                .push(format!("runtime-proof:{}", request.checkpoint_id));
            Ok(())
        }

        fn sanitize(&mut self, _sanitizer_path: &str) -> Result<()> {
            self.events.lock().unwrap().push("sanitize".to_string());
            Ok(())
        }

        fn shutdown(&mut self) -> Result<()> {
            self.events.lock().unwrap().push("shutdown".to_string());
            Ok(())
        }

        fn kill(&mut self) {
            self.events.lock().unwrap().push("kill".to_string());
        }
    }

    fn fixture() -> ValidatedWorkshop {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../intar-workshop-manifest/tests/fixtures/platform-engineering-workshop");
        intar_workshop_manifest::load_and_validate(&root).unwrap()
    }

    fn test_config(root: &Path) -> KvmExecutionConfig {
        let base = root.join("base.raw");
        let kernel = root.join("kernel");
        let initrd = root.join("initrd");
        fs::write(&base, vec![0_u8; 4096]).unwrap();
        fs::write(&kernel, b"kernel").unwrap();
        fs::write(&initrd, b"initrd").unwrap();
        KvmExecutionConfig {
            work_root: root.join("work"),
            qemu_binary: PathBuf::from("/usr/bin/true"),
            e2fsck_binary: PathBuf::from("/usr/bin/true"),
            resize2fs_binary: PathBuf::from("/usr/bin/true"),
            sanitizer_path: "/usr/local/sbin/intar-workshop-sanitize".to_string(),
            ssh_username: "ubuntu".to_string(),
            accelerator: "kvm".to_string(),
            require_kvm: true,
            ssh_wait_timeout_seconds: 1,
            script_timeout_seconds: 1,
            shutdown_timeout_seconds: 1,
            probe_every_seconds: 10,
            probe_timeout_seconds: 120,
            runtime_bundle_verification: None,
            authored_image_preparation: None,
            images: vec![WorkshopBaseImageConfig {
                name: "platform-workshop-debian13".to_string(),
                architecture: ImageArchitecture::X86_64,
                disk: base,
                kernel,
                initrd,
                boot_cmdline: "root=/dev/vda rw console=ttyS0".to_string(),
                guest_build_material_paths: vec!["/opt/debian13-workshop/.git".to_string()],
                guest_forbidden_participant_paths: vec![
                    "/opt/debian13-workshop/.git".to_string(),
                    "/opt/debian13-workshop/solutions".to_string(),
                ],
            }],
        }
    }

    fn enable_runtime_bundle_proof(config: &mut KvmExecutionConfig, root: &Path) {
        let disk = root.join("clean-debian13.raw");
        let kernel = root.join("clean-debian13-kernel");
        let initrd = root.join("clean-debian13-initrd");
        let agent = root.join("intar-workspace-agent");
        fs::write(&disk, vec![1_u8; 4096]).unwrap();
        fs::write(&kernel, b"clean-kernel").unwrap();
        fs::write(&initrd, b"clean-initrd").unwrap();
        fs::write(&agent, b"workspace-agent").unwrap();
        config.runtime_bundle_verification = Some(crate::config::RuntimeBundleVerificationConfig {
            system_image: "debian-13".to_owned(),
            architecture: ImageArchitecture::X86_64,
            disk_sha256: sha256_bytes(&fs::read(&disk).unwrap()),
            kernel_sha256: sha256_bytes(&fs::read(&kernel).unwrap()),
            initrd_sha256: sha256_bytes(&fs::read(&initrd).unwrap()),
            workspace_agent_sha256: sha256_bytes(&fs::read(&agent).unwrap()),
            disk,
            kernel,
            initrd,
            boot_cmdline: "root=/dev/vda rw console=ttyS0".to_owned(),
            workspace_agent_binary: agent,
        });
    }

    #[test]
    fn typed_process_seam_scrubs_catch_up_before_shutdown_and_keeps_verifier() {
        let temp = tempfile::tempdir().unwrap();
        let config = test_config(temp.path());
        fs::create_dir(&config.work_root).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let launcher = FakeLauncher {
            events: Arc::clone(&events),
        };
        let mut backend = KvmWorkshopBackend::with_launcher(config, Box::new(launcher));
        let workshop = fixture();
        let bundle_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../intar-workshop-manifest/tests/fixtures/platform-engineering-workshop");
        backend
            .begin(&BeginWorkshopBuild {
                publication_id: "publication-1",
                bundle_root: &bundle_root,
                manifest: &workshop.manifest,
                architecture: ImageArchitecture::X86_64,
            })
            .unwrap();
        let module = &workshop.manifest.modules[0];
        backend
            .run_canonical_script(&CanonicalScript {
                module_id: &module.id,
                kind: CanonicalScriptKind::CatchUp,
                source_path: &bundle_root.join(&module.catch_up_script),
            })
            .unwrap();
        backend
            .run_canonical_script(&CanonicalScript {
                module_id: &module.id,
                kind: CanonicalScriptKind::Verify,
                source_path: &bundle_root.join(&module.verify_script),
            })
            .unwrap();
        backend.sanitize_and_shutdown(&module.checkpoint).unwrap();

        let events = events.lock().unwrap();
        let scrub = events
            .iter()
            .position(|event| event.starts_with("scrub:"))
            .unwrap();
        let sanitize = events.iter().position(|event| event == "sanitize").unwrap();
        let shutdown = events.iter().position(|event| event == "shutdown").unwrap();
        let first_catch_up = events.iter().position(|event| event == "catch:00").unwrap();
        for module in &workshop.manifest.modules {
            let installed = events
                .iter()
                .position(|event| event == &format!("verifier-install:{}", module.id))
                .unwrap();
            assert!(installed < first_catch_up);
        }
        assert!(events.iter().any(|event| event == "verify-retained:00"));
        assert!(events.iter().any(|event| event == "capture-build"));
        assert!(events[scrub].contains("/opt/debian13-workshop/.git"));
        assert!(scrub < sanitize && sanitize < shutdown);
    }

    #[test]
    fn reference_catch_ups_reconstruct_from_external_digests() {
        let root =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../workshops/platform-engineering");
        let workshop = intar_workshop_manifest::load_and_validate(&root).unwrap();
        assert!(
            workshop
                .manifest
                .workshop
                .attribution
                .contains("https://github.com/randax/Platform-Engineering-Workshop/tree/")
        );
        let hydrated = crate::hydrate::hydrate_workshop_manifest(&root, &workshop, &[]).unwrap();
        assert_eq!(
            hydrated.workshop.attribution.url,
            "https://github.com/randax/Platform-Engineering-Workshop/tree/1b6fad43551a720b143d7a52799f81c4c89455cb"
        );
        let module_00 = workshop
            .manifest
            .modules
            .iter()
            .find(|module| module.id == "00")
            .unwrap();
        let module_01 = workshop
            .manifest
            .modules
            .iter()
            .find(|module| module.id == "01")
            .unwrap();
        let catch_up_00 = fs::read_to_string(root.join(&module_00.catch_up_script)).unwrap();
        let catch_up_01 = fs::read_to_string(root.join(&module_01.catch_up_script)).unwrap();

        assert!(!catch_up_00.contains("/scripts/catch-up.sh"));
        assert!(catch_up_00.contains("registry-preflight.ok"));
        assert!(catch_up_00.contains("docker info"));
        assert!(!catch_up_00.contains("test -d .git"));
        assert!(!catch_up_00.contains("MISE_OFFLINE"));
        assert!(!catch_up_01.contains("/scripts/catch-up.sh"));
        assert!(catch_up_01.contains("scripts/create-cluster.sh"));
        assert!(catch_up_01.contains("kubectl wait --for=condition=Ready nodes --all"));
        let module_00_verifier =
            fs::read_to_string(root.join("runtime/source/lab/00-setup/verify.sh")).unwrap();
        assert!(!module_00_verifier.contains("platform-engineering-workshop/.git"));
        let seed_gitea =
            fs::read_to_string(root.join("runtime/source/scripts/seed-gitea.sh")).unwrap();
        assert!(seed_gitea.contains("if [[ ! -d .git ]]"));
        assert!(seed_gitea.contains("git init --initial-branch=main --quiet"));
        assert!(seed_gitea.contains("git add -A"));

        for module in &workshop.manifest.modules {
            let source = fs::read_to_string(root.join(&module.catch_up_script)).unwrap();
            for forbidden in ["MISE_OFFLINE", "localhost:5001", "/solutions/", "mise x "] {
                assert!(
                    !source.contains(forbidden),
                    "module {} catch-up contains legacy source '{forbidden}'",
                    module.id
                );
            }
        }

        let module_07 = workshop
            .manifest
            .modules
            .iter()
            .find(|module| module.id == "07")
            .unwrap();
        let catch_up_07 = fs::read_to_string(root.join(&module_07.catch_up_script)).unwrap();
        assert!(catch_up_07.contains(
            "docker.io/library/busybox@sha256:9532d8c39891ca2ecde4d30d7710e01fb739c87a8b9299685c63704296b16028"
        ));
        assert!(catch_up_07.contains("localhost:30500/library/busybox:1.37.0"));
        assert!(catch_up_07.contains("crane copy --insecure"));
        assert!(!catch_up_07.contains("mise x"));

        let module_09 = workshop
            .manifest
            .modules
            .iter()
            .find(|module| module.id == "09")
            .unwrap();
        let catch_up_09 = fs::read_to_string(root.join(&module_09.catch_up_script)).unwrap();
        let verifier_09 = fs::read_to_string(root.join(&module_09.verify_script)).unwrap();
        let mut previous = 0;
        for expected in [
            "victoria-metrics.yaml",
            "victoria-logs.yaml",
            "victoria-traces.yaml",
            "grafana.yaml",
            "otel-collector.yaml",
            "wait_app victoria-metrics 600",
            "wait_app victoria-logs 600",
            "wait_app victoria-traces 600",
            "wait_app grafana 600",
            "rollout status deployment/grafana --timeout=600s",
            "wait_app otel-collector 600",
            "rollout status deployment/otel-collector-gateway --timeout=600s",
            "rollout status daemonset/otel-collector-agent --timeout=600s",
            "http://localhost:30030/api/health",
            "uploading test image through the portal",
        ] {
            let position = catch_up_09[previous..].find(expected).unwrap_or_else(|| {
                panic!("module 09 catch-up is missing ordered text '{expected}'")
            }) + previous;
            previous = position + expected.len();
        }
        for expected in [
            "victoria-metrics victoria-logs victoria-traces grafana otel-collector",
            "deployment/otel-collector-gateway",
            "daemonset/otel-collector-agent",
            "services/${backend}:http/proxy/health",
            "http://localhost:30030/api/health",
            "/api/datasources/proxy/uid/victoriametrics/api/v1/query?query=up",
            "/api/datasources/uid/victorialogs/health",
            "/api/datasources/proxy/uid/victoriatraces/api/traces?service=cloudbox-portal&limit=20",
            r#"["cloudbox-portal", "cloudbox-uploader", "cloudbox-resizer"]"#,
            "[.processes[]?.serviceName]",
            "VictoriaTraces datasource did not expose one connected upload trace",
        ] {
            assert!(
                verifier_09.contains(expected),
                "module 09 verifier is missing '{expected}'"
            );
        }
        for script in [&module_09.catch_up_script, &module_09.verify_script] {
            assert!(
                Command::new("bash")
                    .arg("-n")
                    .arg(root.join(script))
                    .status()
                    .unwrap()
                    .success(),
                "module 09 script '{}' has invalid shell syntax",
                script
            );
        }
        let grafana_source =
            fs::read_to_string(root.join("runtime/source/gitops/components/grafana/grafana.yaml"))
                .unwrap();
        assert!(
            grafana_source
                .contains("url: http://victoria-logs.observability.svc.cluster.local:9428")
        );
        assert!(grafana_source.contains("type: victoriametrics-logs-datasource"));
        assert!(grafana_source.contains("install-victorialogs-datasource"));
        assert!(
            grafana_source
                .contains("34935dcb7c19107f86a7703ee0a24f40363e0c02483206f3cc9a5de2f5fa4918")
        );
        assert!(!grafana_source.contains("type: loki"));
        assert!(!grafana_source.contains("GF_INSTALL_PLUGINS"));
        assert!(!grafana_source.contains("/select/logsql/query"));
        let grafana_catalog =
            fs::read_to_string(root.join("runtime/source/gitops/catalog/grafana.yaml")).unwrap();
        assert!(grafana_catalog.contains("Browser: http://localhost:30030"));
        assert!(!grafana_catalog.contains("localhost:30031"));

        let verifier_00 = fs::read_to_string(root.join(&module_00.verify_script)).unwrap();
        assert!(!verifier_00.contains("MISE_OFFLINE"));
        assert!(verifier_00.contains("expected_crane_version=0.21.7"));

        let importer = fs::read_to_string(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../scripts/import-platform-engineering-workshop.ts"),
        )
        .unwrap();
        assert!(importer.contains("renderCatchUpScript(module)"));
        assert!(importer.contains("runtime/images.lock"));
        assert!(importer.contains("renderRuntimeBootstrap"));
        assert!(importer.contains("adaptDigestPinnedFault01"));
    }

    #[test]
    fn reference_runtime_bootstrap_has_valid_shell_and_registry_awk() {
        let root =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../workshops/platform-engineering");
        let bootstrap = root.join("runtime/bootstrap.sh");
        let source = fs::read_to_string(&bootstrap).unwrap();
        assert!(source.contains(r#"awk 'NF {sub(/\/.*/, "", $1); print $1}'"#));
        assert!(source.contains("host=registry-1.docker.io"));
        let install_packages = source
            .lines()
            .find(|line| line.starts_with("apt-get install "))
            .unwrap();
        assert!(
            install_packages
                .split_ascii_whitespace()
                .any(|package| package == "docker-cli")
        );
        assert!(
            Command::new("bash")
                .arg("-n")
                .arg(&bootstrap)
                .status()
                .unwrap()
                .success()
        );

        let mut child = Command::new("awk")
            .arg(r#"NF {sub(/\/.*/, "", $1); print $1}"#)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"ghcr.io/siderolabs/talos@sha256:abc\n")
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8(output.stdout).unwrap(), "ghcr.io\n");
    }

    #[test]
    fn reference_talos_config_scopes_etcd_to_control_plane() {
        let root =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../workshops/platform-engineering");
        let source =
            fs::read_to_string(root.join("runtime/source/scripts/create-cluster.sh")).unwrap();
        let image_lock = fs::read_to_string(root.join("runtime/images.lock")).unwrap();
        let common_patch = source
            .split_once("CNI_PATCH=\"$(cat <<'EOF'\n")
            .unwrap()
            .1
            .split_once("\nEOF\n)\"")
            .unwrap()
            .0;
        let control_plane_patch = source
            .split_once("CONTROL_PLANE_PATCH=\"$(cat <<'EOF'\n")
            .unwrap()
            .1
            .split_once("\nEOF\n)\"")
            .unwrap()
            .0;

        let kubernetes_images = [
            (
                "ghcr.io/siderolabs/kubelet:v1.36.2@sha256:\
                 e594fcc880e6d2816b3334e4ddfd586b420ca8c3a4dd2b40e9de1571e69e559a",
                "ghcr.io/siderolabs/kubelet@sha256:",
            ),
            (
                "registry.k8s.io/kube-apiserver:v1.36.2@sha256:\
                 0535dde1a857029209d7effe681c919a1580d2eb24eda4bd122d24e9a372e1b8",
                "registry.k8s.io/kube-apiserver@sha256:",
            ),
            (
                "registry.k8s.io/kube-controller-manager:v1.36.2@sha256:\
                 b3add29a00c3c4763c75a09ec94915e3d0d590b93b3850a97d52970fbd2b2c12",
                "registry.k8s.io/kube-controller-manager@sha256:",
            ),
            (
                "registry.k8s.io/kube-scheduler:v1.36.2@sha256:\
                 94dfc9f285718a06bb873947959b8514ed95dddaa7c74d765cc346fdfa684859",
                "registry.k8s.io/kube-scheduler@sha256:",
            ),
        ];
        for (versioned, digest_only) in kubernetes_images {
            assert!(common_patch.contains(versioned), "{versioned}");
            assert!(
                image_lock.lines().any(|line| line == versioned),
                "{versioned}"
            );
            assert!(!source.contains(digest_only), "{digest_only}");
            assert!(!image_lock.contains(digest_only), "{digest_only}");
        }

        assert!(!common_patch.contains("\n  etcd:"));
        assert!(control_plane_patch.contains(
            "cluster:\n  etcd:\n    image: registry.k8s.io/etcd@sha256:\
             3c2ced08f23b1183e8bd4613064c3fb6b8db5057a4d1f13c3518c76e357a07a8"
        ));
        assert!(source.contains(
            "patches=(\n  --config-patch \"${CNI_PATCH}\"\n  \
             --config-patch-controlplanes \"${CONTROL_PLANE_PATCH}\"\n)"
        ));
        assert!(!source.split_ascii_whitespace().any(|token| matches!(
            token,
            "--config-patch-workers" | "--config-patch-control-plane"
        )));
    }

    #[test]
    fn reference_talos_bootstrap_recovery_is_narrow_and_valid_shell() {
        let root =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../workshops/platform-engineering");
        let create_cluster = root.join("runtime/source/scripts/create-cluster.sh");
        let lib = root.join("runtime/source/scripts/lib.sh");
        let source = fs::read_to_string(&create_cluster).unwrap();

        assert!(source.contains("--save-cluster-logs-archive-path"));
        assert!(source.contains("retry_transient_talos_bootstrap"));
        assert!(source.contains("talosctl cluster show --name"));
        assert!(source.contains("umask 077"));
        assert!(source.contains("mktemp"));
        assert!(source.contains("tar -tzf"));
        assert!(source.contains("tail -n 80"));
        assert!(source.contains("rm -f \"${archive}\""));
        assert!(source.contains("talosctl config context"));
        assert!(source.contains("talosctl config remove \"${CLUSTER_NAME}\" -y"));
        assert!(source.contains("kubectl get --raw=/readyz"));
        assert!(source.contains("deadline=$((SECONDS + 600))"));
        assert!(source.contains("while (( SECONDS < deadline ))"));
        assert!(source.contains("remaining=$((deadline - SECONDS))"));
        assert!(source.contains("timeout --signal=KILL \"${request_timeout}s\""));
        assert!(source.contains("if (( remaining < retry_sleep ))"));
        assert!(source.contains(
            "if is_retryable_talos_bootstrap_timeout_status \"${bootstrap_status}\"; then"
        ));
        assert!(!source.contains("Talos bootstrap retry exceeded its"));
        assert!(!source.contains("for attempt in $(seq 1 60)"));
        assert!(
            !source
                .lines()
                .any(|line| line.trim_start().starts_with("--force"))
        );
        assert!(
            Command::new("bash")
                .arg("-n")
                .arg(&create_cluster)
                .status()
                .unwrap()
                .success()
        );

        let classifier = Command::new("bash")
            .arg("-c")
            .arg(
                r#"
set -euo pipefail
source "$1"
initial='creating controlplane nodes
creating worker nodes
waiting for Talos API (to bootstrap the cluster)
bootstrap error: 4 error(s) occurred:
	rpc error: code = Unavailable desc = connection error: desc = "transport: authentication handshake failed: EOF"
	rpc error: code = Unavailable desc = connection error: desc = "transport: authentication handshake failed: read tcp 127.0.0.1:50394->127.0.0.1:36519: read: connection reset by peer"
	rpc error: code = Unavailable desc = connection error: desc = "transport: authentication handshake failed: read tcp 127.0.0.1:59914->127.0.0.1:36519: read: connection reset by peer"
	timeout'
is_initial_talos_bootstrap_unavailable_eof "$initial"
! is_initial_talos_bootstrap_unavailable_eof 'bootstrap error: rpc error: code = Unavailable desc = authentication handshake failed: EOF'
post_rpc='creating controlplane nodes
creating worker nodes
waiting for Talos API (to bootstrap the cluster)
bootstrapping cluster
bootstrap error: rpc error: code = Unavailable desc = authentication handshake failed: EOF'
is_initial_talos_bootstrap_unavailable_eof "$post_rpc"
! is_initial_talos_bootstrap_unavailable_eof 'creating worker nodes
creating controlplane nodes
waiting for Talos API (to bootstrap the cluster)
bootstrap error: rpc error: code = Unavailable desc = authentication handshake failed: EOF
	timeout'
! is_initial_talos_bootstrap_unavailable_eof 'creating controlplane nodes
creating worker nodes
waiting for Talos API (to bootstrap the cluster)
bootstrap error: rpc error: code = DeadlineExceeded desc = authentication handshake failed: EOF
	timeout'
is_retry_talos_bootstrap_unavailable_eof 'error executing bootstrap: rpc error: code = Unavailable desc = connection error: desc = "transport: authentication handshake failed: EOF"'
! is_retry_talos_bootstrap_unavailable_eof 'bootstrap error: rpc error: code = Unavailable desc = authentication handshake failed: EOF'
! is_retry_talos_bootstrap_unavailable_eof 'error executing bootstrap: rpc error: code = Unavailable desc = unrelated'
is_retryable_talos_bootstrap_timeout_status 124
is_retryable_talos_bootstrap_timeout_status 137
! is_retryable_talos_bootstrap_timeout_status 0
! is_retryable_talos_bootstrap_timeout_status 1
is_provisional_talos_bootstrap_already_exists 'error executing bootstrap: rpc error: code = AlreadyExists desc = etcd data directory is not empty'
! is_provisional_talos_bootstrap_already_exists 'rpc error: code = AlreadyExists desc = etcd data directory is not empty'
! is_provisional_talos_bootstrap_already_exists 'rpc error: code = AlreadyExists desc = another resource exists'

redacted="$(
  printf '%s\n' \
    '{"token": "jsonSecret42"}' \
    '{"access_token": "jsonAccessSecret42"}' \
    '"password": "yamlQuotedSecret42"' \
    'client_secret: yamlPlainSecret42' \
    'refresh_token: yamlRefreshSecret42' \
    'Authorization: Bearer bearerSecret42' \
    'Authorization: Basic basicSecret42' \
    'https://urlUserSecret:urlPassSecret@example.invalid/fail' \
    'https://example.invalid/error?token=queryTokenSecret&api_key=queryKeySecret' \
    'bootstrap abcdef.0123456789abcdef failed' \
    'fatal apid failed' \
    | redact_talos_diagnostic_line
)"
for secret in \
  jsonSecret42 jsonAccessSecret42 yamlQuotedSecret42 yamlPlainSecret42 \
  yamlRefreshSecret42 bearerSecret42 basicSecret42 \
  urlUserSecret urlPassSecret queryTokenSecret queryKeySecret \
  abcdef.0123456789abcdef
do
  [[ "${redacted}" != *"${secret}"* ]]
done
[[ "${redacted}" == *"[REDACTED]"* ]]
[[ "${redacted}" == *"fatal apid failed"* ]]
"#,
            )
            .arg("bash")
            .arg(&lib)
            .status()
            .unwrap();
        assert!(classifier.success());
    }

    #[test]
    fn renders_named_kino_probes_to_retained_manual_verifiers() {
        let workshop = fixture();
        let config = render_probe_config(&workshop.manifest, 10, 120).unwrap();
        assert!(config.contains("probe \"module-00-ready\""));
        assert!(config.contains("/usr/local/lib/intar-workshop/verifiers/00.sh"));
        assert!(config.contains("json_path = \"$.passed\""));
        assert!(!config.contains("catch-up"));
        assert!(!config.contains("solution"));
        assert!(!config.contains("facilitator"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn guest_future_bridge_does_not_start_a_nested_runtime() {
        let value = run_guest_future(async { Ok::<_, anyhow::Error>(42) }).unwrap();
        assert_eq!(value, 42);
    }

    #[test]
    fn synchronous_ssh_wait_keeps_russh_driver_runtime_alive() {
        assert!(tokio::runtime::Handle::try_current().is_err());
        let key = generate_build_ssh_key().unwrap();
        let mut rng = russh::keys::key::safe_rng();
        let host_key =
            russh::keys::PrivateKey::random(&mut rng, russh::keys::ssh_key::Algorithm::Ed25519)
                .unwrap();
        let server = ReadinessSshServer {
            allowed_public_key: key.private_key.public_key().clone(),
            host_key,
        };
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
        let server_thread = thread::spawn(move || {
            current_thread_runtime().unwrap().block_on(async move {
                let listener = tokio::net::TcpListener::bind((SSH_HOST, 0)).await.unwrap();
                let address = listener.local_addr().unwrap();
                let mut config = russh::server::Config::default();
                config.keys.push(server.host_key.clone());
                let mut server = server;
                let running = server.run_on_socket(Arc::new(config), &listener);
                let handle = running.handle();
                ready_tx.send((address, handle)).unwrap();
                running.await.unwrap();
            });
        });
        let (address, server_handle) = ready_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("readiness SSH server did not start");

        let mut child = Command::new("sleep").arg("30").spawn().unwrap();
        let serial_root = tempfile::tempdir().unwrap();
        let result = wait_for_guest_ssh(
            &mut child,
            address.port(),
            "ubuntu",
            &key,
            5,
            &serial_root.path().join("serial.log"),
            &CancellationToken::new(),
        );

        terminate_child(&mut child).unwrap();
        server_handle.shutdown("test complete".to_owned());
        server_thread.join().unwrap();
        result.unwrap();
    }

    #[test]
    fn cancelled_backend_never_launches_a_guest() {
        let temp = tempfile::tempdir().unwrap();
        let config = test_config(temp.path());
        fs::create_dir(&config.work_root).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let launcher = FakeLauncher {
            events: Arc::clone(&events),
        };
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let mut backend = KvmWorkshopBackend::with_launcher_and_cancellation(
            config,
            Box::new(launcher),
            cancellation,
        );
        let workshop = fixture();
        let bundle_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../intar-workshop-manifest/tests/fixtures/platform-engineering-workshop");

        let error = backend
            .begin(&BeginWorkshopBuild {
                publication_id: "publication-cancelled",
                bundle_root: &bundle_root,
                manifest: &workshop.manifest,
                architecture: ImageArchitecture::X86_64,
            })
            .unwrap_err();

        assert!(error.to_string().contains("cancelled"));
        assert!(events.lock().unwrap().is_empty());
        assert!(backend.job.is_none());
    }

    #[test]
    fn rejects_multi_vm_manifest_before_launch() {
        let mut workshop = fixture().manifest;
        workshop
            .workspace
            .vms
            .push(workshop.workspace.vms[0].clone());
        let error = enforce_single_vm_contract(&workshop).unwrap_err();
        assert!(error.to_string().contains("exactly one"));
    }

    #[test]
    fn cold_boot_checks_the_participant_boundary_before_verification() {
        let temp = tempfile::tempdir().unwrap();
        let config = test_config(temp.path());
        fs::create_dir(&config.work_root).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let launcher = FakeLauncher {
            events: Arc::clone(&events),
        };
        let mut backend = KvmWorkshopBackend::with_launcher(config.clone(), Box::new(launcher));
        let work = tempfile::tempdir_in(&config.work_root).unwrap();
        let root = work.path().to_path_buf();
        let raw = root.join("sealed.raw");
        let compressed = root.join("checkpoint.raw.zst");
        let checksum = root.join("checkpoint.raw.zst.sha256");
        fs::write(&raw, vec![0_u8; 4096]).unwrap();
        intar_image_build::write_raw_zstd_artifact(&raw, &compressed, &checksum).unwrap();
        fs::remove_file(&raw).unwrap();
        let workshop = fixture().manifest;
        backend.job = Some(JobState {
            _work: work,
            root,
            bundle_root: PathBuf::from("/bundle"),
            vm: workshop.workspace.vms[0].clone(),
            image: config.images[0].clone(),
            allowed_scripts: BTreeMap::new(),
            module_ids: vec!["00".to_string()],
            build_material_archive: None,
            active: None,
            mode: GuestMode::Mutable,
            mutable_disk: PathBuf::from("unused"),
            generation: 0,
            stopped_for_seal: true,
        });
        backend
            .cold_boot_checkpoint(
                "checkpoint-00",
                &[SealedVmArtifact {
                    vm_id: "workspace".to_string(),
                    image_key: ImageKey {
                        scenario: "workshop-publication-checkpoint-00".to_string(),
                        vm: "workspace".to_string(),
                        arch: ImageArchitecture::X86_64,
                    },
                    image_path: compressed,
                    image_format: ImageFormat::RawZstd,
                    image_virtual_size_bytes: 4096,
                    kernel_path: config.images[0].kernel.clone(),
                    initrd_path: config.images[0].initrd.clone(),
                    boot_cmdline: config.images[0].boot_cmdline.clone(),
                }],
            )
            .unwrap();

        let events = events.lock().unwrap();
        assert_eq!(events[0], "boot:4:16384");
        assert!(events[1].starts_with("assert-participant-boundary:"));
        assert!(events[1].contains("/opt/debian13-workshop/.git"));
        assert!(events[1].contains("/opt/debian13-workshop/solutions"));
    }

    #[test]
    fn direct_cloud_proof_uses_a_fresh_clean_disk_and_exact_bundle() {
        let temp = tempfile::tempdir().unwrap();
        let mut config = test_config(temp.path());
        enable_runtime_bundle_proof(&mut config, temp.path());
        fs::create_dir(&config.work_root).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let launcher = FakeLauncher {
            events: Arc::clone(&events),
        };
        let mut backend = KvmWorkshopBackend::with_launcher(config.clone(), Box::new(launcher));
        let work = tempfile::tempdir_in(&config.work_root).unwrap();
        let root = work.path().to_path_buf();
        let workshop = fixture().manifest;
        backend.job = Some(JobState {
            _work: work,
            root,
            bundle_root: PathBuf::from("/bundle"),
            vm: workshop.workspace.vms[0].clone(),
            image: config.images[0].clone(),
            allowed_scripts: BTreeMap::new(),
            module_ids: vec!["00".to_string()],
            build_material_archive: None,
            active: None,
            mode: GuestMode::ColdProof,
            mutable_disk: PathBuf::from("unused"),
            generation: 1,
            stopped_for_seal: true,
        });
        let bytes = b"exact-signed-runtime-bundle";
        let sha256 = sha256_bytes(bytes);
        let artifact = crate::contracts::RuntimeBundleArtifact {
            sha256,
            compression: crate::contracts::RuntimeBundleCompression::Zstd,
            signature_b64: "signature".to_owned(),
            signing_key_id: "runtime-test-v1".to_owned(),
            workspace_agent_sha256: None,
        };
        backend
            .cold_boot_runtime_bundle(&RuntimeBundleColdBoot {
                checkpoint_id: "checkpoint-00",
                system_image: "debian-13",
                bytes,
                artifact: &artifact,
                signing_public_key_b64: "public-key",
                max_checkpoint_bytes: 1024,
            })
            .unwrap();

        let events = events.lock().unwrap();
        assert_eq!(events[0], "boot:4:16384");
        assert_eq!(events[1], "runtime-proof:checkpoint-00");
        assert_eq!(events[2], "shutdown");
    }

    #[test]
    fn shell_quote_never_exposes_operator_path_metacharacters() {
        assert_eq!(
            shell_quote("/opt/intar's sanitizer"),
            "'/opt/intar'\\''s sanitizer'"
        );
    }

    #[test]
    fn captured_root_owned_build_material_archive_is_removed_with_sudo() {
        assert_eq!(
            captured_build_material_cleanup_command(),
            "sudo -- /usr/bin/rm -f -- /tmp/intar-workshop-build-material.tar.gz"
        );
    }
}
