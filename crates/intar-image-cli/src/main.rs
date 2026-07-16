use anyhow::{Context, Result, anyhow, bail};
use clap::{Args, Parser, Subcommand};
use flate2::{Compression, GzBuilder};
use intar_contracts::catalog::{ImageArchitecture, ImageKey};
use intar_image_build::{
    BUILD_FORMAT_VERSION, BuildConfig, DirectBuildOutput, DirectBuildRequest, KinoArtifact,
    RawUploadConfig, ScenarioContentHashInput, combine_scenario_manifests, render_direct_build,
    run_direct_build, scenario_content_hash,
};
use intar_image_scenario::{BaseImageCatalog, BuildTools, Scenario};
use intar_image_upload::{ImageUploadConfig, ImageUploader, PublishArtifactFile, PublishImageFile};
use std::collections::BTreeMap;
use std::env;
use std::ffi::OsStr;
use std::io::Cursor;
use std::path::{Component, Path, PathBuf};
use std::{fs, process::Command as ProcessCommand};

const BASE_IMAGES_PATH: &str = "base-images.hcl";
const BUILD_TOOLS_PATH: &str = "build-tools.hcl";
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

#[derive(Debug, Parser)]
#[command(name = "intar-image-cli")]
#[command(about = "Build prebaked scenario raw-zstd images with direct QEMU")]
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
    Hash(HashCommand),
    Bundle(BundleCommand),
}

#[derive(Debug, Args)]
struct ScenarioCommand {
    scenario: Option<String>,
    #[arg(long)]
    vm: Option<String>,
}

#[derive(Debug, Args)]
struct RenderCommand {
    scenario: Option<String>,
    #[arg(long)]
    vm: Option<String>,
    #[arg(long)]
    config: Option<PathBuf>,
    #[arg(long)]
    kino_binary: PathBuf,
}

#[derive(Debug, Args)]
struct BuildCommand {
    scenario: Option<String>,
    #[arg(long)]
    vm: Option<String>,
    #[arg(long)]
    config: Option<PathBuf>,
    #[arg(long)]
    kino_binary: PathBuf,
    #[arg(long)]
    no_upload: bool,
}

#[derive(Debug, Args)]
struct BuildAllCommand {
    #[arg(long)]
    config: Option<PathBuf>,
    #[arg(long)]
    kino_binary: PathBuf,
    #[arg(long)]
    no_upload: bool,
}

#[derive(Debug, Args)]
struct HashCommand {
    scenario: Option<String>,
    #[arg(long)]
    config: Option<PathBuf>,
}

#[derive(Debug, Args)]
struct BundleCommand {
    scenario: Option<String>,
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
        Command::Hash(args) => hash_command(&args),
        Command::Bundle(args) => bundle_command(&args),
    }
}

fn validate_command(args: &ScenarioCommand) -> Result<()> {
    let base_catalog = load_base_image_catalog()?;
    let scenario_paths = selected_scenario_paths(args.scenario.as_deref())?;
    for scenario_path in scenario_paths {
        let scenario = load_scenario(&scenario_path)?;
        validate_scenario(&scenario, &base_catalog, args.vm.as_deref(), "amd64")?;
        println!("validated {} ({})", scenario.name, scenario_path.display());
    }
    Ok(())
}

fn render_command(args: &RenderCommand) -> Result<()> {
    let config = load_build_config(args.config.as_deref())?;
    let kino = load_kino_artifact(&args.kino_binary)?;
    let base_catalog = load_base_image_catalog()?;
    let scenario_paths = selected_scenario_paths(args.scenario.as_deref())?;

    for scenario_path in scenario_paths {
        let scenario = load_scenario(&scenario_path)?;
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
                &scenario_path,
                &scenario,
                &vm_name,
                &kino,
            )?;
            let rendered = render_direct_build(&request)
                .with_context(|| format!("failed to render {}:{}", scenario.name, vm_name))?;
            println!(
                "rendered {}:{} -> {}",
                scenario.name,
                vm_name,
                rendered.paths.output_image_path.display()
            );
        }
    }

    Ok(())
}

fn build_command(args: &BuildCommand) -> Result<()> {
    let config = load_build_config(args.config.as_deref())?;
    let kino = load_kino_artifact(&args.kino_binary)?;
    let base_catalog = load_base_image_catalog()?;
    let uploader = build_uploader(config.upload.as_ref(), args.no_upload)?;
    let scenario_paths = selected_scenario_paths(args.scenario.as_deref())?;
    let mut completed_builds = Vec::new();

    for scenario_path in scenario_paths {
        let scenario = load_scenario(&scenario_path)?;
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
                &scenario_path,
                &scenario,
                &vm_name,
                &kino,
            )?;
            let output = build_vm(&request)?;
            println!(
                "built {}:{} -> {}",
                scenario.name,
                vm_name,
                output.artifact.raw_zstd_path.display()
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
    let kino = load_kino_artifact(&args.kino_binary)?;
    let base_catalog = load_base_image_catalog()?;
    let uploader = build_uploader(config.upload.as_ref(), args.no_upload)?;
    let mut completed_builds = Vec::new();

    for scenario_path in selected_scenario_paths(None)? {
        let scenario = load_scenario(&scenario_path)?;
        validate_scenario(&scenario, &base_catalog, None, &config.qemu.target_arch)?;
        for vm_name in selected_vm_names(&scenario, None)? {
            let request = prepare_direct_render_request(
                &config,
                &base_catalog,
                &scenario_path,
                &scenario,
                &vm_name,
                &kino,
            )?;
            let output = build_vm(&request)?;
            println!(
                "built {}:{} -> {}",
                scenario.name,
                vm_name,
                output.artifact.raw_zstd_path.display()
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
    let base_catalog = load_base_image_catalog()?;
    let build_tools = load_build_tools()?;
    let scenario_paths = selected_scenario_paths(args.scenario.as_deref())?;

    for scenario_path in scenario_paths {
        let scenario = load_scenario(&scenario_path)?;
        validate_scenario(&scenario, &base_catalog, None, &config.qemu.target_arch)?;
        let base_definition =
            scenario_base_definition_identity(&scenario, &base_catalog, &config.qemu.target_arch)?;
        let scenario_dir = scenario_path.parent().with_context(|| {
            format!("scenario path '{}' has no parent", scenario_path.display())
        })?;
        let hash = scenario_content_hash(&ScenarioContentHashInput {
            scenario_id: &scenario.name,
            scenario_dir,
            base_definition: &base_definition,
            kino_version: &build_tools.kino.version,
            target_arch: &config.qemu.target_arch,
        })?;
        println!("{}\t{}\t{}", scenario.name, config.qemu.target_arch, hash);
    }

    Ok(())
}

fn bundle_command(args: &BundleCommand) -> Result<()> {
    let config = load_build_config(args.config.as_deref())?;
    let base_catalog = load_base_image_catalog()?;
    let build_tools = load_build_tools()?;
    let contract_arch = contract_image_arch_slug(&config.qemu.target_arch)?;
    let rev = args
        .rev
        .clone()
        .map(Ok)
        .unwrap_or_else(default_bundle_rev)?;
    validate_bundle_rev(&rev)?;
    let scenario_paths = selected_scenario_paths(args.scenario.as_deref())?;

    let mut prepared_scenarios = Vec::new();
    for scenario_path in scenario_paths {
        let scenario = load_scenario(&scenario_path)?;
        validate_scenario(&scenario, &base_catalog, None, &config.qemu.target_arch)?;
        let base_definition =
            scenario_base_definition_identity(&scenario, &base_catalog, &config.qemu.target_arch)?;
        let scenario_dir = scenario_path.parent().with_context(|| {
            format!("scenario path '{}' has no parent", scenario_path.display())
        })?;
        let content_hash = scenario_content_hash(&ScenarioContentHashInput {
            scenario_id: &scenario.name,
            scenario_dir,
            base_definition: &base_definition,
            kino_version: &build_tools.kino.version,
            target_arch: &config.qemu.target_arch,
        })?;
        prepared_scenarios.push(PreparedBundleScenario {
            scenario_id: scenario.name,
            scenario_dir: scenario_dir.to_path_buf(),
            content_hash,
        });
    }

    let source_files = collect_bundle_source_files(&prepared_scenarios)?;
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
    let meta = serde_json::json!({
        "rev": rev,
        "kino_version": build_tools.kino.version,
        "build_format_version": BUILD_FORMAT_VERSION,
        "target_arch": config.qemu.target_arch,
        "scenarios": scenarios_meta,
    });

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
        upload_bundle(&target, &output_path, &rev, &meta)?;
        println!("uploaded bundle {rev} -> {}", target.url);
    }

    Ok(())
}

mod bundle_command;
use bundle_command::*;
fn load_kino_artifact(path: &Path) -> Result<KinoArtifact> {
    let binary_path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .context("failed to determine current directory")?
            .join(path)
    };
    if !binary_path.is_file() {
        bail!("kino binary does not exist at {}", binary_path.display());
    }

    Ok(KinoArtifact {
        binary_path,
        version: kino_package_version()?,
    })
}

fn kino_package_version() -> Result<String> {
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let output = ProcessCommand::new(cargo)
        .args(["pkgid", "-p", "kino"])
        .output()
        .context("failed to execute `cargo pkgid -p kino`")?;
    if !output.status.success() {
        bail!(
            "`cargo pkgid -p kino` failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let stdout = String::from_utf8(output.stdout).context("cargo pkgid emitted invalid UTF-8")?;
    let package_id = stdout.trim();
    let version = kino_version_from_package_id(package_id)?;
    Ok(version.to_string())
}

fn kino_version_from_package_id(package_id: &str) -> Result<&str> {
    package_id
        .rsplit_once('@')
        .or_else(|| package_id.rsplit_once('#'))
        .map(|(_, version)| version)
        .filter(|version| !version.is_empty())
        .with_context(|| format!("failed to parse kino package id `{package_id}`"))
}

fn prepare_direct_render_request(
    config: &BuildConfig,
    base_catalog: &BaseImageCatalog,
    scenario_path: &Path,
    scenario: &Scenario,
    vm_name: &str,
    kino: &KinoArtifact,
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
        scenario_path: scenario_path.to_path_buf(),
        scenario: scenario.clone(),
        vm_name: vm_name.to_string(),
        config: config.qemu.clone(),
        base_image: base_image.clone(),
        kino: kino.clone(),
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
        .validate_for_builder_arch(target_arch)
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

fn load_scenario(path: &Path) -> Result<Scenario> {
    Scenario::from_file(path)
        .with_context(|| format!("failed to load scenario from {}", path.display()))
}

fn selected_scenario_paths(scenario_name: Option<&str>) -> Result<Vec<PathBuf>> {
    if let Some(scenario_name) = scenario_name {
        validate_scenario_arg(scenario_name)?;
        let path = PathBuf::from("scenarios")
            .join(scenario_name)
            .join("scenario.hcl");
        if !path.is_file() {
            bail!(
                "scenario '{}' not found at {}",
                scenario_name,
                path.display()
            );
        }
        return Ok(vec![path]);
    }

    let scenarios_root = Path::new("scenarios");
    if !scenarios_root.is_dir() {
        bail!(
            "scenarios directory '{}' does not exist",
            scenarios_root.display()
        );
    }

    let mut paths = fs::read_dir(scenarios_root)
        .with_context(|| format!("failed to read {}", scenarios_root.display()))?
        .filter_map(std::result::Result::ok)
        .map(|entry| entry.path().join("scenario.hcl"))
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    paths.sort();

    if paths.is_empty() {
        bail!("no scenarios found under {}", scenarios_root.display());
    }

    Ok(paths)
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
        let mut files = Vec::new();
        for build in &builds {
            let vm_manifest = build
                .output
                .artifact
                .manifest
                .vms
                .first()
                .ok_or_else(|| anyhow!("build manifest for {} has no VMs", build.vm_name))?;
            files.push(PublishImageFile::new(
                build.vm_name.clone(),
                &build.output.artifact.raw_zstd_path,
                registry_image_filename(&vm_manifest.image_key),
            )?);
        }
        let artifacts = publish_artifacts_from_builds(&builds)?;
        let receipt = uploader
            .publish_manifest_with_artifacts(&manifest, &files, &artifacts)
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

fn registry_image_filename(image_key: &ImageKey) -> String {
    format!(
        "{}-{}-{}.raw.zst",
        image_key.scenario,
        image_key.vm,
        image_arch_slug(&image_key.arch)
    )
}

fn image_arch_slug(arch: &ImageArchitecture) -> &'static str {
    match arch {
        ImageArchitecture::X86_64 => "x86_64",
        ImageArchitecture::Aarch64 => "aarch64",
    }
}

#[cfg(test)]
mod tests;
