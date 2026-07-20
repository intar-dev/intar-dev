#![forbid(unsafe_code)]

mod agent;
mod backend;
mod bundle;
mod client;
mod config;
mod contracts;
mod hydrate;
mod kvm;
mod orchestrator;
mod staging;

pub use agent::{run_forever, run_forever_until_cancelled};
pub use backend::{
    BeginWorkshopBuild, CanonicalScript, CanonicalScriptKind, CheckpointImageTarget,
    SealCheckpoint, SealedVmArtifact, WorkshopExecutionBackend,
};
pub use client::{
    AuthenticatedWorkshopRegistry, PublicationRegistry, WorkshopBlobPublisher,
    WorkshopRegistryClient,
};
pub use config::{
    KvmExecutionConfig, RegistryConfig, WorkerConfig, WorkshopBaseImageConfig,
    WorkshopBuilderConfig, load, parse,
};
pub use contracts::{
    BuiltVmImage, CheckpointBuildResult, HydratedWorkshopManifestV1, WorkshopPublicationClaim,
    WorkshopPublicationResult,
};
pub use kvm::KvmWorkshopBackend;
pub use orchestrator::{ProcessOutcome, process_next, process_next_until_cancelled};
pub use staging::cleanup_stale_staging_directories;
