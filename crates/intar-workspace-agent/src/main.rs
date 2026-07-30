#![forbid(unsafe_code)]

use anyhow::{Context, Result};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use clap::{Args, Parser, Subcommand, ValueEnum};
use intar_workspace_agent::checkpoint::{
    BuiltinCheckpointApplier, CheckpointApplier, stage_local_checkpoint,
};
use intar_workspace_agent::model::{CheckpointCompression, CheckpointDescriptor};
use intar_workspace_agent::secrets::SecretString;
use intar_workspace_agent::{AgentConfig, WorkspaceAgent};
use std::collections::BTreeMap;
use std::path::PathBuf;
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(name = "intar-workspace-agent")]
#[command(about = "Guest control plane for direct Intar Workshop learner servers")]
struct Cli {
    #[arg(
        long,
        value_name = "PATH",
        default_value = "/etc/intar/workspace-agent.toml"
    )]
    config: PathBuf,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Bootstrap if necessary, apply the checkpoint, send one report, and exit.
    Once,
    /// Upload one generation-scoped artifact using a short-lived signed grant.
    UploadArtifact {
        #[arg(long)]
        kind: String,
        #[arg(value_name = "PATH")]
        path: PathBuf,
    },
    /// Parse and validate configuration without contacting the control plane.
    CheckConfig,
    /// Apply an exact signed bundle on a clean guest for publication proof.
    VerifyBundle(VerifyBundleArgs),
}

#[derive(Debug, Args)]
struct VerifyBundleArgs {
    #[arg(long, value_name = "PATH")]
    bundle_path: PathBuf,
    #[arg(long)]
    checkpoint_id: String,
    #[arg(long)]
    sha256: String,
    #[arg(long)]
    size_bytes: u64,
    #[arg(long, value_enum)]
    compression: BundleCompression,
    #[arg(long)]
    signature_b64: String,
    #[arg(long)]
    signing_key_id: String,
    #[arg(long)]
    signing_public_key_b64: String,
    #[arg(long, value_name = "PATH")]
    tmpfs_root: PathBuf,
    #[arg(long)]
    max_checkpoint_bytes: u64,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum BundleCompression {
    None,
    Gzip,
    Zstd,
}

#[tokio::main]
async fn main() -> Result<()> {
    initialize_tracing();
    ensure_rustls_provider()?;
    let cli = Cli::parse();
    if let Some(Command::VerifyBundle(args)) = &cli.command {
        return verify_bundle(args).await;
    }
    let config = AgentConfig::load(&cli.config)
        .with_context(|| format!("failed to load {}", cli.config.display()))?;

    if matches!(cli.command, Some(Command::CheckConfig)) {
        println!("workspace agent configuration is valid");
        return Ok(());
    }

    let agent = WorkspaceAgent::from_config(config).context("failed to initialize agent")?;
    match cli.command {
        None => agent.run().await.context("workspace agent stopped"),
        Some(Command::Once) => agent.report_once().await.context("one-shot run failed"),
        Some(Command::UploadArtifact { kind, path }) => {
            let artifact_id = agent
                .upload_artifact(&kind, &path)
                .await
                .context("artifact upload failed")?;
            println!("{artifact_id}");
            Ok(())
        }
        Some(Command::CheckConfig) => Ok(()),
        Some(Command::VerifyBundle(_)) => unreachable!("handled before agent config load"),
    }
}

async fn verify_bundle(args: &VerifyBundleArgs) -> Result<()> {
    let public_key = BASE64_STANDARD
        .decode(args.signing_public_key_b64.as_bytes())
        .context("signing public key is not valid standard base64")?;
    anyhow::ensure!(
        public_key.len() == 32,
        "signing public key must decode to 32 bytes"
    );
    let descriptor = CheckpointDescriptor {
        checkpoint_id: args.checkpoint_id.clone(),
        signed_url: SecretString::new("https://offline-proof.invalid/checkpoint"),
        sha256: args.sha256.clone(),
        size_bytes: args.size_bytes,
        compression: match args.compression {
            BundleCompression::None => CheckpointCompression::None,
            BundleCompression::Gzip => CheckpointCompression::Gzip,
            BundleCompression::Zstd => CheckpointCompression::Zstd,
        },
        signature_b64: args.signature_b64.clone(),
        signing_key_id: args.signing_key_id.clone(),
        expires_at_unix_ms: i64::MAX,
    };
    let trusted = BTreeMap::from([(
        args.signing_key_id.clone(),
        args.signing_public_key_b64.clone(),
    )]);
    let staged = stage_local_checkpoint(
        &args.bundle_path,
        &descriptor,
        &args.tmpfs_root,
        args.max_checkpoint_bytes,
        &trusted,
    )
    .await
    .context("failed to stage exact signed checkpoint bundle")?;
    BuiltinCheckpointApplier::root()
        .apply(&staged)
        .await
        .context("failed to apply exact signed checkpoint bundle")?;
    println!("runtime bundle cold-boot proof succeeded");
    Ok(())
}

fn initialize_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .without_time()
        .init();
}

fn ensure_rustls_provider() -> Result<()> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    anyhow::ensure!(
        rustls::crypto::CryptoProvider::get_default().is_some(),
        "failed to initialize rustls crypto provider"
    );
    Ok(())
}
