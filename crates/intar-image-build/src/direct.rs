use std::fs;
use std::io::Write as _;
use std::net::TcpListener;
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result, bail};
use intar_contracts::catalog::ScenarioManifestV2;
use intar_image_scenario::{BaseImageSpec, Scenario, VmDefinition};
use russh::keys::PrivateKey;

use crate::artifact::{RawZstdArtifact, sha256_file_hex, write_raw_zstd_artifact};
use crate::config::QemuBuildConfig;
use crate::disk::{ScenarioDiskPlan, prepare_scenario_disk, render_scenario_disk_plan};
use crate::kino::KinoArtifact;
use crate::manifest::build_direct_manifest_json;
use crate::provision::render_scenario_provision_script;
use crate::qemu::{DirectBootQemuInput, render_direct_boot_qemu_command, uses_tcg_accelerator};
use crate::rootfs::{RootfsBuildPlan, ensure_base_rootfs, render_rootfs_build_plan};
use crate::seed::{BuildSeedInput, write_build_seed};
use crate::ssh::{BuildSshSession, generate_build_ssh_key};

const SSH_USERNAME: &str = "ubuntu";
const SSH_HOST: &str = "127.0.0.1";
const SSH_POLL_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Debug, Clone)]
pub struct DirectBuildRequest {
    pub scenario_path: PathBuf,
    pub scenario: Scenario,
    pub vm_name: String,
    pub config: QemuBuildConfig,
    pub base_image: BaseImageSpec,
    pub kino: KinoArtifact,
}

#[derive(Debug, Clone)]
pub struct DirectBuildPaths {
    pub output_image_path: PathBuf,
    pub output_checksum_path: PathBuf,
    pub output_metadata_path: PathBuf,
    pub work_root: PathBuf,
    pub root_disk_path: PathBuf,
    pub seed_disk_path: PathBuf,
    pub provision_script_path: PathBuf,
    pub disk_commands_path: PathBuf,
    pub qemu_args_path: PathBuf,
    pub build_log_path: PathBuf,
    pub serial_log_path: PathBuf,
    pub qmp_socket_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct RenderedDirectBuild {
    pub scenario: Scenario,
    pub scenario_name: String,
    pub scenario_description: String,
    pub target_arch: String,
    pub config: QemuBuildConfig,
    pub effective_vm_name: String,
    pub ssh_host_port: u16,
    pub paths: DirectBuildPaths,
    pub vm: VmDefinition,
    pub base_image: BaseImageSpec,
    pub base_rootfs: RootfsBuildPlan,
    pub disk: ScenarioDiskPlan,
    pub kino: KinoArtifact,
    pub qemu_args: Vec<String>,
}

pub struct DirectBuildPrepareInput<'a> {
    pub rendered: &'a RenderedDirectBuild,
    pub build_public_key_openssh: &'a str,
}

#[derive(Debug, Clone)]
pub struct DirectBuildOutput {
    pub rendered: RenderedDirectBuild,
    pub artifact: DirectBuildArtifact,
}

#[derive(Debug, Clone)]
pub struct DirectBuildArtifact {
    pub raw_path: PathBuf,
    pub raw_zstd_path: PathBuf,
    pub sha256_path: PathBuf,
    pub metadata_path: PathBuf,
    pub image_sha256_hex: String,
    pub kernel_sha256_hex: String,
    pub initrd_sha256_hex: String,
    pub manifest: ScenarioManifestV2,
}

/// Render direct-QEMU build inputs without executing QEMU.
///
/// # Errors
/// Returns an error when the scenario is invalid or build inputs cannot be written.
pub fn render_direct_build(request: &DirectBuildRequest) -> Result<RenderedDirectBuild> {
    request
        .scenario
        .validate_for_builder_arch(&request.config.target_arch)?;
    request
        .base_image
        .definition_for_arch(&request.config.target_arch)
        .with_context(|| {
            format!(
                "base image '{}' has no {} definition",
                request.base_image.name, request.config.target_arch
            )
        })?;

    let vm = request
        .scenario
        .vm_by_name(&request.vm_name)
        .cloned()
        .with_context(|| format!("vm '{}' not found", request.vm_name))?;

    let paths = direct_build_paths(request, &vm);
    let base_rootfs = render_rootfs_build_plan(&request.base_image, &request.config);
    let disk = render_scenario_disk_plan(
        &base_rootfs.paths.base_ext4_path,
        &paths.root_disk_path,
        vm.disk,
        &request.config,
    );
    let provision_script = render_scenario_provision_script(&request.scenario, &vm)
        .context("failed to render direct provision script")?;

    fs::create_dir_all(&paths.work_root)
        .with_context(|| format!("failed to create '{}'", paths.work_root.display()))?;
    if let Some(parent) = paths.output_image_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create '{}'", parent.display()))?;
    }
    fs::write(&paths.provision_script_path, provision_script).with_context(|| {
        format!(
            "failed to write provision script '{}'",
            paths.provision_script_path.display()
        )
    })?;
    fs::write(&paths.disk_commands_path, render_disk_commands(&disk)).with_context(|| {
        format!(
            "failed to write disk commands '{}'",
            paths.disk_commands_path.display()
        )
    })?;

    let ssh_host_port = allocate_ssh_host_port()?;
    let qemu_command = render_direct_boot_qemu_command(&DirectBootQemuInput {
        config: &request.config,
        root_disk_path: &paths.root_disk_path,
        seed_disk_path: &paths.seed_disk_path,
        kernel_path: &base_rootfs.paths.kernel_path,
        initrd_path: &base_rootfs.paths.initrd_path,
        serial_log_path: &paths.serial_log_path,
        qmp_socket_path: &paths.qmp_socket_path,
        ssh_host_port,
        memory_mib: request.config.build_memory_mb,
        cpu_count: request.config.build_cpus,
    });
    let qemu_args = qemu_command.args;
    fs::write(&paths.qemu_args_path, qemu_args.join("\n")).with_context(|| {
        format!(
            "failed to write qemu args '{}'",
            paths.qemu_args_path.display()
        )
    })?;

    let effective_vm_name = effective_vm_name(&vm.name, &request.config.target_arch);
    Ok(RenderedDirectBuild {
        scenario: request.scenario.clone(),
        scenario_name: request.scenario.name.clone(),
        scenario_description: request.scenario.description.clone(),
        target_arch: request.config.target_arch.clone(),
        config: request.config.clone(),
        effective_vm_name,
        ssh_host_port,
        paths,
        vm,
        base_image: request.base_image.clone(),
        base_rootfs,
        disk,
        kino: request.kino.clone(),
        qemu_args,
    })
}

/// Prepare the raw root disk and INTARBUILD seed for a rendered direct build.
///
/// # Errors
/// Returns an error if disk preparation or seed writing fails.
pub fn prepare_direct_build_inputs(input: &DirectBuildPrepareInput<'_>) -> Result<()> {
    prepare_scenario_disk(&input.rendered.disk)?;
    write_build_seed(&BuildSeedInput {
        path: &input.rendered.paths.seed_disk_path,
        ssh_authorized_keys_openssh: &[input.build_public_key_openssh.to_string()],
        guest_ip_cidr: "10.0.2.15/24",
        gateway: "10.0.2.2",
        dns: "10.0.2.3",
        iface: None,
    })?;
    Ok(())
}

/// Execute a full direct QEMU build for one VM.
///
/// # Errors
/// Returns an error if base rootfs generation, QEMU startup, SSH provisioning,
/// artifact compression, or manifest generation fails.
pub fn run_direct_build(request: &DirectBuildRequest) -> Result<DirectBuildOutput> {
    let rendered = render_direct_build(request).with_context(|| {
        format!(
            "failed to render direct build {}:{}",
            request.scenario.name, request.vm_name
        )
    })?;
    ensure_base_rootfs(&rendered.base_image, &rendered.config).with_context(|| {
        format!(
            "failed to prepare base rootfs '{}' for {}",
            rendered.base_image.name, rendered.target_arch
        )
    })?;

    let ssh_key = generate_build_ssh_key().context("failed to generate direct build SSH key")?;
    prepare_direct_build_inputs(&DirectBuildPrepareInput {
        rendered: &rendered,
        build_public_key_openssh: &ssh_key.public_key_openssh,
    })?;

    let mut qemu = spawn_qemu(&rendered)?;
    if let Err(error) = provision_guest(&rendered, &mut qemu, &ssh_key.private_key) {
        terminate_qemu(&mut qemu);
        return Err(error);
    }
    wait_for_qemu_shutdown(&mut qemu, &rendered)?;

    let raw_artifact = write_raw_zstd_artifact(
        &rendered.paths.root_disk_path,
        &rendered.paths.output_image_path,
        &rendered.paths.output_checksum_path,
    )?;
    let artifact = direct_artifact_from_raw(&rendered, raw_artifact)?;
    Ok(DirectBuildOutput { rendered, artifact })
}

fn direct_build_paths(request: &DirectBuildRequest, vm: &VmDefinition) -> DirectBuildPaths {
    let scenario_name = &request.scenario.name;
    let effective_vm_name = effective_vm_name(&vm.name, &request.config.target_arch);
    let output_file_name = format!("{scenario_name}-{effective_vm_name}.raw.zst");
    let work_root = request
        .config
        .work_root
        .join("qemu")
        .join(scenario_name)
        .join(&vm.name);

    DirectBuildPaths {
        output_image_path: request.config.output_root.join(&output_file_name),
        output_checksum_path: request
            .config
            .output_root
            .join(format!("{output_file_name}.sha256")),
        output_metadata_path: request
            .config
            .output_root
            .join(format!("{output_file_name}.manifest.json")),
        root_disk_path: work_root.join("root.raw"),
        seed_disk_path: work_root.join("intarbuild.img"),
        provision_script_path: work_root.join("provision.sh"),
        disk_commands_path: work_root.join("disk.commands"),
        qemu_args_path: work_root.join("qemu.args"),
        build_log_path: work_root.join("build.log"),
        serial_log_path: work_root.join("serial.log"),
        qmp_socket_path: work_root.join("qmp.sock"),
        work_root,
    }
}

fn allocate_ssh_host_port() -> Result<u16> {
    let listener = TcpListener::bind((SSH_HOST, 0))
        .with_context(|| format!("failed to allocate build SSH host port on {SSH_HOST}"))?;
    let port = listener
        .local_addr()
        .context("failed to read allocated build SSH host port")?
        .port();
    drop(listener);
    Ok(port)
}

fn spawn_qemu(rendered: &RenderedDirectBuild) -> Result<Child> {
    if uses_tcg_accelerator(&rendered.config.accelerator) {
        eprintln!(
            "WARNING: direct image build is using QEMU TCG acceleration; Linux/KVM proof requires accelerator = \"kvm\" and /dev/kvm access"
        );
    }

    if let Some(parent) = rendered.paths.serial_log_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create '{}'", parent.display()))?;
    }
    if rendered.paths.qmp_socket_path.exists() {
        fs::remove_file(&rendered.paths.qmp_socket_path).with_context(|| {
            format!(
                "failed to remove stale QMP socket '{}'",
                rendered.paths.qmp_socket_path.display()
            )
        })?;
    }

    Command::new(&rendered.config.qemu_binary)
        .args(&rendered.qemu_args)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .with_context(|| {
            format!(
                "failed to start QEMU '{}'",
                rendered.config.qemu_binary.display()
            )
        })
}

fn provision_guest(
    rendered: &RenderedDirectBuild,
    qemu: &mut Child,
    private_key: &PrivateKey,
) -> Result<()> {
    if let Some(parent) = rendered.paths.build_log_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create '{}'", parent.display()))?;
    }
    fs::write(
        &rendered.paths.build_log_path,
        format!(
            "== {}:{} provision log ==\n",
            rendered.scenario_name, rendered.vm.name
        ),
    )
    .with_context(|| {
        format!(
            "failed to initialize build log '{}'",
            rendered.paths.build_log_path.display()
        )
    })?;

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("failed to create build SSH runtime")?;
    let mut ssh = wait_for_ssh(rendered, qemu, private_key, &runtime)?;
    let provision_timeout_seconds = rendered.config.provision_timeout_seconds.max(1);
    let provision_result = runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(provision_timeout_seconds), async {
            ssh.upload_file(&rendered.kino.binary_path, "/tmp/kino", 0o755)
                .await
                .context("failed to upload kino binary")?;
            ssh.upload_file(
                &rendered.paths.provision_script_path,
                "/tmp/intar-provision.sh",
                0o755,
            )
            .await
            .context("failed to upload provision script")?;
            ssh.run_logged(
                "sudo bash /tmp/intar-provision.sh && sudo shutdown -P now",
                true,
                &rendered.paths.build_log_path,
            )
            .await
            .context("direct scenario provisioning failed")
        })
        .await
    });
    match provision_result {
        Ok(result) => result,
        Err(_) => bail!(
            "direct scenario provisioning timed out after {provision_timeout_seconds}s; build log: {}; serial log: {}",
            rendered.paths.build_log_path.display(),
            rendered.paths.serial_log_path.display()
        ),
    }
}

fn wait_for_ssh(
    rendered: &RenderedDirectBuild,
    qemu: &mut Child,
    private_key: &PrivateKey,
    runtime: &tokio::runtime::Runtime,
) -> Result<BuildSshSession> {
    let deadline =
        Instant::now() + Duration::from_secs(rendered.config.ssh_wait_timeout_seconds.max(1));
    let mut last_error = None;
    while Instant::now() < deadline {
        if let Some(status) = qemu
            .try_wait()
            .context("failed to poll QEMU while waiting for SSH")?
        {
            bail!(
                "QEMU exited before SSH became ready with status {status}; serial log: {}; build log: {}",
                rendered.paths.serial_log_path.display(),
                rendered.paths.build_log_path.display()
            );
        }

        match runtime.block_on(BuildSshSession::connect(
            SSH_HOST,
            rendered.ssh_host_port,
            SSH_USERNAME,
            private_key,
        )) {
            Ok(mut ssh) => match runtime.block_on(ssh.run("true", false)) {
                Ok(()) => return Ok(ssh),
                Err(error) => last_error = Some(error),
            },
            Err(error) => last_error = Some(error),
        }
        thread::sleep(SSH_POLL_INTERVAL);
    }

    if let Some(error) = last_error {
        bail!(
            "timed out waiting for build SSH on {SSH_HOST}:{}: {error:#}; serial log: {}; build log: {}",
            rendered.ssh_host_port,
            rendered.paths.serial_log_path.display(),
            rendered.paths.build_log_path.display()
        );
    }
    bail!(
        "timed out waiting for build SSH on {SSH_HOST}:{}; serial log: {}; build log: {}",
        rendered.ssh_host_port,
        rendered.paths.serial_log_path.display(),
        rendered.paths.build_log_path.display()
    )
}

fn wait_for_qemu_shutdown(qemu: &mut Child, rendered: &RenderedDirectBuild) -> Result<()> {
    if let Some(status) = qemu
        .try_wait()
        .with_context(|| format!("failed to poll QEMU pid {}", qemu.id()))?
    {
        return qemu_status_to_result(status, rendered);
    }

    let qmp_error = request_qemu_powerdown(rendered).err();
    let qemu_exit_timeout_seconds = rendered.config.qemu_exit_timeout_seconds.max(1);
    let deadline = Instant::now() + Duration::from_secs(qemu_exit_timeout_seconds);
    while Instant::now() < deadline {
        if let Some(status) = qemu
            .try_wait()
            .with_context(|| format!("failed to poll QEMU pid {}", qemu.id()))?
        {
            return qemu_status_to_result(status, rendered);
        }
        thread::sleep(SSH_POLL_INTERVAL);
    }

    terminate_qemu(qemu);
    let qmp_note = qmp_error
        .as_ref()
        .map(|error| format!("; QMP powerdown failed: {error:#}"))
        .unwrap_or_default();
    bail!(
        "timed out waiting {qemu_exit_timeout_seconds}s for QEMU to exit after provisioning; killed QEMU; serial log: {}; build log: {}{qmp_note}",
        rendered.paths.serial_log_path.display(),
        rendered.paths.build_log_path.display()
    )
}

fn qemu_status_to_result(status: ExitStatus, rendered: &RenderedDirectBuild) -> Result<()> {
    if status.success() {
        return Ok(());
    }
    bail!(
        "QEMU exited with status {status}; serial log: {}; build log: {}",
        rendered.paths.serial_log_path.display(),
        rendered.paths.build_log_path.display()
    )
}

#[cfg(unix)]
fn request_qemu_powerdown(rendered: &RenderedDirectBuild) -> Result<()> {
    let mut stream = UnixStream::connect(&rendered.paths.qmp_socket_path).with_context(|| {
        format!(
            "failed to connect to QMP socket '{}'",
            rendered.paths.qmp_socket_path.display()
        )
    })?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .context("failed to set QMP write timeout")?;
    stream
        .write_all(br#"{"execute":"qmp_capabilities"}"#)
        .context("failed to send QMP capabilities command")?;
    stream
        .write_all(b"\n")
        .context("failed to terminate QMP capabilities command")?;
    stream
        .write_all(br#"{"execute":"system_powerdown"}"#)
        .context("failed to send QMP powerdown command")?;
    stream
        .write_all(b"\n")
        .context("failed to terminate QMP powerdown command")?;
    Ok(())
}

#[cfg(not(unix))]
fn request_qemu_powerdown(_rendered: &RenderedDirectBuild) -> Result<()> {
    bail!("QMP powerdown over Unix sockets is not available on this platform")
}

fn terminate_qemu(qemu: &mut Child) {
    if matches!(qemu.try_wait(), Ok(Some(_))) {
        return;
    }
    let _ = qemu.kill();
    let _ = qemu.wait();
}

fn direct_artifact_from_raw(
    rendered: &RenderedDirectBuild,
    raw_artifact: RawZstdArtifact,
) -> Result<DirectBuildArtifact> {
    let kernel_sha256_hex = sha256_file_hex(&rendered.base_rootfs.paths.kernel_path)?;
    let initrd_sha256_hex = sha256_file_hex(&rendered.base_rootfs.paths.initrd_path)?;
    let manifest = build_direct_manifest_json(
        rendered,
        &raw_artifact.sha256_hex,
        &kernel_sha256_hex,
        &initrd_sha256_hex,
    )?;
    fs::write(
        &rendered.paths.output_metadata_path,
        serde_json::to_string_pretty(&manifest).context("failed to serialize image manifest")?,
    )
    .with_context(|| {
        format!(
            "failed to write metadata manifest '{}'",
            rendered.paths.output_metadata_path.display()
        )
    })?;

    Ok(DirectBuildArtifact {
        raw_path: raw_artifact.raw_path,
        raw_zstd_path: raw_artifact.compressed_path,
        sha256_path: raw_artifact.sha256_path,
        metadata_path: rendered.paths.output_metadata_path.clone(),
        image_sha256_hex: raw_artifact.sha256_hex,
        kernel_sha256_hex,
        initrd_sha256_hex,
        manifest,
    })
}

fn render_disk_commands(disk: &ScenarioDiskPlan) -> String {
    let mut rendered = format!(
        "copy {} {}\ntruncate {} {}\n",
        disk.base_ext4_path.display(),
        disk.root_disk_path.display(),
        disk.root_disk_path.display(),
        disk.virtual_size_bytes
    );
    for command in &disk.commands {
        rendered.push_str(&command.program.display().to_string());
        for arg in &command.args {
            rendered.push(' ');
            rendered.push_str(arg);
        }
        rendered.push('\n');
    }
    rendered
}

fn effective_vm_name(vm_name: &str, target_arch: &str) -> String {
    format!("{vm_name}-{}", normalize_target_arch_label(target_arch))
}

fn normalize_target_arch_label(target_arch: &str) -> &str {
    match target_arch {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use tempfile::tempdir;

    use super::{
        DirectBuildPrepareInput, DirectBuildRequest, prepare_direct_build_inputs,
        render_direct_build,
    };
    use crate::config::QemuBuildConfig;
    use crate::kino::KinoArtifact;

    #[test]
    fn direct_render_uses_raw_zstd_outputs_and_direct_boot_args() {
        let directory = tempdir().unwrap();
        let scenario = intar_image_scenario::Scenario::parse(
            r#"
scenario "broken-nginx" {
  title = "Broken Nginx"
  category = "web"
  tags = ["nginx"]
  difficulty = "easy"
  estimated_minutes = 15
  description = "Fix nginx"
  briefing = "Restore nginx service availability."
  solution { body = "Start nginx." }

  image "debian-13-minimal" {
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
    image = "debian-13-minimal"
    probes = ["svc"]
  }
}
"#,
        )
        .unwrap();
        let catalog = intar_image_scenario::BaseImageCatalog::parse(
            r#"
base_image "trixie" {
  suite          = "trixie"
  mirror         = "https://deb.debian.org/debian"
  arch           = "amd64"
  kernel_package = "linux-image-cloud-amd64"
  packages       = ["openssh-server", "ca-certificates", "sudo", "zstd"]
}
"#,
        )
        .unwrap();
        let base_image = catalog.base_image_by_name("trixie").unwrap().clone();
        let rendered = render_direct_build(&DirectBuildRequest {
            scenario_path: "scenarios/broken-nginx/scenario.hcl".into(),
            scenario,
            vm_name: "web".to_string(),
            config: QemuBuildConfig {
                output_root: directory.path().join("dist"),
                work_root: directory.path().join(".work"),
                ..QemuBuildConfig::default()
            },
            base_image,
            kino: KinoArtifact {
                binary_path: "/tmp/kino".into(),
                version: "0.1.24".to_string(),
            },
        })
        .unwrap();

        assert!(
            rendered
                .paths
                .output_image_path
                .ends_with("dist/broken-nginx-web-amd64.raw.zst")
        );
        assert!(
            rendered
                .paths
                .output_metadata_path
                .ends_with("dist/broken-nginx-web-amd64.raw.zst.manifest.json")
        );
        assert!(
            rendered
                .paths
                .root_disk_path
                .ends_with(".work/qemu/broken-nginx/web/root.raw")
        );
        assert!(
            rendered
                .paths
                .build_log_path
                .ends_with(".work/qemu/broken-nginx/web/build.log")
        );
        assert!(
            rendered
                .paths
                .seed_disk_path
                .ends_with(".work/qemu/broken-nginx/web/intarbuild.img")
        );
        assert!(rendered.paths.provision_script_path.is_file());
        assert!(rendered.paths.disk_commands_path.is_file());
        assert!(rendered.paths.qemu_args_path.is_file());
        assert_eq!(rendered.disk.root_disk_path, rendered.paths.root_disk_path);
        assert_eq!(
            rendered.disk.base_ext4_path,
            rendered.base_rootfs.paths.base_ext4_path
        );
        assert_eq!(rendered.disk.virtual_size_bytes, 10 * 1024 * 1024 * 1024);
        assert!(rendered.ssh_host_port > 0);
        assert!(rendered.qemu_args.iter().any(|arg| arg == "-kernel"));
        assert!(
            rendered
                .qemu_args
                .iter()
                .any(|arg| arg.contains("if=virtio,format=raw"))
        );
        assert!(rendered.qemu_args.iter().any(|arg| {
            arg == &format!(
                "user,id=net0,hostfwd=tcp:127.0.0.1:{}-:22",
                rendered.ssh_host_port
            )
        }));
        assert!(!rendered.paths.work_root.join("build.pkr.hcl").exists());
    }

    #[test]
    fn direct_prepare_writes_root_disk_and_intarbuild_seed() {
        let directory = tempdir().unwrap();
        let true_binary = std::path::PathBuf::from("/usr/bin/true");
        let scenario = intar_image_scenario::Scenario::parse(
            r#"
scenario "broken-nginx" {
  title = "Broken Nginx"
  category = "web"
  tags = ["nginx"]
  difficulty = "easy"
  estimated_minutes = 15
  description = "Fix nginx"
  briefing = "Restore nginx service availability."
  solution { body = "Start nginx." }

  image "debian-13-minimal" {
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
    image = "debian-13-minimal"
    probes = ["svc"]
    disk = 1
  }
}
"#,
        )
        .unwrap();
        let catalog = intar_image_scenario::BaseImageCatalog::parse(
            r#"
base_image "trixie" {
  suite          = "trixie"
  mirror         = "https://deb.debian.org/debian"
  arch           = "amd64"
  kernel_package = "linux-image-cloud-amd64"
  packages       = ["openssh-server", "ca-certificates", "sudo", "zstd"]
}
"#,
        )
        .unwrap();
        let rendered = render_direct_build(&DirectBuildRequest {
            scenario_path: "scenarios/broken-nginx/scenario.hcl".into(),
            scenario,
            vm_name: "web".to_string(),
            config: QemuBuildConfig {
                output_root: directory.path().join("dist"),
                work_root: directory.path().join(".work"),
                e2fsck_binary: true_binary.clone(),
                resize2fs_binary: true_binary,
                ..QemuBuildConfig::default()
            },
            base_image: catalog.base_image_by_name("trixie").unwrap().clone(),
            kino: KinoArtifact {
                binary_path: "/tmp/kino".into(),
                version: "0.1.24".to_string(),
            },
        })
        .unwrap();
        std::fs::create_dir_all(rendered.disk.base_ext4_path.parent().unwrap()).unwrap();
        std::fs::write(&rendered.disk.base_ext4_path, "base").unwrap();

        prepare_direct_build_inputs(&DirectBuildPrepareInput {
            rendered: &rendered,
            build_public_key_openssh: "ssh-ed25519 AAAATEST intar-build",
        })
        .unwrap();

        assert!(rendered.paths.root_disk_path.is_file());
        assert_eq!(
            std::fs::metadata(&rendered.paths.root_disk_path)
                .unwrap()
                .len(),
            1024 * 1024 * 1024
        );
        assert!(rendered.paths.seed_disk_path.is_file());
    }
}
