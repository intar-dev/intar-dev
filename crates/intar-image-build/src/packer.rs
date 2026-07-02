use anyhow::{Context, Result, bail};
use intar_contracts::catalog::{
    ImageArchitecture, ImageKey, Mib, ProbePhase as CatalogProbePhase, ScenarioManifestV1,
    ScenarioProbeManifestV1, ScenarioVmManifestV1,
};
use intar_image_scenario::{Scenario, VmDefinition};
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::config::PackerConfig;
use crate::provision::{render_base_provision_script, render_scenario_provision_script};

const PACKER_TEMPLATE: &str = include_str!("../templates/qemu.pkr.hcl");
const DEFAULT_SSH_USERNAME: &str = "ubuntu";
const BASE_IMAGE_DISK_GIB: u32 = 4;

#[derive(Debug, Clone)]
pub struct BuildSource {
    pub url: String,
    pub checksum: String,
}

#[derive(Debug, Clone)]
pub struct KinoArtifact {
    pub binary_path: PathBuf,
    pub version: String,
}

#[derive(Debug, Clone)]
pub struct BuildRequest {
    pub scenario_path: PathBuf,
    pub scenario: Scenario,
    pub vm_name: String,
    pub config: PackerConfig,
    pub source: BuildSource,
    pub kino: KinoArtifact,
}

#[derive(Debug, Clone)]
pub struct BaseBuildRequest {
    pub base_name: String,
    pub source: BuildSource,
    pub config: PackerConfig,
    pub kino: KinoArtifact,
}

#[derive(Debug, Clone)]
pub struct BuildPaths {
    pub output_path: PathBuf,
    pub output_checksum_path: PathBuf,
    pub output_metadata_path: PathBuf,
    pub work_root: PathBuf,
    pub packer_dir: PathBuf,
    pub packer_output_dir: PathBuf,
    pub packer_template_path: PathBuf,
    pub packer_vars_path: PathBuf,
    pub provision_script_path: PathBuf,
    pub seed_dir: PathBuf,
    pub seed_user_data_path: PathBuf,
    pub seed_meta_data_path: PathBuf,
    pub ssh_key_path: PathBuf,
    pub ssh_public_key_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct BaseBuildPaths {
    pub output_path: PathBuf,
    pub output_checksum_path: PathBuf,
    pub work_root: PathBuf,
    pub packer_dir: PathBuf,
    pub packer_output_dir: PathBuf,
    pub packer_template_path: PathBuf,
    pub packer_vars_path: PathBuf,
    pub provision_script_path: PathBuf,
    pub seed_dir: PathBuf,
    pub seed_user_data_path: PathBuf,
    pub seed_meta_data_path: PathBuf,
    pub ssh_key_path: PathBuf,
    pub ssh_public_key_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct RenderedBuild {
    pub scenario: Scenario,
    pub scenario_name: String,
    pub scenario_description: String,
    pub target_arch: String,
    pub effective_vm_name: String,
    pub paths: BuildPaths,
    pub vm: VmDefinition,
    pub source: BuildSource,
    pub kino: KinoArtifact,
}

#[derive(Debug, Clone)]
pub struct RenderedBaseBuild {
    pub base_name: String,
    pub target_arch: String,
    pub paths: BaseBuildPaths,
    pub source: BuildSource,
    pub kino: KinoArtifact,
}

#[derive(Debug, Clone)]
pub struct BuildOutput {
    pub rendered: RenderedBuild,
    pub artifact: BuildArtifact,
}

#[derive(Debug, Clone)]
pub struct BuildArtifact {
    pub qcow2_path: PathBuf,
    pub sha256_path: PathBuf,
    pub metadata_path: PathBuf,
    pub manifest: ScenarioManifestV1,
}

#[derive(Debug, Clone)]
pub struct BaseBuildOutput {
    pub rendered: RenderedBaseBuild,
    pub artifact: BaseBuildArtifact,
}

#[derive(Debug, Clone)]
pub struct BaseBuildArtifact {
    pub qcow2_path: PathBuf,
    pub sha256_path: PathBuf,
    pub sha256_hex: String,
}

/// Render a VM build into the working directory without executing packer.
///
/// # Errors
/// Returns an error when the scenario is invalid or the build inputs cannot be written.
pub fn render_vm_build(request: &BuildRequest) -> Result<RenderedBuild> {
    request
        .scenario
        .validate_for_builder_arch(&request.config.target_arch)?;

    let vm = request
        .scenario
        .vm_by_name(&request.vm_name)
        .cloned()
        .with_context(|| format!("vm '{}' not found", request.vm_name))?;

    let paths = build_paths(request, &vm);
    let provision_script = render_scenario_provision_script(&request.scenario, &vm)
        .context("failed to render provision script")?;
    prepare_build_workspace(
        BuildWorkspacePathsRef {
            output_path: &paths.output_path,
            packer_dir: &paths.packer_dir,
            packer_output_dir: &paths.packer_output_dir,
            packer_template_path: &paths.packer_template_path,
            packer_vars_path: &paths.packer_vars_path,
            provision_script_path: &paths.provision_script_path,
            seed_dir: &paths.seed_dir,
            seed_user_data_path: &paths.seed_user_data_path,
            seed_meta_data_path: &paths.seed_meta_data_path,
            ssh_key_path: &paths.ssh_key_path,
            ssh_public_key_path: &paths.ssh_public_key_path,
        },
        &request.config,
        &request.source,
        &request.kino.binary_path,
        VmBuildConfig {
            cpu: request.config.build_cpus,
            memory_mb: request.config.build_memory_mb,
            disk_gib: vm.disk,
            skip_compaction: false,
            disk_compression: true,
        },
        &provision_script,
        &scenario_instance_id(
            &request.scenario.name,
            &vm.name,
            &request.config.target_arch,
        ),
    )?;

    let effective_vm_name = effective_vm_name(&vm.name, &request.config.target_arch);

    Ok(RenderedBuild {
        scenario: request.scenario.clone(),
        scenario_name: request.scenario.name.clone(),
        scenario_description: request.scenario.description.clone(),
        target_arch: request.config.target_arch.clone(),
        effective_vm_name,
        paths,
        vm,
        source: request.source.clone(),
        kino: request.kino.clone(),
    })
}

/// Render a base image build into the working directory without executing packer.
///
/// # Errors
/// Returns an error when the build inputs cannot be written.
pub fn render_base_build(request: &BaseBuildRequest) -> Result<RenderedBaseBuild> {
    let paths = base_build_paths(request);
    let provision_script =
        render_base_provision_script().context("failed to render base provision script")?;

    prepare_build_workspace(
        BuildWorkspacePathsRef {
            output_path: &paths.output_path,
            packer_dir: &paths.packer_dir,
            packer_output_dir: &paths.packer_output_dir,
            packer_template_path: &paths.packer_template_path,
            packer_vars_path: &paths.packer_vars_path,
            provision_script_path: &paths.provision_script_path,
            seed_dir: &paths.seed_dir,
            seed_user_data_path: &paths.seed_user_data_path,
            seed_meta_data_path: &paths.seed_meta_data_path,
            ssh_key_path: &paths.ssh_key_path,
            ssh_public_key_path: &paths.ssh_public_key_path,
        },
        &request.config,
        &request.source,
        &request.kino.binary_path,
        VmBuildConfig {
            cpu: request.config.build_cpus,
            memory_mb: request.config.build_memory_mb,
            disk_gib: BASE_IMAGE_DISK_GIB,
            skip_compaction: true,
            disk_compression: false,
        },
        &provision_script,
        &base_instance_id(&request.base_name, &request.config.target_arch),
    )?;

    Ok(RenderedBaseBuild {
        base_name: request.base_name.clone(),
        target_arch: request.config.target_arch.clone(),
        paths,
        source: request.source.clone(),
        kino: request.kino.clone(),
    })
}

/// Reuse an existing base artifact when present, otherwise build it locally.
///
/// # Errors
/// Returns an error when the existing checksum cannot be read or the packer build fails.
pub fn ensure_base_build(request: &BaseBuildRequest) -> Result<BaseBuildArtifact> {
    if let Some(existing) = load_existing_base_artifact(&request.base_name, &request.config)? {
        return Ok(existing);
    }

    let rendered = render_base_build(request)
        .with_context(|| format!("failed to render base image '{}'", request.base_name))?;
    run_base_packer_validate(&rendered, &request.config).with_context(|| {
        format!(
            "packer validate failed for base image '{}'",
            request.base_name
        )
    })?;
    let output = run_base_packer_build(rendered, &request.config)
        .with_context(|| format!("packer build failed for base image '{}'", request.base_name))?;
    Ok(output.artifact)
}

/// Run `packer validate` for a rendered build.
///
/// # Errors
/// Returns an error if packer fails.
pub fn run_packer_validate(rendered: &RenderedBuild, config: &PackerConfig) -> Result<()> {
    run_packer_validate_paths(
        &config.binary,
        &rendered.paths.packer_dir,
        &rendered.paths.packer_template_path,
        &rendered.paths.packer_vars_path,
    )
}

/// Run `packer validate` for a rendered base build.
///
/// # Errors
/// Returns an error if packer fails.
pub fn run_base_packer_validate(rendered: &RenderedBaseBuild, config: &PackerConfig) -> Result<()> {
    run_packer_validate_paths(
        &config.binary,
        &rendered.paths.packer_dir,
        &rendered.paths.packer_template_path,
        &rendered.paths.packer_vars_path,
    )
}

/// Execute a full packer build for the rendered VM.
///
/// # Errors
/// Returns an error when packer fails or when the final artifact cannot be collected.
pub fn run_packer_build(rendered: RenderedBuild, config: &PackerConfig) -> Result<BuildOutput> {
    let sha256_hex = run_packer_build_paths(
        &config.binary,
        &rendered.paths.packer_dir,
        &rendered.paths.packer_template_path,
        &rendered.paths.packer_vars_path,
        &rendered.paths.packer_output_dir,
        &rendered.paths.output_path,
        &rendered.paths.output_checksum_path,
    )?;
    let manifest = build_manifest_json(&rendered, &sha256_hex)?;

    fs::write(
        &rendered.paths.output_metadata_path,
        serde_json::to_string_pretty(&manifest).context("failed to serialize image manifest")?,
    )
    .context("failed to write metadata manifest")?;

    Ok(BuildOutput {
        artifact: BuildArtifact {
            qcow2_path: rendered.paths.output_path.clone(),
            sha256_path: rendered.paths.output_checksum_path.clone(),
            metadata_path: rendered.paths.output_metadata_path.clone(),
            manifest,
        },
        rendered,
    })
}

/// Execute a full packer build for the rendered base image.
///
/// # Errors
/// Returns an error when packer fails or when the final artifact cannot be collected.
pub fn run_base_packer_build(
    rendered: RenderedBaseBuild,
    config: &PackerConfig,
) -> Result<BaseBuildOutput> {
    let sha256_hex = run_packer_build_paths(
        &config.binary,
        &rendered.paths.packer_dir,
        &rendered.paths.packer_template_path,
        &rendered.paths.packer_vars_path,
        &rendered.paths.packer_output_dir,
        &rendered.paths.output_path,
        &rendered.paths.output_checksum_path,
    )?;

    Ok(BaseBuildOutput {
        artifact: BaseBuildArtifact {
            qcow2_path: rendered.paths.output_path.clone(),
            sha256_path: rendered.paths.output_checksum_path.clone(),
            sha256_hex,
        },
        rendered,
    })
}

#[derive(Clone, Copy)]
struct BuildWorkspacePathsRef<'a> {
    output_path: &'a Path,
    packer_dir: &'a Path,
    packer_output_dir: &'a Path,
    packer_template_path: &'a Path,
    packer_vars_path: &'a Path,
    provision_script_path: &'a Path,
    seed_dir: &'a Path,
    seed_user_data_path: &'a Path,
    seed_meta_data_path: &'a Path,
    ssh_key_path: &'a Path,
    ssh_public_key_path: &'a Path,
}

#[derive(Clone, Copy)]
struct VmBuildConfig {
    cpu: u32,
    memory_mb: u32,
    disk_gib: u32,
    skip_compaction: bool,
    disk_compression: bool,
}

#[must_use]
pub fn base_artifact_paths(base_name: &str, config: &PackerConfig) -> BaseBuildArtifact {
    let output_file_name = format!(
        "{}-{}.qcow2",
        base_name,
        normalize_target_arch_label(&config.target_arch)
    );
    let output_path = config
        .output_root
        .join("base-images")
        .join(&output_file_name);
    let output_checksum_path = config
        .output_root
        .join("base-images")
        .join(format!("{output_file_name}.sha256"));

    BaseBuildArtifact {
        qcow2_path: output_path,
        sha256_path: output_checksum_path,
        sha256_hex: String::new(),
    }
}

/// Load a previously built base artifact when both the qcow2 and checksum exist locally.
///
/// # Errors
/// Returns an error when the checksum file exists but cannot be parsed.
pub fn load_existing_base_artifact(
    base_name: &str,
    config: &PackerConfig,
) -> Result<Option<BaseBuildArtifact>> {
    let artifact = base_artifact_paths(base_name, config);
    if !artifact.qcow2_path.is_file() || !artifact.sha256_path.is_file() {
        return Ok(None);
    }

    Ok(Some(BaseBuildArtifact {
        sha256_hex: read_checksum_file(&artifact.sha256_path)?,
        ..artifact
    }))
}

fn build_paths(request: &BuildRequest, vm: &VmDefinition) -> BuildPaths {
    let scenario_name = &request.scenario.name;
    let effective_vm_name = effective_vm_name(&vm.name, &request.config.target_arch);
    let output_file_name = format!("{scenario_name}-{effective_vm_name}.qcow2");
    let work_root = request
        .config
        .work_root
        .join("packer")
        .join(scenario_name)
        .join(&vm.name);
    let packer_output_dir = work_root.join("output");
    let seed_dir = work_root.join("seed");
    let ssh_key_path = work_root.join("id_ed25519");
    let ssh_public_key_path = work_root.join("id_ed25519.pub");

    BuildPaths {
        output_path: request.config.output_root.join(&output_file_name),
        output_checksum_path: request
            .config
            .output_root
            .join(format!("{output_file_name}.sha256")),
        output_metadata_path: request
            .config
            .output_root
            .join(format!("{output_file_name}.manifest.json")),
        work_root: work_root.clone(),
        packer_dir: work_root.clone(),
        packer_output_dir,
        packer_template_path: work_root.join("build.pkr.hcl"),
        packer_vars_path: work_root.join("build.auto.pkrvars.hcl"),
        provision_script_path: work_root.join("provision.sh"),
        seed_dir: seed_dir.clone(),
        seed_user_data_path: seed_dir.join("user-data"),
        seed_meta_data_path: seed_dir.join("meta-data"),
        ssh_key_path,
        ssh_public_key_path,
    }
}

fn base_build_paths(request: &BaseBuildRequest) -> BaseBuildPaths {
    let artifact = base_artifact_paths(&request.base_name, &request.config);
    let work_root = request
        .config
        .work_root
        .join("packer")
        .join("base-images")
        .join(&request.base_name);
    let packer_output_dir = work_root.join("output");
    let seed_dir = work_root.join("seed");
    let ssh_key_path = work_root.join("id_ed25519");
    let ssh_public_key_path = work_root.join("id_ed25519.pub");

    BaseBuildPaths {
        output_path: artifact.qcow2_path,
        output_checksum_path: artifact.sha256_path,
        work_root: work_root.clone(),
        packer_dir: work_root.clone(),
        packer_output_dir,
        packer_template_path: work_root.join("build.pkr.hcl"),
        packer_vars_path: work_root.join("build.auto.pkrvars.hcl"),
        provision_script_path: work_root.join("provision.sh"),
        seed_dir: seed_dir.clone(),
        seed_user_data_path: seed_dir.join("user-data"),
        seed_meta_data_path: seed_dir.join("meta-data"),
        ssh_key_path,
        ssh_public_key_path,
    }
}

fn effective_vm_name(vm_name: &str, target_arch: &str) -> String {
    format!("{vm_name}-{}", normalize_target_arch_label(target_arch))
}

fn scenario_instance_id(scenario_name: &str, vm_name: &str, target_arch: &str) -> String {
    format!(
        "scenario-{scenario_name}-{}",
        effective_vm_name(vm_name, target_arch)
    )
}

fn base_instance_id(base_name: &str, target_arch: &str) -> String {
    format!(
        "base-{base_name}-{}",
        normalize_target_arch_label(target_arch)
    )
}

fn normalize_target_arch_label(target_arch: &str) -> &str {
    match target_arch {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => other,
    }
}

fn image_architecture(target_arch: &str) -> Result<ImageArchitecture> {
    match target_arch {
        "amd64" | "x86_64" => Ok(ImageArchitecture::X86_64),
        "arm64" | "aarch64" => Ok(ImageArchitecture::Aarch64),
        other => bail!("unsupported target architecture '{other}'"),
    }
}

fn catalog_probe_phase(phase: intar_image_scenario::ProbePhase) -> CatalogProbePhase {
    match phase {
        intar_image_scenario::ProbePhase::Boot => CatalogProbePhase::Boot,
        intar_image_scenario::ProbePhase::Scenario => CatalogProbePhase::Scenario,
    }
}

fn build_manifest_json(rendered: &RenderedBuild, image_sha256: &str) -> Result<ScenarioManifestV1> {
    let derived = rendered
        .scenario
        .derive_kino_config_for_vm(&rendered.vm.name)
        .with_context(|| {
            format!(
                "failed to derive manifest probes for {}:{}",
                rendered.scenario_name, rendered.vm.name
            )
        })?;
    let arch = image_architecture(&rendered.target_arch)?;
    let probes = derived
        .probe_descriptors
        .into_iter()
        .map(|probe| ScenarioProbeManifestV1 {
            id: probe.id,
            phase: catalog_probe_phase(probe.phase),
            kind: probe.kind.as_str().to_string(),
            display_name: probe.label,
        })
        .collect();

    Ok(ScenarioManifestV1 {
        schema_version: 1,
        scenario_id: rendered.scenario_name.clone(),
        name: rendered.scenario_name.clone(),
        description: rendered.scenario_description.clone(),
        vms: vec![ScenarioVmManifestV1 {
            name: rendered.vm.name.clone(),
            image_key: ImageKey {
                scenario: rendered.scenario_name.clone(),
                vm: rendered.vm.name.clone(),
                arch,
            },
            image_sha256: image_sha256.to_string(),
            cpu_count: u16::try_from(rendered.vm.cpu)
                .context("vm cpu count does not fit manifest u16")?,
            memory_mib: Mib(rendered.vm.memory),
            disk_mib: Mib(rendered.vm.disk * 1024),
            probes,
        }],
    })
}

fn render_packer_vars(
    paths: BuildWorkspacePathsRef<'_>,
    config: &PackerConfig,
    source: &BuildSource,
    kino_binary_path: &Path,
    vm: VmBuildConfig,
) -> String {
    let mut output = String::new();
    let _ = writeln!(output, "source_url = {}", json_string(&source.url));
    let _ = writeln!(
        output,
        "source_checksum = {}",
        json_string(&source.checksum)
    );
    let _ = writeln!(
        output,
        "output_directory = {}",
        json_string(&absolute_path_string(paths.packer_output_dir))
    );
    let _ = writeln!(
        output,
        "ssh_username = {}",
        json_string(DEFAULT_SSH_USERNAME)
    );
    let _ = writeln!(
        output,
        "ssh_private_key_file = {}",
        json_string(&absolute_path_string(paths.ssh_key_path))
    );
    let _ = writeln!(
        output,
        "kino_binary = {}",
        json_string(&absolute_path_string(kino_binary_path))
    );
    let _ = writeln!(
        output,
        "qemu_binary = {}",
        json_string(&config.qemu_binary.to_string_lossy())
    );
    let _ = writeln!(output, "accelerator = {}", json_string(&config.accelerator));
    output.push_str("qemuargs = [\n");
    for argument_group in &config.qemuargs {
        let rendered_group = argument_group
            .iter()
            .map(|value| json_string(value))
            .collect::<Vec<_>>()
            .join(", ");
        let _ = writeln!(output, "  [{rendered_group}],");
    }
    output.push_str("]\n");
    let _ = writeln!(output, "cpus = {}", vm.cpu);
    let _ = writeln!(output, "memory = {}", vm.memory_mb);
    let _ = writeln!(output, "disk_size = {}", vm.disk_gib * 1024);
    let _ = writeln!(output, "skip_compaction = {}", vm.skip_compaction);
    let _ = writeln!(output, "disk_compression = {}", vm.disk_compression);
    let _ = writeln!(
        output,
        "provision_script = {}",
        json_string(&absolute_path_string(paths.provision_script_path))
    );
    output.push_str("cd_files = [\n");
    let _ = writeln!(
        output,
        "  {},",
        json_string(&absolute_path_string(paths.seed_user_data_path))
    );
    let _ = writeln!(
        output,
        "  {},",
        json_string(&absolute_path_string(paths.seed_meta_data_path))
    );
    output.push_str("]\n");
    output
}

fn render_seed_user_data(public_key: &str) -> String {
    format!(
        "#cloud-config\nusers:\n  - default\n  - name: {DEFAULT_SSH_USERNAME}\n    sudo: ALL=(ALL) NOPASSWD:ALL\n    groups: [sudo]\n    shell: /bin/bash\n    lock_passwd: true\n    ssh_authorized_keys:\n      - {public_key}\nssh_pwauth: false\npackage_update: false\npackage_upgrade: false\n"
    )
}

fn render_seed_meta_data(instance_id: &str) -> String {
    format!("instance-id: {instance_id}\nlocal-hostname: {instance_id}\n")
}

fn ensure_ssh_key_pair(private_key: &Path, public_key: &Path) -> Result<()> {
    if private_key.exists() && public_key.exists() {
        return Ok(());
    }

    if let Some(parent) = private_key.parent() {
        fs::create_dir_all(parent).context("failed to create SSH key directory")?;
    }

    let status = Command::new("ssh-keygen")
        .arg("-q")
        .arg("-N")
        .arg("")
        .arg("-t")
        .arg("ed25519")
        .arg("-f")
        .arg(private_key)
        .status()
        .context("failed to execute ssh-keygen")?;

    if !status.success() {
        bail!("ssh-keygen failed");
    }

    Ok(())
}

fn prepare_build_workspace(
    paths: BuildWorkspacePathsRef<'_>,
    config: &PackerConfig,
    source: &BuildSource,
    kino_binary_path: &Path,
    vm: VmBuildConfig,
    provision_script: &str,
    instance_id: &str,
) -> Result<()> {
    fs::create_dir_all(paths.packer_dir).context("failed to create packer working directory")?;
    if paths.packer_output_dir.exists() {
        fs::remove_dir_all(paths.packer_output_dir)
            .context("failed to remove stale packer output directory")?;
    }
    fs::create_dir_all(paths.seed_dir).context("failed to create seed directory")?;
    if let Some(parent) = paths.output_path.parent() {
        fs::create_dir_all(parent).context("failed to create dist directory")?;
    }

    ensure_ssh_key_pair(paths.ssh_key_path, paths.ssh_public_key_path)?;

    let public_key = fs::read_to_string(paths.ssh_public_key_path)
        .context("failed to read generated SSH public key")?;
    let user_data = render_seed_user_data(public_key.trim());
    fs::write(paths.seed_user_data_path, user_data).context("failed to write seed user-data")?;
    fs::write(
        paths.seed_meta_data_path,
        render_seed_meta_data(instance_id),
    )
    .context("failed to write seed meta-data")?;
    fs::write(paths.provision_script_path, provision_script)
        .context("failed to write provision script")?;
    fs::write(paths.packer_template_path, PACKER_TEMPLATE)
        .context("failed to write packer template")?;
    fs::write(
        paths.packer_vars_path,
        render_packer_vars(paths, config, source, kino_binary_path, vm),
    )
    .context("failed to write packer variable file")?;

    Ok(())
}

fn run_packer_command(binary: &Path, workdir: &Path, args: &[&str]) -> Result<()> {
    let status = Command::new(binary)
        .args(args)
        .current_dir(workdir)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .with_context(|| {
            format!(
                "failed to execute '{}' with args {:?}",
                binary.display(),
                args
            )
        })?;

    if status.success() {
        return Ok(());
    }

    bail!("packer command {args:?} failed with status {status}");
}

fn run_packer_validate_paths(
    binary: &Path,
    packer_dir: &Path,
    packer_template_path: &Path,
    packer_vars_path: &Path,
) -> Result<()> {
    let template_name = packer_template_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("build.pkr.hcl");
    let vars_name = packer_vars_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("build.auto.pkrvars.hcl");

    run_packer_command(binary, packer_dir, &["init", template_name])?;
    run_packer_command(
        binary,
        packer_dir,
        &["validate", "-var-file", vars_name, template_name],
    )
}

fn run_packer_build_paths(
    binary: &Path,
    packer_dir: &Path,
    packer_template_path: &Path,
    packer_vars_path: &Path,
    packer_output_dir: &Path,
    output_path: &Path,
    checksum_path: &Path,
) -> Result<String> {
    let template_name = packer_template_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("build.pkr.hcl");
    let vars_name = packer_vars_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("build.auto.pkrvars.hcl");

    run_packer_command(binary, packer_dir, &["init", template_name])?;
    run_packer_command(
        binary,
        packer_dir,
        &["build", "-force", "-var-file", vars_name, template_name],
    )?;

    let built_image = discover_built_image(packer_output_dir)?;
    move_built_qcow2(&built_image, output_path)?;

    let sha256_hex = sha256_file(output_path)?;
    fs::write(
        checksum_path,
        format!(
            "{sha256_hex}  {}\n",
            output_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("image.qcow2")
        ),
    )
    .context("failed to write checksum file")?;

    Ok(sha256_hex)
}

fn discover_built_image(output_dir: &Path) -> Result<PathBuf> {
    let mut matches = Vec::new();
    for entry in fs::read_dir(output_dir)
        .with_context(|| format!("failed to read {}", output_dir.display()))?
    {
        let entry = entry.context("failed to read packer output entry")?;
        let path = entry.path();
        if path.is_file() {
            matches.push(path);
        }
    }

    match matches.len() {
        1 => Ok(matches.remove(0)),
        0 => bail!("no qcow2 image found under {}", output_dir.display()),
        _ => bail!("multiple qcow2 images found under {}", output_dir.display()),
    }
}

fn sha256_file(path: &Path) -> Result<String> {
    for (program, args) in [("shasum", &["-a", "256"][..]), ("sha256sum", &[][..])] {
        match Command::new(program).args(args).arg(path).output() {
            Ok(output) if output.status.success() => {
                let stdout = String::from_utf8(output.stdout)
                    .with_context(|| format!("{program} emitted invalid UTF-8"))?;
                let checksum = stdout
                    .split_whitespace()
                    .next()
                    .with_context(|| format!("{program} did not return a checksum"))?;
                return Ok(checksum.to_string());
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                bail!(
                    "failed to compute SHA-256 with {program}: status {} stderr:\n{stderr}",
                    output.status
                );
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("failed to execute {program} for {}", path.display())
                });
            }
        }
    }

    bail!("no SHA-256 tool found; install `shasum` or `sha256sum`");
}

fn read_checksum_file(path: &Path) -> Result<String> {
    let contents = fs::read_to_string(path)
        .with_context(|| format!("failed to read checksum file {}", path.display()))?;
    contents
        .split_whitespace()
        .next()
        .map(ToString::to_string)
        .with_context(|| {
            format!(
                "checksum file {} did not contain a checksum",
                path.display()
            )
        })
}

fn move_built_qcow2(source: &Path, destination: &Path) -> Result<()> {
    if destination.exists() {
        fs::remove_file(destination)
            .with_context(|| format!("failed to remove existing {}", destination.display()))?;
    }

    if fs::rename(source, destination).is_ok() {
        return Ok(());
    }

    fs::copy(source, destination).with_context(|| {
        format!(
            "failed to copy built qcow2 from {} to {}",
            source.display(),
            destination.display()
        )
    })?;
    fs::remove_file(source)
        .with_context(|| format!("failed to remove intermediate qcow2 {}", source.display()))?;
    Ok(())
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

fn json_string(value: &str) -> String {
    match serde_json::to_string(value) {
        Ok(rendered) => rendered,
        Err(error) => panic!("serializing string should not fail: {error}"),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::path::PathBuf;

    use intar_contracts::catalog::{ImageArchitecture, ProbePhase, ScenarioManifestV1};
    use intar_image_scenario::Scenario;
    use tempfile::tempdir;

    use crate::config::PackerConfig;

    use super::{
        BaseBuildRequest, BuildRequest, BuildSource, KinoArtifact, base_artifact_paths,
        build_manifest_json, load_existing_base_artifact, move_built_qcow2, render_base_build,
        render_vm_build,
    };

    fn fixture_kino() -> KinoArtifact {
        let directory = tempdir().expect("tempdir should exist");
        let path = directory.keep().join("kino");
        std::fs::write(&path, "#!/bin/sh\n").expect("kino fixture should be writable");
        KinoArtifact {
            binary_path: path,
            version: String::from("0.0.0-test"),
        }
    }

    #[test]
    fn rendered_build_uses_flat_dist_output() {
        let directory = tempdir().expect("tempdir should exist");
        let scenario = Scenario::parse(
            r#"
scenario "broken-nginx" {
  category = "web"
  description = "Fix nginx"
  image "debian-12-minimal" {
    base = "trixie"
  }
  kino {
    probe "svc" {
      kind = "service"
      service = "nginx"
      state = "running"
      description = "Nginx"
    }
  }
  vm "web" {
    image = "debian-12-minimal"
    probes = ["svc"]
  }
}
"#,
        );

        let scenario = match scenario {
            Ok(scenario) => scenario,
            Err(error) => panic!("scenario should parse: {error}"),
        };
        let request = BuildRequest {
            scenario_path: PathBuf::from("scenarios/broken-nginx/scenario.hcl"),
            scenario,
            vm_name: String::from("web"),
            config: PackerConfig {
                output_root: directory.path().join("dist"),
                work_root: directory.path().join(".work"),
                ..PackerConfig::default()
            },
            source: BuildSource {
                url: String::from("/tmp/base.qcow2"),
                checksum: String::from("sha256:deadbeef"),
            },
            kino: fixture_kino(),
        };

        let rendered = render_vm_build(&request);
        match rendered {
            Ok(rendered) => {
                assert!(
                    rendered
                        .paths
                        .output_path
                        .ends_with("dist/broken-nginx-web-amd64.qcow2")
                );
                assert!(
                    rendered
                        .paths
                        .output_metadata_path
                        .ends_with("dist/broken-nginx-web-amd64.qcow2.manifest.json")
                );
            }
            Err(error) => panic!("build should render: {error}"),
        }
    }

    #[test]
    fn base_and_scenario_renders_use_distinct_cloud_init_instance_ids() {
        let directory = tempdir().expect("tempdir should exist");
        let config = PackerConfig {
            output_root: directory.path().join("dist"),
            work_root: directory.path().join(".work"),
            ..PackerConfig::default()
        };
        let scenario = Scenario::parse(
            r#"
scenario "broken-nginx" {
  category = "web"
  description = "Fix nginx"
  image "debian-12-minimal" {
    base = "trixie"
  }
  kino {
    probe "svc" {
      kind = "service"
      service = "nginx"
      state = "running"
      description = "Nginx"
    }
  }
  vm "web" {
    image = "debian-12-minimal"
    probes = ["svc"]
  }
}
"#,
        )
        .expect("scenario should parse");

        let rendered_base = render_base_build(&BaseBuildRequest {
            base_name: String::from("trixie"),
            source: BuildSource {
                url: String::from("https://example.com/base.qcow2"),
                checksum: String::from("sha256:deadbeef"),
            },
            config: config.clone(),
            kino: fixture_kino(),
        })
        .expect("base build should render");
        let rendered_scenario = render_vm_build(&BuildRequest {
            scenario_path: PathBuf::from("scenarios/broken-nginx/scenario.hcl"),
            scenario,
            vm_name: String::from("web"),
            config,
            source: BuildSource {
                url: String::from("/tmp/base.qcow2"),
                checksum: String::from("sha256:deadbeef"),
            },
            kino: fixture_kino(),
        })
        .expect("scenario build should render");

        let base_meta = std::fs::read_to_string(&rendered_base.paths.seed_meta_data_path)
            .expect("base meta-data should exist");
        let scenario_meta = std::fs::read_to_string(&rendered_scenario.paths.seed_meta_data_path)
            .expect("scenario meta-data should exist");

        assert!(base_meta.contains("instance-id: base-trixie-amd64"));
        assert!(scenario_meta.contains("instance-id: scenario-broken-nginx-web-amd64"));
        assert_ne!(base_meta, scenario_meta);
    }

    #[test]
    fn base_and_scenario_renders_use_stage_specific_packer_compression_settings() {
        let directory = tempdir().expect("tempdir should exist");
        let config = PackerConfig {
            output_root: directory.path().join("dist"),
            work_root: directory.path().join(".work"),
            ..PackerConfig::default()
        };
        let scenario = Scenario::parse(
            r#"
scenario "broken-nginx" {
  category = "web"
  description = "Fix nginx"
  image "debian-12-minimal" {
    base = "trixie"
  }
  kino {
    probe "svc" {
      kind = "service"
      service = "nginx"
      state = "running"
      description = "Nginx"
    }
  }
  vm "web" {
    image = "debian-12-minimal"
    probes = ["svc"]
  }
}
"#,
        )
        .expect("scenario should parse");

        let rendered_base = render_base_build(&BaseBuildRequest {
            base_name: String::from("trixie"),
            source: BuildSource {
                url: String::from("https://example.com/base.qcow2"),
                checksum: String::from("sha256:deadbeef"),
            },
            config: config.clone(),
            kino: fixture_kino(),
        })
        .expect("base build should render");
        let rendered_scenario = render_vm_build(&BuildRequest {
            scenario_path: PathBuf::from("scenarios/broken-nginx/scenario.hcl"),
            scenario,
            vm_name: String::from("web"),
            config,
            source: BuildSource {
                url: String::from("/tmp/base.qcow2"),
                checksum: String::from("sha256:deadbeef"),
            },
            kino: fixture_kino(),
        })
        .expect("scenario build should render");

        let base_vars = std::fs::read_to_string(&rendered_base.paths.packer_vars_path)
            .expect("base vars should exist");
        let scenario_vars = std::fs::read_to_string(&rendered_scenario.paths.packer_vars_path)
            .expect("scenario vars should exist");

        assert!(base_vars.contains("skip_compaction = true"));
        assert!(base_vars.contains("disk_compression = false"));
        assert!(scenario_vars.contains("skip_compaction = false"));
        assert!(scenario_vars.contains("disk_compression = true"));
    }

    #[test]
    fn move_built_qcow2_preserves_original_artifact_bytes() {
        let directory = tempdir().expect("tempdir should exist");
        let source = directory.path().join("source.qcow2");
        let destination = directory.path().join("destination.qcow2");
        std::fs::write(&source, "raw-qcow2-bytes").expect("source image should be creatable");

        move_built_qcow2(&source, &destination).expect("image should move");

        assert!(!source.exists());
        assert_eq!(
            std::fs::read_to_string(&destination).expect("destination should exist"),
            "raw-qcow2-bytes"
        );
    }

    #[test]
    fn loads_existing_base_artifact_from_cached_files() {
        let directory = tempdir().expect("tempdir should exist");
        let config = PackerConfig {
            output_root: directory.path().join("dist"),
            ..PackerConfig::default()
        };
        let artifact = base_artifact_paths("trixie", &config);

        std::fs::create_dir_all(
            artifact
                .qcow2_path
                .parent()
                .expect("base image parent should exist"),
        )
        .expect("base image directory should be creatable");
        std::fs::write(&artifact.qcow2_path, "base image").expect("base image should be creatable");
        std::fs::write(&artifact.sha256_path, "deadbeef  trixie-amd64.qcow2\n")
            .expect("checksum file should be creatable");

        let loaded = load_existing_base_artifact("trixie", &config)
            .expect("cached artifact should load")
            .expect("cached artifact should exist");
        assert_eq!(loaded.sha256_hex, "deadbeef");
        assert_eq!(loaded.qcow2_path, artifact.qcow2_path);
    }

    #[test]
    fn catalog_manifest_uses_contract_shape() {
        let directory = tempdir().expect("tempdir should exist");
        let scenario = Scenario::parse(
            r#"
scenario "broken-nginx" {
  category = "web"
  description = "Fix nginx"
  image "debian-12-minimal" {
    base = "trixie"
  }
  kino {
    probe "svc" {
      kind = "service"
      service = "nginx"
      state = "running"
      phase = "boot"
      description = "Nginx"
    }
  }
  vm "web" {
    image = "debian-12-minimal"
    cpu = 2
    memory = 2048
    disk = 4
    probes = ["svc"]
  }
}
"#,
        )
        .expect("scenario should parse");
        let rendered = render_vm_build(&BuildRequest {
            scenario_path: PathBuf::from("scenarios/broken-nginx/scenario.hcl"),
            scenario,
            vm_name: String::from("web"),
            config: PackerConfig {
                output_root: directory.path().join("dist"),
                work_root: directory.path().join(".work"),
                ..PackerConfig::default()
            },
            source: BuildSource {
                url: String::from("/tmp/base.qcow2"),
                checksum: String::from("sha256:deadbeef"),
            },
            kino: fixture_kino(),
        })
        .expect("build should render");

        let manifest = build_manifest_json(&rendered, "abc123").expect("manifest should build");
        let serialized =
            serde_json::to_value(&manifest).expect("manifest should serialize as JSON");
        assert!(matches!(
            manifest,
            ScenarioManifestV1 {
                schema_version: 1,
                ..
            }
        ));
        assert_eq!(serialized["scenario_id"], "broken-nginx");
        assert_eq!(serialized["vms"][0]["image_sha256"], "abc123");
        assert_eq!(manifest.vms[0].image_key.arch, ImageArchitecture::X86_64);
        assert_eq!(manifest.vms[0].memory_mib.0, 2048);
        assert_eq!(manifest.vms[0].disk_mib.0, 4096);
        assert_eq!(manifest.vms[0].probes[0].phase, ProbePhase::Boot);
    }
}
