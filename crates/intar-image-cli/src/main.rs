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
const COURSES_PATH: &str = "courses.hcl";
const DEFAULT_SCENARIOS_ROOT: &str = "content/scenarios";
const DEFAULT_COURSES_PATH: &str = "content/courses.hcl";
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct DiscoveredScenario {
    scenario_id: String,
    scenario_path: PathBuf,
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
    #[arg(long)]
    courses_root: Option<PathBuf>,
    #[arg(long, default_value = BASE_IMAGES_PATH)]
    base_images: PathBuf,
}

#[derive(Debug, Args)]
struct RenderCommand {
    scenario: Option<String>,
    #[arg(long)]
    vm: Option<String>,
    #[arg(long)]
    config: Option<PathBuf>,
}

#[derive(Debug, Args)]
struct BuildCommand {
    scenario: Option<String>,
    #[arg(long)]
    vm: Option<String>,
    #[arg(long)]
    config: Option<PathBuf>,
    #[arg(long)]
    no_upload: bool,
}

#[derive(Debug, Args)]
struct BuildAllCommand {
    #[arg(long)]
    config: Option<PathBuf>,
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
    #[arg(long)]
    courses_root: Option<PathBuf>,
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
    let base_catalog = load_base_image_catalog(&args.base_images)?;
    let course_manifest_path = course_manifest_path(args.courses_root.as_deref())?;
    let complete_scenario_paths = if course_manifest_is_present(&course_manifest_path)? {
        let complete_scenario_paths = selected_scenario_paths(None, args.courses_root.as_deref())?;
        load_bundle_course_catalog(&course_manifest_path, &complete_scenario_paths)?;
        Some(complete_scenario_paths)
    } else {
        None
    };
    let scenario_paths = match (args.scenario.as_deref(), complete_scenario_paths) {
        (Some(scenario), _) => {
            selected_scenario_paths(Some(scenario), args.courses_root.as_deref())?
        }
        (None, Some(complete_scenario_paths)) => complete_scenario_paths,
        (None, None) => selected_scenario_paths(None, args.courses_root.as_deref())?,
    };
    for scenario_path in scenario_paths {
        let scenario = load_scenario(&scenario_path)?;
        validate_scenario(&scenario, &base_catalog, args.vm.as_deref(), "amd64")?;
        println!("validated {} ({})", scenario.name, scenario_path.display());
    }
    Ok(())
}

fn render_command(args: &RenderCommand) -> Result<()> {
    let config = load_build_config(args.config.as_deref())?;
    let base_catalog = load_base_image_catalog(Path::new(BASE_IMAGES_PATH))?;
    let scenario_paths = selected_scenario_paths(args.scenario.as_deref(), None)?;

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
    let base_catalog = load_base_image_catalog(Path::new(BASE_IMAGES_PATH))?;
    let uploader = build_uploader(config.upload.as_ref(), args.no_upload)?;
    let scenario_paths = selected_scenario_paths(args.scenario.as_deref(), None)?;
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
    let base_catalog = load_base_image_catalog(Path::new(BASE_IMAGES_PATH))?;
    let uploader = build_uploader(config.upload.as_ref(), args.no_upload)?;
    let mut completed_builds = Vec::new();

    for scenario_path in selected_scenario_paths(None, None)? {
        let scenario = load_scenario(&scenario_path)?;
        validate_scenario(&scenario, &base_catalog, None, &config.qemu.target_arch)?;
        for vm_name in selected_vm_names(&scenario, None)? {
            let request = prepare_direct_render_request(
                &config,
                &base_catalog,
                &scenario_path,
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
    let base_catalog = load_base_image_catalog(Path::new(BASE_IMAGES_PATH))?;
    let scenario_paths = selected_scenario_paths(args.scenario.as_deref(), None)?;

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
            target_arch: &config.qemu.target_arch,
        })?;
        println!("{}\t{}\t{}", scenario.name, config.qemu.target_arch, hash);
    }

    Ok(())
}

fn bundle_command(args: &BundleCommand) -> Result<()> {
    let config = load_build_config(args.config.as_deref())?;
    let base_catalog = load_base_image_catalog(&args.base_images)?;
    let contract_arch = contract_image_arch_slug(&config.qemu.target_arch)?;
    let rev = args
        .rev
        .clone()
        .map(Ok)
        .unwrap_or_else(default_bundle_rev)?;
    validate_bundle_rev(&rev)?;
    let course_manifest_path = course_manifest_path(args.courses_root.as_deref())?;
    let (course_catalog, complete_scenario_paths) =
        if course_manifest_is_present(&course_manifest_path)? {
            let complete_scenario_paths =
                selected_scenario_paths(None, args.courses_root.as_deref())?;
            let course_catalog =
                load_bundle_course_catalog(&course_manifest_path, &complete_scenario_paths)?;
            (course_catalog, Some(complete_scenario_paths))
        } else {
            (None, None)
        };
    let scenario_paths = match (args.scenario.as_deref(), complete_scenario_paths) {
        (Some(scenario), _) => {
            selected_scenario_paths(Some(scenario), args.courses_root.as_deref())?
        }
        (None, Some(complete_scenario_paths)) => complete_scenario_paths,
        (None, None) => selected_scenario_paths(None, args.courses_root.as_deref())?,
    };

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
            target_arch: &config.qemu.target_arch,
        })?;
        prepared_scenarios.push(PreparedBundleScenario {
            scenario_id: scenario.name,
            scenario_dir: scenario_dir.to_path_buf(),
            content_hash,
        });
    }

    let source_files = collect_bundle_source_files(
        &prepared_scenarios,
        &args.base_images,
        course_catalog
            .as_ref()
            .map(|_| course_manifest_path.as_path()),
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
    if let Some(course_catalog) = &course_catalog {
        meta["course_catalog"] = serde_json::to_value(course_catalog)?;
    }

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

fn prepare_direct_render_request(
    config: &BuildConfig,
    base_catalog: &BaseImageCatalog,
    scenario_path: &Path,
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
        scenario_path: scenario_path.to_path_buf(),
        scenario: scenario.clone(),
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

fn selected_scenario_paths(
    scenario_name: Option<&str>,
    courses_root: Option<&Path>,
) -> Result<Vec<PathBuf>> {
    if let Some(scenario_name) = scenario_name {
        validate_scenario_arg(scenario_name)?;
    }

    let discovered = if let Some(courses_root) = courses_root {
        discover_course_scenarios(courses_root)?
    } else if let Some(scenario_name) = scenario_name {
        vec![discover_legacy_scenario(
            Path::new(DEFAULT_SCENARIOS_ROOT),
            scenario_name,
        )?]
    } else {
        discover_legacy_scenarios(Path::new(DEFAULT_SCENARIOS_ROOT))?
    };

    if let Some(scenario_name) = scenario_name {
        let matching = discovered
            .into_iter()
            .find(|scenario| scenario.scenario_id == scenario_name)
            .with_context(|| {
                let root = courses_root.unwrap_or_else(|| Path::new(DEFAULT_SCENARIOS_ROOT));
                format!(
                    "scenario '{}' not found under {}",
                    scenario_name,
                    root.display()
                )
            })?;
        return Ok(vec![matching.scenario_path]);
    }

    Ok(discovered
        .into_iter()
        .map(|scenario| scenario.scenario_path)
        .collect())
}

fn discover_legacy_scenarios(root: &Path) -> Result<Vec<DiscoveredScenario>> {
    require_real_directory(root, "scenarios directory")?;
    let mut discovered = BTreeMap::new();
    for entry in sorted_directory_entries(root)? {
        let path = entry.path();
        let file_type = entry
            .file_type()
            .with_context(|| format!("failed to stat '{}'", path.display()))?;
        if file_type.is_symlink() {
            bail!(
                "symlink is not allowed in scenario sources: {}",
                path.display()
            );
        }
        if file_type.is_dir() {
            add_discovered_scenario(&path, &mut discovered)?;
        }
    }
    finish_discovery(root, discovered)
}

fn discover_legacy_scenario(root: &Path, scenario_id: &str) -> Result<DiscoveredScenario> {
    require_real_directory(root, "scenarios directory")?;
    let scenario_dir = root.join(scenario_id);
    let metadata = fs::symlink_metadata(&scenario_dir).with_context(|| {
        format!(
            "scenario '{}' not found at {}",
            scenario_id,
            scenario_dir.join("scenario.hcl").display()
        )
    })?;
    if metadata.file_type().is_symlink() {
        bail!(
            "symlink is not allowed in scenario sources: {}",
            scenario_dir.display()
        );
    }
    if !metadata.is_dir() {
        bail!(
            "scenario '{}' not found at {}",
            scenario_id,
            scenario_dir.join("scenario.hcl").display()
        );
    }

    let mut discovered = BTreeMap::new();
    add_discovered_scenario(&scenario_dir, &mut discovered)?;
    discovered
        .remove(scenario_id)
        .with_context(|| format!("scenario '{scenario_id}' was not discovered"))
}

fn discover_course_scenarios(courses_root: &Path) -> Result<Vec<DiscoveredScenario>> {
    require_real_directory(courses_root, "courses directory")?;
    let mut discovered = BTreeMap::new();

    for course_entry in sorted_directory_entries(courses_root)? {
        let course_path = course_entry.path();
        let file_type = course_entry
            .file_type()
            .with_context(|| format!("failed to stat '{}'", course_path.display()))?;
        if file_type.is_symlink() {
            bail!(
                "symlink is not allowed in course sources: {}",
                course_path.display()
            );
        }
        if !file_type.is_dir() {
            continue;
        }
        let course_id = course_entry.file_name();
        let course_id = course_id.to_str().with_context(|| {
            format!(
                "course directory name is not valid UTF-8: {}",
                course_path.display()
            )
        })?;
        validate_safe_cli_slug("course", course_id).with_context(|| {
            format!("course ID in {} is not a safe slug", course_path.display())
        })?;

        for scenario_entry in sorted_directory_entries(&course_path)? {
            let scenario_dir = scenario_entry.path();
            let file_type = scenario_entry
                .file_type()
                .with_context(|| format!("failed to stat '{}'", scenario_dir.display()))?;
            if file_type.is_symlink() {
                bail!(
                    "symlink is not allowed in course sources: {}",
                    scenario_dir.display()
                );
            }
            if file_type.is_dir() {
                add_discovered_scenario(&scenario_dir, &mut discovered)?;
            }
        }
    }

    finish_discovery(courses_root, discovered)
}

fn add_discovered_scenario(
    scenario_dir: &Path,
    discovered: &mut BTreeMap<String, DiscoveredScenario>,
) -> Result<()> {
    let scenario_path = scenario_dir.join("scenario.hcl");
    let metadata = match fs::symlink_metadata(&scenario_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            bail!(
                "scenario directory '{}' is missing scenario.hcl",
                scenario_dir.display()
            );
        }
        Err(error) => {
            return Err(error)
                .with_context(|| format!("failed to stat {}", scenario_path.display()));
        }
    };
    if metadata.file_type().is_symlink() {
        bail!(
            "symlink is not allowed in scenario sources: {}",
            scenario_path.display()
        );
    }
    if !metadata.is_file() {
        bail!(
            "scenario source '{}' is not a regular file",
            scenario_path.display()
        );
    }

    reject_symlinks_recursively(scenario_dir)?;
    let scenario = load_scenario(&scenario_path)?;
    validate_scenario_arg(&scenario.name).with_context(|| {
        format!(
            "scenario ID in {} is not a safe slug",
            scenario_path.display()
        )
    })?;
    let directory_id = scenario_dir
        .file_name()
        .and_then(OsStr::to_str)
        .with_context(|| {
            format!(
                "scenario directory name is not valid UTF-8: {}",
                scenario_dir.display()
            )
        })?;
    if directory_id != scenario.name {
        bail!(
            "scenario directory basename '{}' does not match HCL scenario ID '{}' in {}",
            directory_id,
            scenario.name,
            scenario_path.display()
        );
    }

    let scenario_id = scenario.name;
    if let Some(previous) = discovered.get(&scenario_id) {
        bail!(
            "duplicate scenario ID '{}' in {} and {}",
            scenario_id,
            previous.scenario_path.display(),
            scenario_path.display()
        );
    }
    discovered.insert(
        scenario_id.clone(),
        DiscoveredScenario {
            scenario_id,
            scenario_path,
        },
    );
    Ok(())
}

fn finish_discovery(
    root: &Path,
    discovered: BTreeMap<String, DiscoveredScenario>,
) -> Result<Vec<DiscoveredScenario>> {
    if discovered.is_empty() {
        bail!("no scenarios found under {}", root.display());
    }
    Ok(discovered.into_values().collect())
}

fn require_real_directory(path: &Path, label: &str) -> Result<()> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("{label} '{}' does not exist", path.display()))?;
    if metadata.file_type().is_symlink() {
        bail!("{label} '{}' must not be a symlink", path.display());
    }
    if !metadata.is_dir() {
        bail!("{label} '{}' is not a directory", path.display());
    }
    Ok(())
}

fn sorted_directory_entries(path: &Path) -> Result<Vec<fs::DirEntry>> {
    let mut entries = fs::read_dir(path)
        .with_context(|| format!("failed to read {}", path.display()))?
        .collect::<std::result::Result<Vec<_>, _>>()
        .with_context(|| format!("failed to read {}", path.display()))?;
    entries.sort_by_key(fs::DirEntry::file_name);
    Ok(entries)
}

fn reject_symlinks_recursively(path: &Path) -> Result<()> {
    for entry in sorted_directory_entries(path)? {
        let entry_path = entry.path();
        let file_type = entry
            .file_type()
            .with_context(|| format!("failed to stat '{}'", entry_path.display()))?;
        if file_type.is_symlink() {
            bail!(
                "symlink is not allowed in scenario sources: {}",
                entry_path.display()
            );
        }
        if file_type.is_dir() {
            reject_symlinks_recursively(&entry_path)?;
        }
    }
    Ok(())
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
