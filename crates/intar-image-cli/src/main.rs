use anyhow::{Context, Result, anyhow, bail};
use clap::{Args, Parser, Subcommand};
use intar_image_build::source_bundle::{
    CompileBundleInput, CourseScenario, DEFAULT_COURSES_ROOT, compile_bundle, compile_source_tree,
    load_base_image_catalog, load_course_scenario, load_curriculum, platform_compile_digest,
    scenario_base_definition_identity, selected_course_scenarios, selected_vm_names,
    validate_scenario,
};
use intar_image_build::{
    BuildConfig, DirectBuildOutput, DirectBuildRequest, RawUploadConfig, ScenarioContentHashInput,
    combine_scenario_manifests, render_direct_build, run_direct_build, scenario_content_hash,
    write_guest_tools_disk,
};
use intar_image_scenario::{BaseImageCatalog, Scenario};
use intar_image_upload::{
    ImageUploadConfig, ImageUploader, PublishArtifactFile, PublishChunkedImage,
    PublishImageChunkFile,
};
use std::collections::BTreeMap;
use std::env;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::{fs, process::Command as ProcessCommand};

mod clean_base_command;
mod reconstruct_command;

const BASE_IMAGES_PATH: &str = "content/scenarios/base-images.hcl";
const IMAGE_PUBLISH_TOKEN_ENV: &str = "INTAR_IMAGE_PUBLISH_TOKEN";
const DEFAULT_BUNDLE_OUTPUT_ROOT: &str = "dist/bundles";

struct CompletedBuild {
    scenario_name: String,
    vm_name: String,
    output: DirectBuildOutput,
}

#[derive(Debug)]
struct BundleUploadTarget {
    url: String,
    token: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct BundleUploadReceipt {
    queued: u64,
    assigned: usize,
}

#[derive(Debug, Parser)]
#[command(name = "intar-image-cli")]
#[command(about = "Build prebaked scenario chunked images with direct QEMU")]
#[command(version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Validate(ScenarioCommand),
    Render(RenderCommand),
    Build(BuildCommand),
    BuildAll(BuildAllCommand),
    BuildBase(clean_base_command::BuildBaseCommand),
    BuildGuestTools(BuildGuestToolsCommand),
    /// Reconstruct a sparse raw disk from verified local image chunks.
    Reconstruct(reconstruct_command::ReconstructCommand),
    Hash(HashCommand),
    Bundle(BundleCommand),
}

#[derive(Debug, Args)]
struct ScenarioCommand {
    scenario: Option<String>,
    #[arg(long)]
    vm: Option<String>,
    /// Selects the legacy mode [default: content/courses]
    #[arg(long)]
    courses_root: Option<PathBuf>,
    #[arg(long)]
    config: Option<PathBuf>,
    /// Selects the legacy mode [default: content/scenarios/base-images.hcl]
    #[arg(long)]
    base_images: Option<PathBuf>,
}

#[derive(Debug, Args)]
struct RenderCommand {
    scenario: Option<String>,
    #[arg(long)]
    vm: Option<String>,
    #[arg(long, default_value = DEFAULT_COURSES_ROOT)]
    courses_root: PathBuf,
    #[arg(long)]
    config: Option<PathBuf>,
}

#[derive(Debug, Args)]
struct BuildCommand {
    scenario: Option<String>,
    #[arg(long)]
    vm: Option<String>,
    #[arg(long, default_value = DEFAULT_COURSES_ROOT)]
    courses_root: PathBuf,
    #[arg(long)]
    config: Option<PathBuf>,
    #[arg(long)]
    no_upload: bool,
    #[arg(long)]
    no_cache: bool,
}

#[derive(Debug, Args)]
struct BuildAllCommand {
    #[arg(long, default_value = DEFAULT_COURSES_ROOT)]
    courses_root: PathBuf,
    #[arg(long)]
    config: Option<PathBuf>,
    #[arg(long)]
    no_upload: bool,
    #[arg(long)]
    no_cache: bool,
}

#[derive(Debug, Args)]
struct HashCommand {
    scenario: Option<String>,
    #[arg(long, default_value = DEFAULT_COURSES_ROOT)]
    courses_root: PathBuf,
    #[arg(long)]
    config: Option<PathBuf>,
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

#[derive(Debug, Args)]
struct BundleCommand {
    scenario: Option<String>,
    /// Selects the legacy mode [default: content/courses]
    #[arg(long)]
    courses_root: Option<PathBuf>,
    /// Selects the legacy mode [default: content/scenarios/base-images.hcl]
    #[arg(long)]
    base_images: Option<PathBuf>,
    #[arg(long)]
    config: Option<PathBuf>,
    #[arg(long)]
    rev: Option<String>,
    #[arg(long)]
    output: Option<PathBuf>,
    #[arg(long)]
    url: Option<String>,
    #[arg(long)]
    token: Option<String>,
    #[arg(long)]
    no_upload: bool,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let working_dir = Path::new(".");
    let result = match cli.command {
        Command::Validate(args) => validate_command(&args, working_dir),
        Command::Render(args) => render_command(&args),
        Command::Build(args) => build_command(&args),
        Command::BuildAll(args) => build_all_command(&args),
        Command::BuildBase(args) => clean_base_command::build_base_command(&args),
        Command::BuildGuestTools(args) => build_guest_tools_command(&args),
        Command::Reconstruct(args) => reconstruct_command::reconstruct(&args),
        Command::Hash(args) => hash_command(&args),
        Command::Bundle(args) => bundle_command(&args, working_dir),
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

/// What `validate` and `bundle` compile.
#[derive(Debug, PartialEq, Eq)]
enum CompileMode {
    /// 0.8.2's token lane: it reads no `intar.yaml` and writes no `meta.source`.
    Legacy {
        courses_root: PathBuf,
        base_images: PathBuf,
    },
    /// The `intar.yaml` repository at the working directory.
    Source,
}

/// An explicit `--courses-root` or `--base-images` selects the legacy mode.
/// Otherwise an `intar.yaml` in the working directory selects the source mode,
/// and without one the legacy defaults apply.
fn compile_mode(
    courses_root: Option<&Path>,
    base_images: Option<&Path>,
    working_dir: &Path,
) -> CompileMode {
    if courses_root.is_none()
        && base_images.is_none()
        && fs::symlink_metadata(working_dir.join("intar.yaml")).is_ok()
    {
        return CompileMode::Source;
    }
    CompileMode::Legacy {
        courses_root: courses_root
            .unwrap_or(Path::new(DEFAULT_COURSES_ROOT))
            .to_owned(),
        base_images: base_images
            .unwrap_or(Path::new(BASE_IMAGES_PATH))
            .to_owned(),
    }
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

fn validate_command(args: &ScenarioCommand, working_dir: &Path) -> Result<()> {
    let config = load_build_config(args.config.as_deref())?;
    let (courses_root, base_images) = match compile_mode(
        args.courses_root.as_deref(),
        args.base_images.as_deref(),
        working_dir,
    ) {
        CompileMode::Legacy {
            courses_root,
            base_images,
        } => (courses_root, base_images),
        CompileMode::Source => {
            if args.scenario.is_some() || args.vm.is_some() {
                bail!(
                    "intar.yaml mode validates the whole repository; pass --courses-root to select a scenario or VM"
                );
            }
            compile_source_tree(working_dir, "validate", &config.qemu.target_arch)?;
            println!("compile digest: {}", platform_compile_digest());
            return Ok(());
        }
    };
    let curriculum = load_curriculum(&courses_root)?;
    let scenarios = selected_course_scenarios(&curriculum, args.scenario.as_deref())?;
    if scenarios.is_empty() {
        return Ok(());
    }
    let base_catalog = load_base_image_catalog(&base_images)?;
    for source in scenarios {
        let scenario = load_course_scenario(&source.scenario_path)?;
        validate_scenario(
            &scenario,
            &base_catalog,
            args.vm.as_deref(),
            &config.qemu.target_arch,
        )?;
        println!(
            "validated {} ({})",
            scenario.name,
            source.scenario_path.display()
        );
    }
    Ok(())
}

fn render_command(args: &RenderCommand) -> Result<()> {
    let config = load_build_config(args.config.as_deref())?;
    let curriculum = load_curriculum(&args.courses_root)?;
    let scenarios = selected_course_scenarios(&curriculum, args.scenario.as_deref())?;
    if scenarios.is_empty() {
        return Ok(());
    }
    let base_catalog = load_base_image_catalog(Path::new(BASE_IMAGES_PATH))?;

    for source in scenarios {
        let scenario = load_course_scenario(&source.scenario_path)?;
        validate_scenario(
            &scenario,
            &base_catalog,
            args.vm.as_deref(),
            &config.qemu.target_arch,
        )?;
        for vm_name in selected_vm_names(&scenario, args.vm.as_deref())? {
            let request = prepare_direct_render_request(
                &config,
                &base_catalog,
                &source,
                &scenario,
                &vm_name,
            )?;
            let rendered = render_direct_build(&request)
                .with_context(|| format!("failed to render {}:{}", scenario.name, vm_name))?;
            println!(
                "rendered {}:{} -> {}",
                scenario.name,
                vm_name,
                rendered.paths.output_chunk_manifest_path.display()
            );
        }
    }

    Ok(())
}

fn build_command(args: &BuildCommand) -> Result<()> {
    let mut config = load_build_config(args.config.as_deref())?;
    if args.no_cache {
        config.qemu.layered.use_cache = false;
    }
    let curriculum = load_curriculum(&args.courses_root)?;
    let scenarios = selected_course_scenarios(&curriculum, args.scenario.as_deref())?;
    if scenarios.is_empty() {
        return Ok(());
    }
    let base_catalog = load_base_image_catalog(Path::new(BASE_IMAGES_PATH))?;
    let uploader = build_uploader(config.upload.as_ref(), args.no_upload)?;
    let mut completed_builds = Vec::new();

    for source in scenarios {
        let scenario = load_course_scenario(&source.scenario_path)?;
        validate_scenario(
            &scenario,
            &base_catalog,
            args.vm.as_deref(),
            &config.qemu.target_arch,
        )?;
        for vm_name in selected_vm_names(&scenario, args.vm.as_deref())? {
            let request = prepare_direct_render_request(
                &config,
                &base_catalog,
                &source,
                &scenario,
                &vm_name,
            )?;
            let output = build_vm(&request)?;
            println!(
                "built {}:{} -> {}",
                scenario.name,
                vm_name,
                output.artifact.chunk_manifest_path.display()
            );

            completed_builds.push(CompletedBuild {
                scenario_name: scenario.name.clone(),
                vm_name,
                output,
            });
        }
    }

    upload_completed_builds(uploader.as_ref(), &completed_builds)
}

fn build_all_command(args: &BuildAllCommand) -> Result<()> {
    let mut config = load_build_config(args.config.as_deref())?;
    if args.no_cache {
        config.qemu.layered.use_cache = false;
    }
    let curriculum = load_curriculum(&args.courses_root)?;
    if curriculum.scenarios.is_empty() {
        return Ok(());
    }
    let base_catalog = load_base_image_catalog(Path::new(BASE_IMAGES_PATH))?;
    let uploader = build_uploader(config.upload.as_ref(), args.no_upload)?;
    let mut completed_builds = Vec::new();

    for source in curriculum.scenarios {
        let scenario = load_course_scenario(&source.scenario_path)?;
        validate_scenario(&scenario, &base_catalog, None, &config.qemu.target_arch)?;
        for vm_name in selected_vm_names(&scenario, None)? {
            let request = prepare_direct_render_request(
                &config,
                &base_catalog,
                &source,
                &scenario,
                &vm_name,
            )?;
            let output = build_vm(&request)?;
            println!(
                "built {}:{} -> {}",
                scenario.name,
                vm_name,
                output.artifact.chunk_manifest_path.display()
            );

            completed_builds.push(CompletedBuild {
                scenario_name: scenario.name.clone(),
                vm_name,
                output,
            });
        }
    }

    upload_completed_builds(uploader.as_ref(), &completed_builds)
}

fn hash_command(args: &HashCommand) -> Result<()> {
    let config = load_build_config(args.config.as_deref())?;
    let curriculum = load_curriculum(&args.courses_root)?;
    let scenarios = selected_course_scenarios(&curriculum, args.scenario.as_deref())?;
    if scenarios.is_empty() {
        return Ok(());
    }
    let base_catalog = load_base_image_catalog(Path::new(BASE_IMAGES_PATH))?;

    for source in scenarios {
        let scenario = load_course_scenario(&source.scenario_path)?;
        validate_scenario(&scenario, &base_catalog, None, &config.qemu.target_arch)?;
        let base_definition =
            scenario_base_definition_identity(&scenario, &base_catalog, &config.qemu.target_arch)?;
        let hash = scenario_content_hash(&ScenarioContentHashInput {
            scenario_id: &scenario.name,
            scenario_dir: &source.scenario_dir,
            base_definition: &base_definition,
            target_arch: &config.qemu.target_arch,
        })?;
        println!("{}\t{}\t{}", scenario.name, config.qemu.target_arch, hash);
    }

    Ok(())
}

fn bundle_command(args: &BundleCommand, working_dir: &Path) -> Result<()> {
    let config = load_build_config(args.config.as_deref())?;
    let rev = args
        .rev
        .clone()
        .map(Ok)
        .unwrap_or_else(default_bundle_rev)?;
    validate_bundle_rev(&rev)?;
    let compiled = match compile_mode(
        args.courses_root.as_deref(),
        args.base_images.as_deref(),
        working_dir,
    ) {
        CompileMode::Legacy {
            courses_root,
            base_images,
        } => compile_bundle(&CompileBundleInput {
            courses_root: &courses_root,
            base_images: &base_images,
            rev: &rev,
            target_arch: &config.qemu.target_arch,
            scenario: args.scenario.as_deref(),
        })?,
        CompileMode::Source => {
            if args.scenario.is_some() {
                bail!(
                    "intar.yaml mode bundles the whole repository; pass --courses-root to select a scenario"
                );
            }
            compile_source_tree(working_dir, &rev, &config.qemu.target_arch)?
        }
    };
    let output_path = args
        .output
        .clone()
        .unwrap_or_else(|| default_bundle_output_path(&rev));
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    fs::write(&output_path, &compiled.archive)
        .with_context(|| format!("failed to create {}", output_path.display()))?;

    println!(
        "bundled {} scenarios ({} files) -> {}",
        compiled.scenario_count,
        compiled.file_count,
        output_path.display()
    );

    if let Some(target) = bundle_upload_target(
        config.upload.as_ref(),
        args.url.as_deref(),
        args.token.as_deref(),
        args.no_upload,
    )? {
        let uploader = match publish_url_from_bundle_url(&target.url) {
            Some(publish_url) => Some(ImageUploader::new(ImageUploadConfig::new(
                publish_url,
                target.token.clone(),
            ))?),
            None => None,
        };
        let receipt = upload_bundle(
            uploader.as_ref(),
            &target,
            &output_path,
            &rev,
            &compiled.meta,
        )?;
        println!(
            "uploaded bundle {rev} -> {} ({} queued, {} assigned)",
            target.url, receipt.queued, receipt.assigned
        );
    }

    Ok(())
}

mod bundle_command;
use bundle_command::*;

fn prepare_direct_render_request(
    config: &BuildConfig,
    base_catalog: &BaseImageCatalog,
    source: &CourseScenario,
    scenario: &Scenario,
    vm_name: &str,
) -> Result<DirectBuildRequest> {
    let vm = scenario
        .vm_by_name(vm_name)
        .with_context(|| format!("vm '{vm_name}' not found in scenario '{}'", scenario.name))?;
    let image = scenario.image_by_name(&vm.image).with_context(|| {
        format!(
            "image '{}' not found in scenario '{}'",
            vm.image, scenario.name
        )
    })?;
    let base_image = base_catalog
        .base_image_by_name(&image.base)
        .with_context(|| format!("base image '{}' not found in catalog", image.base))?;

    Ok(DirectBuildRequest {
        scenario: scenario.clone(),
        lecture: source.lecture.clone(),
        vm_name: vm_name.to_string(),
        config: config.qemu.clone(),
        base_image: base_image.clone(),
    })
}

fn build_uploader(
    config: Option<&RawUploadConfig>,
    no_upload: bool,
) -> Result<Option<ImageUploader>> {
    if no_upload {
        return Ok(None);
    }

    let Some(config) = config else {
        return Ok(None);
    };
    if !config.enabled {
        return Ok(None);
    }

    Ok(Some(configured_uploader(Some(config))?))
}

fn configured_uploader(config: Option<&RawUploadConfig>) -> Result<ImageUploader> {
    let config = config.ok_or_else(|| anyhow!("missing upload config"))?;
    let token = if config.token.trim().is_empty() {
        env::var(IMAGE_PUBLISH_TOKEN_ENV).unwrap_or_default()
    } else {
        config.token.clone()
    };

    ImageUploader::new(ImageUploadConfig::new(config.url.clone(), token)).with_context(|| {
        format!(
            "failed to initialize image uploader; set upload.token or {IMAGE_PUBLISH_TOKEN_ENV}"
        )
    })
}

fn build_vm(request: &DirectBuildRequest) -> Result<DirectBuildOutput> {
    run_direct_build(request).with_context(|| {
        format!(
            "direct QEMU build failed for {}:{}",
            request.scenario.name, request.vm_name
        )
    })
}

fn upload_completed_builds(
    uploader: Option<&ImageUploader>,
    completed_builds: &[CompletedBuild],
) -> Result<()> {
    let Some(uploader) = uploader else {
        return Ok(());
    };

    let mut by_scenario: BTreeMap<&str, Vec<&CompletedBuild>> = BTreeMap::new();
    for completed_build in completed_builds {
        by_scenario
            .entry(&completed_build.scenario_name)
            .or_default()
            .push(completed_build);
    }

    for (scenario_name, builds) in by_scenario {
        let manifests = builds
            .iter()
            .map(|build| &build.output.artifact.manifest)
            .collect::<Vec<_>>();
        let manifest = combine_scenario_manifests(manifests)?;
        let mut images = Vec::new();
        for build in &builds {
            let vm_manifest = build
                .output
                .artifact
                .manifest
                .vms
                .first()
                .ok_or_else(|| anyhow!("build manifest for {} has no VMs", build.vm_name))?;
            let chunks = build
                .output
                .artifact
                .chunks
                .iter()
                .map(|chunk| {
                    PublishImageChunkFile::from_optional_path(
                        &chunk.descriptor,
                        chunk.path.as_deref(),
                    )
                })
                .collect::<intar_image_upload::Result<Vec<_>>>()?;
            images.push(PublishChunkedImage::new(
                build.vm_name.clone(),
                &vm_manifest.image_id,
                &vm_manifest.chunk_manifest_sha256,
                &build.output.artifact.chunk_manifest_path,
                chunks,
            )?);
        }
        let artifacts = publish_artifacts_from_builds(&builds)?;
        let receipt = uploader
            .publish_manifest_with_artifacts(&manifest, &images, &artifacts)
            .with_context(|| format!("failed to publish scenario {scenario_name}"))?;
        println!(
            "published {} -> {} images, {} artifacts",
            receipt.scenario_id,
            receipt.images.len(),
            receipt.artifacts.len()
        );
    }

    Ok(())
}

fn publish_artifacts_from_builds(builds: &[&CompletedBuild]) -> Result<Vec<PublishArtifactFile>> {
    let mut artifacts = BTreeMap::new();
    for build in builds {
        artifacts.insert(
            build.output.artifact.kernel_sha256_hex.clone(),
            build.output.rendered.base_rootfs.paths.kernel_path.clone(),
        );
        artifacts.insert(
            build.output.artifact.initrd_sha256_hex.clone(),
            build.output.rendered.base_rootfs.paths.initrd_path.clone(),
        );
    }
    artifacts
        .into_iter()
        .map(|(sha256, path)| PublishArtifactFile::new(path, sha256).map_err(anyhow::Error::from))
        .collect()
}

#[cfg(test)]
mod tests;
