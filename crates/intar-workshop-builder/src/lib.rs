#![forbid(unsafe_code)]

mod agent;
mod authored_image;
mod backend;
mod bundle;
mod client;
mod config;
mod contracts;
mod hydrate;
mod kvm;
mod orchestrator;
mod runtime_bundle;
mod staging;

pub use agent::{run_forever, run_forever_until_cancelled};
pub use authored_image::{AuthoredImageProvenance, prepare_authored_image};
pub use backend::{
    BeginWorkshopBuild, CanonicalScript, CanonicalScriptKind, CheckpointImageTarget,
    RuntimeBundleColdBoot, RuntimeBundleColdBootProof, SealCheckpoint, SealedVmArtifact,
    WorkshopExecutionBackend,
};
pub use client::{
    AuthenticatedWorkshopRegistry, PublicationRegistry, WorkshopBlobPublisher,
    WorkshopRegistryClient,
};
pub use config::{
    AuthoredImagePreparationConfig, KvmExecutionConfig, RegistryConfig, RuntimeBundleSigningConfig,
    RuntimeBundleVerificationConfig, WorkerConfig, WorkshopBaseImageConfig, WorkshopBuilderConfig,
    load, parse,
};
pub use contracts::{
    BuiltVmImage, CheckpointBuildResult, HydratedWorkshopManifestV1, RuntimeBundleArtifact,
    RuntimeBundleCompression, WorkshopPublicationClaim, WorkshopPublicationResult,
};
pub use kvm::KvmWorkshopBackend;
pub use orchestrator::{ProcessOutcome, process_next, process_next_until_cancelled};
pub use runtime_bundle::preflight_runtime_bundle_signing;
pub use staging::cleanup_stale_staging_directories;
