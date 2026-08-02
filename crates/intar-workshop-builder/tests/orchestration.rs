#![allow(clippy::unwrap_used)]

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use anyhow::{Result, bail};
use intar_contracts::catalog::ImageFormat;
use intar_image_upload::{PublishArtifactFile, UploadImageBlob};
use intar_workshop_builder::{
    BeginWorkshopBuild, CanonicalScript, CanonicalScriptKind, ClaimedRuntimeProfileObservation,
    HydratedRuntimeProfile, ProcessOutcome, PublicationRegistry, RuntimeBundleColdBoot,
    RuntimeBundleColdBootProof, RuntimeBundleCompression, RuntimeBundleSigningConfig,
    SealCheckpoint, SealedVmArtifact, WorkerConfig, WorkshopBlobPublisher,
    WorkshopExecutionBackend, WorkshopPublicationClaim, WorkshopPublicationResult, process_next,
    process_next_until_cancelled,
};
use intar_workshop_manifest::{
    ProviderArchitecture, RuntimeProfileObservation, RuntimeProviderKind,
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
            .map(|vm| (vm.id.clone(), u64::from(vm.disk_mib) * 1_024 * 1_024))
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

#[derive(Clone, Copy)]
enum TestRuntime {
    AgentKvm,
    DirectCloud,
    Mixed,
}

fn setup(runtime: TestRuntime) -> (FakeRegistry, WorkerConfig, tempfile::TempDir) {
    let temporary = tempfile::tempdir().unwrap();
    let root = match runtime {
        TestRuntime::AgentKvm => agent_kvm_fixture(&temporary),
        TestRuntime::DirectCloud => fixture(),
        TestRuntime::Mixed => mixed_fixture(&temporary),
    };
    let bundle = intar_workshop_manifest::build_bundle(root).unwrap();
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
            runtime_profile_observations: claimed_observations(runtime),
        })),
        bundle: bundle.bytes,
        results: Mutex::new(Vec::new()),
        images: Mutex::new(Vec::new()),
        artifacts: Mutex::new(Vec::new()),
        refreshes: Mutex::new(0),
    };
    let runtime_bundle_signing = (!matches!(runtime, TestRuntime::AgentKvm)).then(|| {
        let signing_key_path = temporary.path().join("runtime-signing-key");
        std::fs::write(&signing_key_path, [17_u8; 32]).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&signing_key_path, std::fs::Permissions::from_mode(0o600))
                .unwrap();
        }
        RuntimeBundleSigningConfig {
            key_id: "runtime-test-v1".to_owned(),
            private_key_file: Some(signing_key_path),
            private_key_env: None,
            compression: RuntimeBundleCompression::Zstd,
        }
    });
    let worker = WorkerConfig {
        work_root: temporary.path().join("work"),
        runtime_bundle_signing,
        ..WorkerConfig::default()
    };
    (registry, worker, temporary)
}

fn claimed_observations(runtime: TestRuntime) -> Vec<ClaimedRuntimeProfileObservation> {
    if matches!(runtime, TestRuntime::AgentKvm) {
        return Vec::new();
    }
    vec![
        ClaimedRuntimeProfileObservation {
            profile_id: "hetzner-cpx42".to_owned(),
            observation: RuntimeProfileObservation {
                provider: RuntimeProviderKind::HetznerCloud,
                machine_type: "cpx42".to_owned(),
                resolved_system_image: "hetzner/image/123456/debian-13".to_owned(),
                system_image_is_immutable: true,
                architecture: ProviderArchitecture::X86_64,
                cores: 8,
                memory_mib: 16_384,
                disk_mib: 160 * 1_024,
                deprecated: false,
                available_locations: vec!["nbg1".to_owned(), "fsn1".to_owned(), "hel1".to_owned()],
            },
        },
        ClaimedRuntimeProfileObservation {
            profile_id: "gcp-e2-standard-4".to_owned(),
            observation: RuntimeProfileObservation {
                provider: RuntimeProviderKind::GcpCompute,
                machine_type: "e2-standard-4".to_owned(),
                resolved_system_image: "projects/debian-cloud/global/images/debian-13-20260715"
                    .to_owned(),
                system_image_is_immutable: true,
                architecture: ProviderArchitecture::X86_64,
                cores: 4,
                memory_mib: 16_384,
                disk_mib: 32 * 1_024,
                deprecated: false,
                available_locations: vec![
                    "europe-west3-a".to_owned(),
                    "europe-west3-b".to_owned(),
                    "europe-west3-c".to_owned(),
                ],
            },
        },
    ]
}

fn mixed_fixture(temporary: &tempfile::TempDir) -> PathBuf {
    let source = fixture();
    let validated = intar_workshop_manifest::load_and_validate(&source).unwrap();
    let destination = temporary.path().join("mixed-fixture");
    for relative in validated.source_files {
        let target = destination.join(&relative);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::copy(source.join(&relative), target).unwrap();
    }
    let manifest_path = destination.join("workshop.hcl");
    let manifest = std::fs::read_to_string(&manifest_path).unwrap();
    let marker = "  runtime_profile \"hetzner-cpx42\" {";
    assert!(manifest.contains(marker));
    std::fs::write(
        manifest_path,
        manifest.replacen(
            marker,
            "  runtime_profile \"agent-kvm\" {\n    provider = \"agent_kvm\"\n    vm_id = \"workspace\"\n    system_image = \"platform-workshop-debian13\"\n  }\n\n  runtime_profile \"hetzner-cpx42\" {",
            1,
        ),
    )
    .unwrap();
    destination
}

fn agent_kvm_fixture(temporary: &tempfile::TempDir) -> PathBuf {
    let source = fixture();
    let validated = intar_workshop_manifest::load_and_validate(&source).unwrap();
    let destination = temporary.path().join("agent-kvm-fixture");
    for relative in validated.source_files {
        let target = destination.join(&relative);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::copy(source.join(&relative), target).unwrap();
    }
    let manifest_path = destination.join("workshop.hcl");
    let manifest = std::fs::read_to_string(&manifest_path).unwrap();
    let start = manifest
        .find("  runtime_profile \"hetzner-cpx42\"")
        .unwrap();
    let end = manifest.find("  application \"gitea\"").unwrap();
    let mut agent_manifest = manifest;
    agent_manifest.replace_range(
        start..end,
        "  runtime_profile \"agent-kvm\" {\n    provider = \"agent_kvm\"\n    vm_id = \"workspace\"\n    system_image = \"platform-workshop-debian13\"\n  }\n\n",
    );
    std::fs::write(manifest_path, agent_manifest).unwrap();
    destination
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn builds_uploads_and_commits_all_checkpoints_in_order() {
    let (registry, worker, _temporary) = setup(TestRuntime::AgentKvm);
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
    assert_eq!(checkpoints[0].covered_module_ids, ["00"]);
    assert_eq!(
        checkpoints[9].covered_module_ids,
        ["00", "01", "02", "03", "04", "05", "06", "07", "08", "09"]
    );
    assert_eq!(
        checkpoints[10].covered_module_ids,
        [
            "00", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10"
        ]
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
            .all(|checkpoint| !checkpoint.runtime_bundle_cold_boot_verified)
    );
    assert!(
        checkpoints
            .iter()
            .all(|checkpoint| !checkpoint.provider_verification_pending)
    );
    assert!(
        checkpoints
            .iter()
            .all(|checkpoint| checkpoint.runtime_bundle.is_none())
    );
    let json = serde_json::to_value(&results[0]).unwrap();
    assert_eq!(json["status"], "succeeded");
    assert_eq!(json["manifest"]["schemaVersion"], 2);
    assert_eq!(
        json["manifest"]["workspace"]["runtimeProfiles"][0]["provider"],
        "agent_kvm"
    );
    assert_eq!(
        json["manifest"]["workspace"]["runtimeProfiles"][0]["requestedSystemImage"],
        "platform-workshop-debian13"
    );
    assert_eq!(
        json["manifest"]["workspace"]["runtimeProfiles"][0]["immutableSystemImage"],
        "platform-workshop-debian13"
    );
    assert_eq!(
        json["manifest"]["workspace"]["runtimeProfiles"][0]["hardware"],
        serde_json::json!({
            "architecture": "x86_64",
            "cpuMillis": 4000,
            "providerCpuCount": 4,
            "memoryMib": 16384,
            "diskMib": 32768
        })
    );
    assert!(
        json["manifest"]["workspace"]["runtimeProfiles"][0]
            .get("machineType")
            .is_none()
    );
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
        json["checkpoints"][0]["runtime_bundle_cold_boot_verified"],
        false
    );
    assert_eq!(
        json["checkpoints"][0]["covered_module_ids"],
        serde_json::json!(["00"])
    );
    assert!(
        json["checkpoints"][0]
            .get("provider_verification_pending")
            .is_none()
    );
    assert!(json["checkpoints"][0].get("runtime_bundle").is_none());
    assert_eq!(registry.images.lock().unwrap().len(), 11);
    // Kernel and initrd contents are identical across the fake checkpoints,
    // so those two uploads are deduplicated.
    assert_eq!(registry.artifacts.lock().unwrap().len(), 2);
    // Once per checkpoint before blob upload, once before the final result.
    assert_eq!(*registry.refreshes.lock().unwrap(), 12);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn direct_provider_reports_deterministic_pending_bundles_without_backend_calls() {
    let (first_registry, first_worker, _first_temporary) = setup(TestRuntime::DirectCloud);
    let mut first_backend = FakeBackend::new();
    let first_outcome = process_next(&first_registry, &mut first_backend, &first_worker)
        .await
        .unwrap();

    let (second_registry, second_worker, _second_temporary) = setup(TestRuntime::DirectCloud);
    let mut second_backend = FakeBackend::new();
    let second_outcome = process_next(&second_registry, &mut second_backend, &second_worker)
        .await
        .unwrap();

    assert_eq!(first_outcome, second_outcome);
    assert!(first_backend.events.is_empty());
    assert!(!first_backend.aborted);
    assert!(second_backend.events.is_empty());
    assert!(!second_backend.aborted);

    let first_results = first_registry.results.lock().unwrap().clone();
    let second_results = second_registry.results.lock().unwrap().clone();
    assert_eq!(first_results, second_results);
    let WorkshopPublicationResult::Succeeded {
        manifest,
        checkpoints,
    } = &first_results[0]
    else {
        panic!("expected success result");
    };
    assert_eq!(checkpoints.len(), 11);
    assert_eq!(manifest.workspace.checkpoints.len(), 11);
    assert!(
        manifest
            .workspace
            .checkpoints
            .iter()
            .all(|checkpoint| checkpoint.vm_images.is_empty())
    );
    assert!(
        checkpoints
            .iter()
            .all(|checkpoint| checkpoint.vm_images.is_empty())
    );
    assert!(checkpoints.iter().all(|checkpoint| !checkpoint.sanitized));
    assert!(
        checkpoints
            .iter()
            .all(|checkpoint| !checkpoint.cold_boot_verified)
    );
    assert!(
        checkpoints
            .iter()
            .all(|checkpoint| !checkpoint.runtime_bundle_cold_boot_verified)
    );
    assert!(
        checkpoints
            .iter()
            .all(|checkpoint| checkpoint.provider_verification_pending)
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
    assert_eq!(checkpoints[0].covered_module_ids, ["00"]);
    assert_eq!(
        checkpoints[10].covered_module_ids,
        [
            "00", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10"
        ]
    );
    assert_eq!(manifest.workspace.runtime_profiles.len(), 2);
    let HydratedRuntimeProfile::HetznerCloud {
        id,
        requested_system_image,
        immutable_system_image,
        locations,
        hardware,
        ..
    } = &manifest.workspace.runtime_profiles[0]
    else {
        panic!("expected Hetzner profile");
    };
    assert_eq!(id, "hetzner-cpx42");
    assert_eq!(requested_system_image, "debian-13");
    assert_eq!(immutable_system_image, "hetzner/image/123456/debian-13");
    assert_eq!(locations, &["nbg1", "fsn1", "hel1"]);
    assert_eq!(hardware.cpu_millis, 8_000);
    assert_eq!(hardware.provider_cpu_count, 8);
    let HydratedRuntimeProfile::GcpCompute {
        requested_system_image,
        immutable_system_image,
        hardware,
        ..
    } = &manifest.workspace.runtime_profiles[1]
    else {
        panic!("expected GCP profile");
    };
    assert_eq!(
        requested_system_image,
        "projects/debian-cloud/global/images/family/debian-13"
    );
    assert_eq!(
        immutable_system_image,
        "projects/debian-cloud/global/images/debian-13-20260715"
    );
    assert_eq!(hardware.cpu_millis, 4_000);
    assert_eq!(hardware.provider_cpu_count, 4);

    let json = serde_json::to_value(&first_results[0]).unwrap();
    assert_eq!(json["checkpoints"][0]["vm_images"], serde_json::json!([]));
    assert_eq!(json["checkpoints"][0]["sanitized"], false);
    assert_eq!(json["checkpoints"][0]["cold_boot_verified"], false);
    assert_eq!(
        json["checkpoints"][0]["runtime_bundle_cold_boot_verified"],
        false
    );
    assert_eq!(
        json["checkpoints"][0]["provider_verification_pending"],
        true
    );
    assert_eq!(
        json["checkpoints"][0]["runtime_bundle"]["format"],
        "direct_cloud_linux_x86_64_v1"
    );
    assert_eq!(
        json["checkpoints"][0]["runtime_bundle"]["signing_key_id"],
        "runtime-test-v1"
    );
    assert!(
        json["checkpoints"][0]["runtime_bundle"]
            .get("workspace_agent_sha256")
            .is_none()
    );
    assert_eq!(
        json["checkpoints"][0]["runtime_bundle"]["signature_b64"]
            .as_str()
            .unwrap()
            .len(),
        88
    );
    assert!(first_registry.images.lock().unwrap().is_empty());
    let reported_artifacts = checkpoints
        .iter()
        .map(|checkpoint| checkpoint.runtime_bundle.as_ref().unwrap().sha256.clone())
        .collect::<Vec<_>>();
    let first_artifacts = first_registry.artifacts.lock().unwrap().clone();
    assert_eq!(first_artifacts, reported_artifacts);
    assert_eq!(
        *first_registry.refreshes.lock().unwrap(),
        12,
        "one refresh per bundle upload plus the terminal result"
    );
    let second_artifacts = second_registry.artifacts.lock().unwrap().clone();
    assert_eq!(first_artifacts, second_artifacts);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn direct_publication_fails_closed_when_a_profile_observation_is_missing() {
    let (registry, worker, _temporary) = setup(TestRuntime::DirectCloud);
    registry
        .claim
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .runtime_profile_observations
        .retain(|entry| entry.profile_id != "gcp-e2-standard-4");
    let mut backend = FakeBackend::new();

    let outcome = process_next(&registry, &mut backend, &worker)
        .await
        .unwrap();

    let ProcessOutcome::Failed { error, .. } = outcome else {
        panic!("expected failed publication");
    };
    assert!(error.contains("missing catalog observations"));
    assert!(error.contains("gcp-e2-standard-4"));
    assert!(backend.events.is_empty());
    assert!(registry.images.lock().unwrap().is_empty());
    assert!(registry.artifacts.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn direct_publication_rejects_substituted_or_undersized_profile_before_artifacts() {
    let (registry, worker, _temporary) = setup(TestRuntime::DirectCloud);
    {
        let mut claim = registry.claim.lock().unwrap();
        let observation = &mut claim
            .as_mut()
            .unwrap()
            .runtime_profile_observations
            .iter_mut()
            .find(|entry| entry.profile_id == "gcp-e2-standard-4")
            .unwrap()
            .observation;
        observation.machine_type = "e2-standard-2".to_owned();
        observation.cores = 2;
    }
    let mut backend = FakeBackend::new();

    let outcome = process_next(&registry, &mut backend, &worker)
        .await
        .unwrap();

    let ProcessOutcome::Failed { error, .. } = outcome else {
        panic!("expected failed publication");
    };
    assert!(error.contains("instead of exact requested type 'e2-standard-4'"));
    assert!(backend.events.is_empty());
    assert!(registry.images.lock().unwrap().is_empty());
    assert!(registry.artifacts.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mixed_profiles_publish_agent_images_and_one_shared_direct_cloud_bundle() {
    let (registry, worker, _temporary) = setup(TestRuntime::Mixed);
    let mut backend = FakeBackend::new();

    let outcome = process_next(&registry, &mut backend, &worker)
        .await
        .unwrap();
    assert!(matches!(outcome, ProcessOutcome::Succeeded { .. }));
    assert!(!backend.events.is_empty());
    let results = registry.results.lock().unwrap();
    let WorkshopPublicationResult::Succeeded {
        manifest,
        checkpoints,
    } = &results[0]
    else {
        panic!("expected successful mixed publication");
    };
    assert_eq!(manifest.workspace.runtime_profiles.len(), 3);
    assert!(
        checkpoints
            .iter()
            .all(|checkpoint| checkpoint.vm_images.len() == 1)
    );
    assert!(
        checkpoints
            .iter()
            .all(|checkpoint| checkpoint.runtime_bundle.is_some())
    );
    assert!(
        checkpoints
            .iter()
            .all(|checkpoint| checkpoint.provider_verification_pending)
    );
    assert_eq!(registry.images.lock().unwrap().len(), 11);
    assert_eq!(
        registry.artifacts.lock().unwrap().len(),
        13,
        "two shared KVM boot artifacts plus eleven provider-neutral checkpoint bundles"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn direct_provider_validation_failure_does_not_abort_the_backend() {
    let (registry, mut worker, _temporary) = setup(TestRuntime::DirectCloud);
    worker.runtime_bundle_signing = None;
    let mut backend = FakeBackend::new();

    let outcome = process_next(&registry, &mut backend, &worker)
        .await
        .unwrap();

    let ProcessOutcome::Failed { error, .. } = outcome else {
        panic!("expected failed outcome");
    };
    assert!(error.contains("requires runtime bundle signing"));
    assert!(backend.events.is_empty());
    assert!(!backend.aborted);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reports_one_terminal_failure_and_aborts_the_guest_workflow() {
    let (registry, worker, _temporary) = setup(TestRuntime::AgentKvm);
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
    let (registry, worker, _temporary) = setup(TestRuntime::AgentKvm);
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
