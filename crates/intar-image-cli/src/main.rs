use anyhow::{Context, Result, anyhow, bail};
use clap::{Args, Parser, Subcommand};
use flate2::{Compression, GzBuilder};
use intar_image_build::{
    BUILD_FORMAT_VERSION, BuildConfig, DirectBuildOutput, DirectBuildRequest, RawUploadConfig,
    ScenarioContentHashInput, combine_scenario_manifests, render_direct_build, run_direct_build,
    scenario_content_hash, write_guest_tools_disk,
};
use intar_image_scenario::{BaseImageCatalog, Scenario};
use intar_image_upload::{
    ImageUploadConfig, ImageUploader, PublishArtifactFile, PublishChunkedImage,
    PublishImageChunkFile,
};
use std::collections::BTreeMap;
use std::env;
use std::ffi::OsStr;
use std::io::Cursor;
use std::path::{Component, Path, PathBuf};
use std::{fs, process::Command as ProcessCommand};

mod clean_base_command;

const BASE_IMAGES_PATH: &str = "content/scenarios/base-images.hcl";
const BUNDLE_BASE_IMAGES_PATH: &str = "base-images.hcl";
const BUNDLE_SCENARIOS_ROOT: &str = "scenarios";
const IMAGE_PUBLISH_TOKEN_ENV: &str = "INTAR_IMAGE_PUBLISH_TOKEN";
const DEFAULT_BUNDLE_OUTPUT_ROOT: &str = "dist/bundles";
const MAX_BUNDLE_TAR_BYTES: u64 = 64 * 1024 * 1024;
const TAR_BLOCK_SIZE: u64 = 512;

struct CompletedBuild {
    scenario_name: String,
    vm_name: String,
    output: DirectBuildOutput,
}

#[derive(Debug, Clone)]
struct BundleSourceFile {
    source_path: PathBuf,
    archive_path: String,
}

#[derive(Debug)]
struct PreparedBundleScenario {
    scenario_id: String,
    scenario_dir: PathBuf,
    content_hash: String,
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
#[command(about = "Build prebaked scenario raw-zstd images with direct QEMU")]
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
    Hash(HashCommand),
    Bundle(BundleCommand),
}

#[derive(Debug, Args)]
struct ScenarioCommand {
    scenario: Option<String>,
    #[arg(long)]
    vm: Option<String>,
    #[arg(long, default_value = DEFAULT_COURSES_ROOT)]
    courses_root: PathBuf,
    #[arg(long)]
    config: Option<PathBuf>,
    #[arg(long, default_value = BASE_IMAGES_PATH)]
    base_images: PathBuf,
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
}

#[derive(Debug, Args)]
struct BuildAllCommand {
    #[arg(long, default_value = DEFAULT_COURSES_ROOT)]
    courses_root: PathBuf,
    #[arg(long)]
    config: Option<PathBuf>,
    #[arg(long)]
    no_upload: bool,
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
    #[arg(long, default_value = DEFAULT_COURSES_ROOT)]
    courses_root: PathBuf,
    #[arg(long, default_value = BASE_IMAGES_PATH)]
    base_images: PathBuf,
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

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Validate(args) => validate_command(&args),
        Command::Render(args) => render_command(&args),
        Command::Build(args) => build_command(&args),
        Command::BuildAll(args) => build_all_command(&args),
        Command::BuildBase(args) => clean_base_command::build_base_command(&args),
        Command::BuildGuestTools(args) => build_guest_tools_command(&args),
        Command::Hash(args) => hash_command(&args),
        Command::Bundle(args) => bundle_command(&args),
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

fn validate_command(args: &ScenarioCommand) -> Result<()> {
    let config = load_build_config(args.config.as_deref())?;
    let curriculum = load_curriculum(&args.courses_root)?;
    let scenarios = selected_course_scenarios(&curriculum, args.scenario.as_deref())?;
    if scenarios.is_empty() {
        return Ok(());
    }
    let base_catalog = load_base_image_catalog(&args.base_images)?;
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
    let config = load_build_config(args.config.as_deref())?;
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
    let config = load_build_config(args.config.as_deref())?;
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

fn bundle_command(args: &BundleCommand) -> Result<()> {
    let config = load_build_config(args.config.as_deref())?;
    let contract_arch = contract_image_arch_slug(&config.qemu.target_arch)?;
    let rev = args
        .rev
        .clone()
        .map(Ok)
        .unwrap_or_else(default_bundle_rev)?;
    validate_bundle_rev(&rev)?;
    let curriculum = load_curriculum(&args.courses_root)?;
    let selected_sources = selected_course_scenarios(&curriculum, args.scenario.as_deref())?;
    let base_catalog = (!curriculum.scenarios.is_empty())
        .then(|| load_base_image_catalog(&args.base_images))
        .transpose()?;

    if let Some(base_catalog) = &base_catalog {
        for source in &curriculum.scenarios {
            let scenario = load_course_scenario(&source.scenario_path)?;
            validate_scenario(&scenario, base_catalog, None, &config.qemu.target_arch)?;
        }
    }

    let mut prepared_scenarios = Vec::new();
    for source in selected_sources {
        let scenario = load_course_scenario(&source.scenario_path)?;
        let base_catalog = base_catalog
            .as_ref()
            .context("scenario bundle is missing a base image catalog")?;
        let base_definition =
            scenario_base_definition_identity(&scenario, base_catalog, &config.qemu.target_arch)?;
        let content_hash = scenario_content_hash(&ScenarioContentHashInput {
            scenario_id: &scenario.name,
            scenario_dir: &source.scenario_dir,
            base_definition: &base_definition,
            target_arch: &config.qemu.target_arch,
        })?;
        prepared_scenarios.push(PreparedBundleScenario {
            scenario_id: scenario.name,
            scenario_dir: source.scenario_dir,
            content_hash,
        });
    }

    let compiled_catalog = tempfile::tempdir().context("create compiled curriculum directory")?;
    let compiled_catalog_path = compiled_catalog.path().join("catalog.json");
    fs::write(
        &compiled_catalog_path,
        serde_json::to_vec(&curriculum.catalog).context("serialize curriculum catalog")?,
    )
    .with_context(|| format!("write {}", compiled_catalog_path.display()))?;
    let source_files = collect_bundle_source_files(
        &prepared_scenarios,
        base_catalog.as_ref().map(|_| args.base_images.as_path()),
        &curriculum,
        &compiled_catalog_path,
    )?;
    let output_path = args
        .output
        .clone()
        .unwrap_or_else(|| default_bundle_output_path(&rev));
    write_bundle_archive(&output_path, &source_files)?;

    let scenarios_meta = prepared_scenarios
        .iter()
        .map(|scenario| {
            serde_json::json!({
                "scenario_id": scenario.scenario_id,
                "arch": contract_arch,
                "content_hash": scenario.content_hash,
            })
        })
        .collect::<Vec<_>>();
    let mut meta = serde_json::json!({
        "rev": rev,
        "guest_bootstrap_abi": intar_contracts::catalog::GUEST_BOOTSTRAP_ABI_V1,
        "build_format_version": BUILD_FORMAT_VERSION,
        "catalog_channel": "candidate",
        "target_arch": config.qemu.target_arch,
        "scenarios": scenarios_meta,
    });
    meta["course_catalog"] = serde_json::to_value(&curriculum.catalog)?;

    println!(
        "bundled {} scenarios ({} files) -> {}",
        prepared_scenarios.len(),
        source_files.len(),
        output_path.display()
    );

    if let Some(target) = bundle_upload_target(
        config.upload.as_ref(),
        args.url.as_deref(),
        args.token.as_deref(),
        args.no_upload,
    )? {
        let receipt = upload_bundle(&target, &output_path, &rev, &meta)?;
        println!(
            "uploaded bundle {rev} -> {} ({} queued, {} assigned)",
            target.url, receipt.queued, receipt.assigned
        );
    }

    Ok(())
}

mod bundle_command;
use bundle_command::*;
mod curriculum;
use curriculum::*;

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
        scenario_path: source.scenario_path.clone(),
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

fn validate_scenario(
    scenario: &Scenario,
    base_catalog: &BaseImageCatalog,
    vm_filter: Option<&str>,
    target_arch: &str,
) -> Result<()> {
    scenario
        .validate_technical_for_builder_arch(target_arch)
        .with_context(|| format!("scenario '{}' failed validation", scenario.name))?;
    base_catalog
        .validate_for_builder_arch(target_arch)
        .with_context(|| format!("base image catalog failed validation for '{target_arch}'"))?;
    base_catalog
        .validate_scenario_for_builder_arch(scenario, target_arch)
        .with_context(|| format!("scenario '{}' base images failed validation", scenario.name))?;

    for vm_name in selected_vm_names(scenario, vm_filter)? {
        scenario
            .derive_kino_config_for_vm(&vm_name)
            .with_context(|| {
                format!(
                    "failed to derive kino config for {}:{}",
                    scenario.name, vm_name
                )
            })?;
    }

    Ok(())
}

fn selected_vm_names(scenario: &Scenario, vm_filter: Option<&str>) -> Result<Vec<String>> {
    if let Some(vm_name) = vm_filter {
        if scenario.vm_by_name(vm_name).is_none() {
            bail!("vm '{}' not found in scenario '{}'", vm_name, scenario.name);
        }
        return Ok(vec![vm_name.to_string()]);
    }

    Ok(scenario.vms.iter().map(|vm| vm.name.clone()).collect())
}

fn load_course_scenario(path: &Path) -> Result<Scenario> {
    Scenario::from_course_file(path)
        .with_context(|| format!("failed to load scenario from {}", path.display()))
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
