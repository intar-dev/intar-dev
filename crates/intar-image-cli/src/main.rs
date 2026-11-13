use anyhow::{Context, Result, bail};
use clap::{Args, Parser, Subcommand};
use intar_contracts::oci::IMAGE_FORMAT;
use intar_contracts::source::{SOURCE_COMPILER_VERSION_V2, source_compile_digest};
use intar_image_build::write_guest_tools_disk;
use intar_image_scenario::loader::{
    Diagnostic, compile, encode_bundle, format_repository, warnings,
};
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

mod bundle_command;
mod spec_command;

use bundle_command::{
    BundleUploadTarget, default_bundle_output_path, default_bundle_rev, exit_code, upload_bundle,
    validate_bundle_rev,
};

#[derive(Debug, Parser)]
#[command(name = "intar-image-cli")]
#[command(about = "Validate, format and compile intar scenario repositories")]
#[command(version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Check the repository: every scenario, image and course, with lints.
    Validate(ValidateCommand),
    /// Lay out the repository's HCL files canonically.
    Fmt(FmtCommand),
    /// Print a scenario as its machines will run it.
    Spec(spec_command::SpecCommand),
    /// Compile the repository into a bundle, and upload it with `--url`.
    Bundle(BundleCommand),
    /// Build the guest tools disk around a Kino binary.
    BuildGuestTools(BuildGuestToolsCommand),
}

#[derive(Debug, Args)]
struct ValidateCommand {
    /// The repository root.
    #[arg(long, default_value = ".")]
    root: PathBuf,
}

#[derive(Debug, Args)]
struct FmtCommand {
    /// Change nothing; fail when a file is not formatted.
    #[arg(long)]
    check: bool,
    /// The repository root.
    #[arg(long, default_value = ".")]
    root: PathBuf,
}

#[derive(Debug, Args)]
struct BundleCommand {
    /// Defaults to the first 12 hex digits of GITHUB_SHA or HEAD.
    #[arg(long)]
    rev: Option<String>,
    /// Defaults to dist/bundles/<rev>.json.gz.
    #[arg(long)]
    output: Option<PathBuf>,
    /// The bundles route to upload to; without it nothing is uploaded.
    #[arg(long)]
    url: Option<String>,
    /// The bearer token of the upload.
    #[arg(long)]
    token: Option<String>,
    /// Never upload, even with `--url`.
    #[arg(long)]
    no_upload: bool,
    /// The repository root.
    #[arg(long, default_value = ".")]
    root: PathBuf,
}

#[derive(Debug, Args)]
struct BuildGuestToolsCommand {
    #[arg(long)]
    kino_binary: PathBuf,
    #[arg(long, default_value = "dist/guest-tools")]
    output_root: PathBuf,
    #[arg(long, default_value = "mke2fs")]
    mke2fs_binary: PathBuf,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Validate(args) => validate_command(&args),
        Command::Fmt(args) => fmt_command(&args),
        Command::Spec(args) => spec_command::spec_command(&args),
        Command::Bundle(args) => bundle_command(&args),
        Command::BuildGuestTools(args) => build_guest_tools_command(&args),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            // The report `fn main() -> Result<()>` prints.
            eprintln!("Error: {error:?}");
            ExitCode::from(exit_code(&error))
        }
    }
}

/// Every diagnostic on its own line, as `path:line:col: message`.
fn report(problems: &[Diagnostic]) -> anyhow::Error {
    for problem in problems {
        eprintln!("{problem}");
    }
    anyhow::anyhow!("{} problem(s)", problems.len())
}

/// The digest every rev this compiler uploads ends in.
fn compile_digest() -> String {
    source_compile_digest(IMAGE_FORMAT, SOURCE_COMPILER_VERSION_V2)
}

fn validate_command(args: &ValidateCommand) -> Result<()> {
    let (bundle, scripts) = compile(&args.root).map_err(|problems| report(&problems))?;
    for warning in warnings(&scripts) {
        eprintln!("{warning}");
    }
    println!(
        "validated {} scenarios, {} images, {} courses",
        bundle.scenarios.len(),
        bundle.images.len(),
        bundle.course_catalog.courses.len()
    );
    println!("compile digest: {}", compile_digest());
    Ok(())
}

fn fmt_command(args: &FmtCommand) -> Result<()> {
    let changed =
        format_repository(&args.root, !args.check).map_err(|problems| report(&problems))?;
    for path in &changed {
        println!("{}", path.display());
    }
    if args.check && !changed.is_empty() {
        bail!(
            "{} file(s) are not formatted; run `intar-image-cli fmt`",
            changed.len()
        );
    }
    Ok(())
}

fn bundle_command(args: &BundleCommand) -> Result<()> {
    let rev = match &args.rev {
        Some(rev) => rev.clone(),
        None => default_bundle_rev()?,
    };
    validate_bundle_rev(&rev)?;
    let target = match (&args.url, args.no_upload) {
        (Some(url), false) => Some(BundleUploadTarget::new(url, args.token.as_deref())?),
        _ => None,
    };
    let (bundle, _) = compile(&args.root).map_err(|problems| report(&problems))?;
    let encoded = encode_bundle(&bundle).map_err(anyhow::Error::msg)?;
    let output = args
        .output
        .clone()
        .unwrap_or_else(|| default_bundle_output_path(&rev));
    if let Some(parent) = output
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    fs::write(&output, &encoded)
        .with_context(|| format!("failed to create {}", output.display()))?;
    println!(
        "bundled {} scenarios, {} images ({} bytes) -> {}",
        bundle.scenarios.len(),
        bundle.images.len(),
        encoded.len(),
        output.display()
    );
    if let Some(target) = target {
        let receipt = upload_bundle(&target, &output, &rev)?;
        println!(
            "uploaded bundle {rev} -> {} ({} queued, {} assigned)",
            target.url, receipt.queued, receipt.assigned
        );
    }
    Ok(())
}

fn build_guest_tools_command(args: &BuildGuestToolsCommand) -> Result<()> {
    let artifact =
        write_guest_tools_disk(&args.kino_binary, &args.output_root, &args.mke2fs_binary)?;
    println!(
        "{}",
        serde_json::to_string(&serde_json::json!({
            "schema_version": 1,
            "bootstrap_abi": artifact.manifest.bootstrap_abi,
            "tools_disk_sha256": artifact.disk_sha256,
            "tools_disk_size_bytes": artifact.disk_size_bytes,
            "compressed_disk_sha256": artifact.compressed_disk_sha256,
            "compressed_disk_size_bytes": artifact.compressed_disk_size_bytes,
            "compressed_disk_path": artifact.compressed_disk_path,
            "kino_sha256": artifact.kino_sha256,
            "kino_size_bytes": artifact.kino_size_bytes,
        }))?
    );
    Ok(())
}

#[cfg(test)]
mod tests;
