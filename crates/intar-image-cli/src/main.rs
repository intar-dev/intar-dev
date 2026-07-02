use anyhow::{Context, Result, anyhow, bail};
use clap::{Args, Parser, Subcommand};
use intar_contracts::catalog::{ImageArchitecture, ImageKey, ScenarioManifestV1};
use intar_image_build::{
    BaseBuildArtifact, BaseBuildRequest, BuildConfig, BuildOutput, BuildRequest, BuildSource,
    KinoArtifact, RawUploadConfig, ensure_base_build, render_vm_build, run_packer_build,
    run_packer_validate,
};
use intar_image_scenario::{BaseImageCatalog, Scenario};
use intar_image_upload::{ImageUploadConfig, ImageUploader, PublishImageFile};
use std::collections::{BTreeMap, HashMap};
use std::env;
use std::path::{Path, PathBuf};
use std::{fs, process::Command as ProcessCommand};

const BASE_IMAGES_PATH: &str = "base-images.hcl";
const IMAGE_PUBLISH_TOKEN_ENV: &str = "INTAR_IMAGE_PUBLISH_TOKEN";

#[derive(Default)]
struct BaseArtifactCache {
    artifacts: HashMap<String, BaseBuildArtifact>,
}

struct CompletedBuild {
    scenario_name: String,
    vm_name: String,
    output: BuildOutput,
}

#[derive(Debug, Parser)]
#[command(name = "intar-image-cli")]
#[command(about = "Build prebaked scenario qcow2 images with packer")]
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

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Validate(args) => validate_command(&args),
        Command::Render(args) => render_command(&args),
        Command::Build(args) => build_command(&args),
        Command::BuildAll(args) => build_all_command(&args),
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
    let mut base_cache = BaseArtifactCache::default();
    let scenario_paths = selected_scenario_paths(args.scenario.as_deref())?;

    for scenario_path in scenario_paths {
        let scenario = load_scenario(&scenario_path)?;
        validate_scenario(
            &scenario,
            &base_catalog,
            args.vm.as_deref(),
            &config.packer.target_arch,
        )?;
        for vm_name in selected_vm_names(&scenario, args.vm.as_deref())? {
            let request = prepare_vm_build_request(
                &config,
                &base_catalog,
                &mut base_cache,
                &scenario_path,
                &scenario,
                &vm_name,
                &kino,
            )?;
            let rendered = render_vm_build(&request)
                .with_context(|| format!("failed to render {}:{}", scenario.name, vm_name))?;
            println!(
                "rendered {}:{} -> {}",
                scenario.name,
                vm_name,
                rendered.paths.output_path.display()
            );
        }
    }

    Ok(())
}

fn build_command(args: &BuildCommand) -> Result<()> {
    let config = load_build_config(args.config.as_deref())?;
    let kino = load_kino_artifact(&args.kino_binary)?;
    let base_catalog = load_base_image_catalog()?;
    let mut base_cache = BaseArtifactCache::default();
    let uploader = build_uploader(config.upload.as_ref(), args.no_upload)?;
    let scenario_paths = selected_scenario_paths(args.scenario.as_deref())?;
    let mut completed_builds = Vec::new();

    for scenario_path in scenario_paths {
        let scenario = load_scenario(&scenario_path)?;
        validate_scenario(
            &scenario,
            &base_catalog,
            args.vm.as_deref(),
            &config.packer.target_arch,
        )?;
        for vm_name in selected_vm_names(&scenario, args.vm.as_deref())? {
            let request = prepare_vm_build_request(
                &config,
                &base_catalog,
                &mut base_cache,
                &scenario_path,
                &scenario,
                &vm_name,
                &kino,
            )?;
            let output = build_vm(&config, &request)?;
            println!(
                "built {}:{} -> {}",
                scenario.name,
                vm_name,
                output.artifact.qcow2_path.display()
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
    let mut base_cache = BaseArtifactCache::default();
    let uploader = build_uploader(config.upload.as_ref(), args.no_upload)?;
    let mut completed_builds = Vec::new();

    for scenario_path in selected_scenario_paths(None)? {
        let scenario = load_scenario(&scenario_path)?;
        validate_scenario(&scenario, &base_catalog, None, &config.packer.target_arch)?;
        for vm_name in selected_vm_names(&scenario, None)? {
            let request = prepare_vm_build_request(
                &config,
                &base_catalog,
                &mut base_cache,
                &scenario_path,
                &scenario,
                &vm_name,
                &kino,
            )?;
            let output = build_vm(&config, &request)?;
            println!(
                "built {}:{} -> {}",
                scenario.name,
                vm_name,
                output.artifact.qcow2_path.display()
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

fn load_build_config(path: Option<&Path>) -> Result<BuildConfig> {
    match path {
        Some(path) => BuildConfig::from_file(path)
            .with_context(|| format!("failed to load build config from {}", path.display())),
        None => Ok(BuildConfig::default()),
    }
}

fn load_base_image_catalog() -> Result<BaseImageCatalog> {
    let path = Path::new(BASE_IMAGES_PATH);
    BaseImageCatalog::from_file(path)
        .with_context(|| format!("failed to load base image catalog from {}", path.display()))
}

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

impl BaseArtifactCache {
    fn get_or_build(
        &mut self,
        config: &BuildConfig,
        base_catalog: &BaseImageCatalog,
        scenario: &Scenario,
        vm_name: &str,
        kino: &KinoArtifact,
    ) -> Result<BaseBuildArtifact> {
        let vm = scenario
            .vm_by_name(vm_name)
            .with_context(|| format!("vm '{vm_name}' not found in scenario '{}'", scenario.name))?;
        let image = scenario.image_by_name(&vm.image).with_context(|| {
            format!(
                "image '{}' not found in scenario '{}'",
                vm.image, scenario.name
            )
        })?;
        let base_key = format!("{}:{}", image.base, config.packer.target_arch);

        if let Some(existing) = self.artifacts.get(&base_key) {
            return Ok(existing.clone());
        }

        let base_image = base_catalog
            .base_image_by_name(&image.base)
            .with_context(|| format!("base image '{}' not found in catalog", image.base))?;
        let source = base_image
            .source_for_arch(&config.packer.target_arch)
            .with_context(|| {
                format!(
                    "base image '{}' does not define a {} source",
                    image.base, config.packer.target_arch
                )
            })?;

        let artifact = ensure_base_build(&BaseBuildRequest {
            base_name: image.base.clone(),
            source: BuildSource {
                url: source.url.clone(),
                checksum: source.checksum.clone(),
            },
            config: config.packer.clone(),
            kino: kino.clone(),
        })?;
        self.artifacts.insert(base_key, artifact.clone());
        Ok(artifact)
    }
}

fn prepare_vm_build_request(
    config: &BuildConfig,
    base_catalog: &BaseImageCatalog,
    base_cache: &mut BaseArtifactCache,
    scenario_path: &Path,
    scenario: &Scenario,
    vm_name: &str,
    kino: &KinoArtifact,
) -> Result<BuildRequest> {
    let base_artifact = base_cache.get_or_build(config, base_catalog, scenario, vm_name, kino)?;

    Ok(BuildRequest {
        scenario_path: scenario_path.to_path_buf(),
        scenario: scenario.clone(),
        vm_name: vm_name.to_string(),
        config: config.packer.clone(),
        source: BuildSource {
            url: absolute_path_string(&base_artifact.qcow2_path),
            checksum: format!("sha256:{}", base_artifact.sha256_hex),
        },
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

fn build_vm(config: &BuildConfig, request: &BuildRequest) -> Result<BuildOutput> {
    let rendered = render_vm_build(request).with_context(|| {
        format!(
            "failed to render {}:{}",
            request.scenario.name, request.vm_name
        )
    })?;
    run_packer_validate(&rendered, &config.packer).with_context(|| {
        format!(
            "packer validate failed for {}:{}",
            request.scenario.name, request.vm_name
        )
    })?;
    run_packer_build(rendered, &config.packer).with_context(|| {
        format!(
            "packer build failed for {}:{}",
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
        let manifest = combined_manifest(&builds)?;
        let mut files = Vec::new();
        for build in builds {
            let vm_manifest = build
                .output
                .artifact
                .manifest
                .vms
                .first()
                .ok_or_else(|| anyhow!("build manifest for {} has no VMs", build.vm_name))?;
            files.push(PublishImageFile::new(
                build.vm_name.clone(),
                &build.output.artifact.qcow2_path,
                registry_image_filename(&vm_manifest.image_key),
            )?);
        }
        let receipt = uploader
            .publish_manifest(&manifest, &files)
            .with_context(|| format!("failed to publish scenario {scenario_name}"))?;
        println!(
            "published {} -> {} images",
            receipt.scenario_id,
            receipt.images.len()
        );
    }

    Ok(())
}

fn combined_manifest(builds: &[&CompletedBuild]) -> Result<ScenarioManifestV1> {
    let first = builds
        .first()
        .ok_or_else(|| anyhow!("cannot publish an empty build set"))?;
    let mut manifest = first.output.artifact.manifest.clone();
    manifest.vms.clear();

    for build in builds {
        let current = &build.output.artifact.manifest;
        if current.scenario_id != manifest.scenario_id
            || current.name != manifest.name
            || current.description != manifest.description
        {
            bail!("cannot combine manifests from different scenarios");
        }
        manifest.vms.extend(current.vms.clone());
    }

    Ok(manifest)
}

fn registry_image_filename(image_key: &ImageKey) -> String {
    format!(
        "{}-{}-{}.qcow2",
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

fn absolute_path_string(path: &Path) -> String {
    if path.is_absolute() {
        return path.to_string_lossy().into_owned();
    }

    match std::env::current_dir() {
        Ok(cwd) => cwd.join(path).to_string_lossy().into_owned(),
        Err(_) => path.to_string_lossy().into_owned(),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::kino_version_from_package_id;

    #[test]
    fn parses_path_package_id_version() {
        assert_eq!(
            kino_version_from_package_id("path+file:///workspace/intar-dev/crates/kino#0.1.24")
                .expect("path package id should parse"),
            "0.1.24"
        );
    }

    #[test]
    fn parses_registry_package_id_version() {
        assert_eq!(
            kino_version_from_package_id(
                "registry+https://github.com/rust-lang/crates.io-index#kino@0.1.24"
            )
            .expect("registry package id should parse"),
            "0.1.24"
        );
    }
}
