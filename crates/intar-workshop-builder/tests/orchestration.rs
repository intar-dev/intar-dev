#![allow(clippy::unwrap_used)]

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use anyhow::{Result, bail};
use intar_contracts::catalog::ImageFormat;
use intar_image_upload::{PublishArtifactFile, UploadImageBlob};
use intar_workshop_builder::{
    BeginWorkshopBuild, CanonicalScript, CanonicalScriptKind, ProcessOutcome, PublicationRegistry,
    RuntimeBundleColdBoot, RuntimeBundleColdBootProof, RuntimeBundleCompression,
    RuntimeBundleSigningConfig, SealCheckpoint, SealedVmArtifact, WorkerConfig,
    WorkshopBlobPublisher, WorkshopExecutionBackend, WorkshopPublicationClaim,
    WorkshopPublicationResult, process_next, process_next_until_cancelled,
};
use tokio_util::sync::CancellationToken;

struct FakeRegistry {
    claim: Mutex<Option<WorkshopPublicationClaim>>,
    bundle: Vec<u8>,
    results: Mutex<Vec<WorkshopPublicationResult>>,
    images: Mutex<Vec<(String, String, String)>>,
    artifacts: Mutex<Vec<String>>,
    refreshes: Mutex<usize>,
}

#[allow(async_fn_in_trait)]
impl PublicationRegistry for FakeRegistry {
    async fn refresh_auth(&self) -> Result<()> {
        *self.refreshes.lock().unwrap() += 1;
        Ok(())
    }

    async fn claim_next(&self) -> Result<Option<WorkshopPublicationClaim>> {
        Ok(self.claim.lock().unwrap().take())
    }

    async fn download_bundle(&self, _bundle_url: &str, _max_bytes: u64) -> Result<Vec<u8>> {
        Ok(self.bundle.clone())
    }

    async fn post_result(
        &self,
        _publication_id: &str,
        result: &WorkshopPublicationResult,
    ) -> Result<()> {
        self.results.lock().unwrap().push(result.clone());
        Ok(())
    }
}

impl WorkshopBlobPublisher for FakeRegistry {
    fn upload_image(&self, image: &UploadImageBlob) -> Result<()> {
        self.images.lock().unwrap().push((
            image.image_key.clone(),
            image.scenario_id.clone(),
            image.vm_name.clone(),
        ));
        Ok(())
    }

    fn upload_artifact(&self, artifact: &PublishArtifactFile) -> Result<()> {
        self.artifacts.lock().unwrap().push(artifact.sha256.clone());
        Ok(())
    }
}

struct FakeBackend {
    output: tempfile::TempDir,
    events: Vec<String>,
    fail_catch_up: Option<String>,
    cancel_on_begin: Option<CancellationToken>,
    disk_bytes_by_vm: BTreeMap<String, u64>,
    aborted: bool,
}

impl FakeBackend {
    fn new() -> Self {
        Self {
            output: tempfile::tempdir().unwrap(),
            events: Vec::new(),
            fail_catch_up: None,
            cancel_on_begin: None,
            disk_bytes_by_vm: BTreeMap::new(),
            aborted: false,
        }
    }
}

impl WorkshopExecutionBackend for FakeBackend {
    fn begin(&mut self, request: &BeginWorkshopBuild<'_>) -> Result<()> {
        self.events
            .push(format!("begin:{}", request.publication_id));
        self.disk_bytes_by_vm = request
            .manifest
            .workspace
            .vms
            .iter()
            .map(|vm| {
                (
                    vm.id.clone(),
                    u64::from(vm.disk_gib) * 1_024 * 1_024 * 1_024,
                )
            })
            .collect();
        if let Some(cancellation) = &self.cancel_on_begin {
            cancellation.cancel();
        }
        Ok(())
    }

    fn run_canonical_script(&mut self, script: &CanonicalScript<'_>) -> Result<()> {
        let kind = match script.kind {
            CanonicalScriptKind::CatchUp => "catch",
            CanonicalScriptKind::Verify => "verify",
        };
        self.events.push(format!("{kind}:{}", script.module_id));
        if script.kind == CanonicalScriptKind::CatchUp
            && self.fail_catch_up.as_deref() == Some(script.module_id)
        {
            bail!("injected catch-up failure");
        }
        assert!(script.source_path.is_file());
        Ok(())
    }

    fn sanitize_and_shutdown(&mut self, checkpoint_id: &str) -> Result<()> {
        self.events.push(format!("sanitize:{checkpoint_id}"));
        Ok(())
    }

    fn seal_checkpoint(&mut self, request: &SealCheckpoint<'_>) -> Result<Vec<SealedVmArtifact>> {
        self.events.push(format!("seal:{}", request.checkpoint_id));
        request
            .targets
            .iter()
            .map(|target| {
                let prefix = format!("{}-{}", request.checkpoint_id, target.vm_id);
                let image_path = self.output.path().join(format!("{prefix}.raw.zst"));
                let kernel_path = self.output.path().join(format!("{prefix}.kernel"));
                let initrd_path = self.output.path().join(format!("{prefix}.initrd"));
                std::fs::write(&image_path, format!("image:{prefix}"))?;
                std::fs::write(&kernel_path, b"kernel")?;
                std::fs::write(&initrd_path, b"initrd")?;
                Ok(SealedVmArtifact {
                    vm_id: target.vm_id.clone(),
                    image_key: target.image_key.clone(),
                    image_path,
                    image_format: ImageFormat::RawZstd,
                    image_virtual_size_bytes: self.disk_bytes_by_vm[&target.vm_id],
                    kernel_path,
                    initrd_path,
                    boot_cmdline: intar_image_build::PUBLISHED_BOOT_CMDLINE.to_owned(),
                })
            })
            .collect()
    }

    fn cold_boot_checkpoint(
        &mut self,
        checkpoint_id: &str,
        _artifacts: &[SealedVmArtifact],
    ) -> Result<()> {
        self.events.push(format!("cold:{checkpoint_id}"));
        Ok(())
    }

    fn finish_cold_boot(&mut self, checkpoint_id: &str) -> Result<()> {
        self.events.push(format!("cold-stop:{checkpoint_id}"));
        Ok(())
    }

    fn cold_boot_runtime_bundle(
        &mut self,
        request: &RuntimeBundleColdBoot<'_>,
    ) -> Result<RuntimeBundleColdBootProof> {
        assert_eq!(request.system_image, "debian-13");
        assert!(!request.bytes.is_empty());
        assert_eq!(request.artifact.sha256.len(), 64);
        assert_eq!(request.signing_public_key_b64.len(), 44);
        self.events
            .push(format!("runtime-cold:{}", request.checkpoint_id));
        Ok(RuntimeBundleColdBootProof {
            workspace_agent_sha256: "a".repeat(64),
        })
    }

    fn resume_from_checkpoint(
        &mut self,
        checkpoint_id: &str,
        _artifacts: &[SealedVmArtifact],
    ) -> Result<()> {
        self.events.push(format!("resume:{checkpoint_id}"));
        Ok(())
    }

    fn finish(&mut self) -> Result<()> {
        self.events.push("finish".to_owned());
        Ok(())
    }

    fn abort(&mut self) {
        self.aborted = true;
        self.events.push("abort".to_owned());
    }
}

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../intar-workshop-manifest/tests/fixtures/platform-engineering-workshop")
}

fn setup() -> (FakeRegistry, WorkerConfig, tempfile::TempDir) {
    let bundle = intar_workshop_manifest::build_bundle(fixture()).unwrap();
    let required_checkpoint_ids = bundle
        .workshop
        .manifest
        .modules
        .iter()
        .map(|module| module.checkpoint.clone())
        .collect();
    let registry = FakeRegistry {
        claim: Mutex::new(Some(WorkshopPublicationClaim {
            publication_id: "publication-01".to_owned(),
            workshop_slug: bundle.workshop.manifest.workshop.id.clone(),
            content_hash: bundle.sha256,
            required_checkpoint_ids,
            bundle_url: "/agent/registry/workshop-publications/publication-01/bundle".to_owned(),
        })),
        bundle: bundle.bytes,
        results: Mutex::new(Vec::new()),
        images: Mutex::new(Vec::new()),
        artifacts: Mutex::new(Vec::new()),
        refreshes: Mutex::new(0),
    };
    let temporary = tempfile::tempdir().unwrap();
    let signing_key_path = temporary.path().join("runtime-signing-key");
    std::fs::write(&signing_key_path, [17_u8; 32]).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&signing_key_path, std::fs::Permissions::from_mode(0o600))
            .unwrap();
    }
    let worker = WorkerConfig {
        work_root: temporary.path().join("work"),
        runtime_bundle_signing: Some(RuntimeBundleSigningConfig {
            key_id: "runtime-test-v1".to_owned(),
            private_key_file: Some(signing_key_path),
            private_key_env: None,
            compression: RuntimeBundleCompression::Zstd,
        }),
        ..WorkerConfig::default()
    };
    (registry, worker, temporary)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn builds_uploads_and_commits_all_checkpoints_in_order() {
    let (registry, worker, _temporary) = setup();
    let mut backend = FakeBackend::new();

    let outcome = process_next(&registry, &mut backend, &worker)
        .await
        .unwrap();

    assert_eq!(
        outcome,
        ProcessOutcome::Succeeded {
            publication_id: "publication-01".to_owned()
        }
    );
    assert!(!backend.aborted);
    assert_eq!(
        backend.events.first().map(String::as_str),
        Some("begin:publication-01")
    );
    assert_eq!(backend.events.get(1).map(String::as_str), Some("catch:00"));
    assert_eq!(backend.events.get(2).map(String::as_str), Some("verify:00"));
    assert_eq!(
        backend.events.get(3).map(String::as_str),
        Some("sanitize:checkpoint-00")
    );
    assert_eq!(
        backend.events.get(4).map(String::as_str),
        Some("seal:checkpoint-00")
    );
    assert_eq!(
        backend.events.get(5).map(String::as_str),
        Some("cold:checkpoint-00")
    );
    assert_eq!(backend.events.get(6).map(String::as_str), Some("verify:00"));
    assert_eq!(
        backend.events.get(7).map(String::as_str),
        Some("cold-stop:checkpoint-00")
    );
    assert_eq!(
        backend.events.get(8).map(String::as_str),
        Some("runtime-cold:checkpoint-00")
    );
    assert_eq!(
        backend.events.get(9).map(String::as_str),
        Some("resume:checkpoint-00")
    );
    assert_eq!(backend.events.last().map(String::as_str), Some("finish"));

    let results = registry.results.lock().unwrap();
    let WorkshopPublicationResult::Succeeded {
        manifest,
        checkpoints,
    } = &results[0]
    else {
        panic!("expected success result");
    };
    assert_eq!(checkpoints.len(), 11);
    assert_eq!(manifest.duration_minutes, 240);
    assert_eq!(manifest.workspace.checkpoints.len(), 11);
    assert_eq!(manifest.workshop.attribution.license, "Apache-2.0");
    assert_eq!(
        checkpoints[0].vm_images[0].image_key.scenario,
        "workshop-publication-01-checkpoint-00"
    );
    assert_eq!(checkpoints[0].vm_images[0].image_key.vm, "workspace");
    assert!(checkpoints.iter().all(|checkpoint| checkpoint.sanitized));
    assert!(
        checkpoints
            .iter()
            .all(|checkpoint| checkpoint.cold_boot_verified)
    );
    assert!(
        checkpoints
            .iter()
            .all(|checkpoint| checkpoint.runtime_bundle_cold_boot_verified)
    );
    assert!(
        checkpoints
            .iter()
            .all(|checkpoint| checkpoint.runtime_bundle.is_some())
    );
    assert_eq!(
        checkpoints
            .iter()
            .filter_map(|checkpoint| checkpoint.runtime_bundle.as_ref())
            .map(|bundle| bundle.sha256.as_str())
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        11
    );
    let json = serde_json::to_value(&results[0]).unwrap();
    assert_eq!(json["status"], "succeeded");
    assert_eq!(json["manifest"]["schemaVersion"], 1);
    assert_eq!(
        json["checkpoints"][0]["vm_images"][0]["image_format"],
        "raw_zstd"
    );
    assert_eq!(
        json["checkpoints"][0]["vm_images"][0]["boot_cmdline"],
        intar_image_build::PUBLISHED_BOOT_CMDLINE
    );
    assert!(json["checkpoints"][0]["vm_images"][0].get("boot").is_none());
    assert_eq!(
        json["checkpoints"][0]["runtime_bundle"]["compression"],
        "zstd"
    );
    assert_eq!(
        json["checkpoints"][0]["runtime_bundle_cold_boot_verified"],
        true
    );
    assert_eq!(
        json["checkpoints"][0]["runtime_bundle"]["signing_key_id"],
        "runtime-test-v1"
    );
    assert_eq!(
        json["checkpoints"][0]["runtime_bundle"]["workspace_agent_sha256"],
        "a".repeat(64)
    );
    assert_eq!(
        json["checkpoints"][0]["runtime_bundle"]["signature_b64"]
            .as_str()
            .unwrap()
            .len(),
        88
    );
    assert_eq!(registry.images.lock().unwrap().len(), 11);
    // Kernel and initrd contents are identical across the fake checkpoints,
    // so those two uploads are deduplicated. Each checkpoint also has exactly
    // one distinct content-addressed reconstruction bundle.
    assert_eq!(registry.artifacts.lock().unwrap().len(), 13);
    // Once per checkpoint before blob upload, once before the final result.
    assert_eq!(*registry.refreshes.lock().unwrap(), 12);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reports_one_terminal_failure_and_aborts_the_guest_workflow() {
    let (registry, worker, _temporary) = setup();
    let mut backend = FakeBackend::new();
    backend.fail_catch_up = Some("01".to_owned());

    let outcome = process_next(&registry, &mut backend, &worker)
        .await
        .unwrap();

    let ProcessOutcome::Failed { error, .. } = outcome else {
        panic!("expected failed outcome");
    };
    assert!(error.contains("injected catch-up failure"));
    assert!(backend.aborted);
    let results = registry.results.lock().unwrap();
    assert_eq!(results.len(), 1);
    let WorkshopPublicationResult::Failed { error } = &results[0] else {
        panic!("expected a terminal failure report");
    };
    assert!(error.contains("catch-up for module '01' failed"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_aborts_an_active_build_without_reporting_terminal_failure() {
    let (registry, worker, _temporary) = setup();
    let cancellation = CancellationToken::new();
    let mut backend = FakeBackend::new();
    backend.cancel_on_begin = Some(cancellation.clone());

    let error = process_next_until_cancelled(&registry, &mut backend, &worker, &cancellation)
        .await
        .unwrap_err();

    assert!(format!("{error:#}").contains("interrupted by shutdown"));
    assert!(backend.aborted);
    assert!(registry.results.lock().unwrap().is_empty());
    assert_eq!(*registry.refreshes.lock().unwrap(), 0);
}
