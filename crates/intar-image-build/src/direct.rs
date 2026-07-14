use std::fs;
#[cfg(unix)]
use std::io::{BufRead as _, BufReader, ErrorKind, Read as _, Write as _};
use std::net::TcpListener;
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context as _, Error, Result, anyhow, bail};
use intar_contracts::catalog::ScenarioManifestV3;
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
const DIRECT_PROVISION_COMMAND: &str = "sudo bash /tmp/intar-provision.sh";
// A build guest can briefly expose port 22 before its ephemeral key and
// network setup have settled. Avoid hammering OpenSSH's unauthenticated
// connection limits while retaining responsive readiness detection.
const SSH_POLL_INTERVAL: Duration = Duration::from_secs(2);
const QEMU_EXIT_POLL_INTERVAL: Duration = Duration::from_millis(100);
#[cfg(unix)]
const QMP_IO_TIMEOUT: Duration = Duration::from_secs(2);
#[cfg(unix)]
const QMP_READ_POLL_INTERVAL: Duration = Duration::from_millis(100);

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
    pub manifest: ScenarioManifestV3,
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
        return Err(qemu_failure_after_cleanup(&mut qemu, error));
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
            // Provisioning must report success independently. The host requests
            // poweroff over QMP only after this command returns status zero.
            ssh.run_logged(
                DIRECT_PROVISION_COMMAND,
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
    if let Some(status) = poll_qemu_or_cleanup(qemu)? {
        bail!(
            "QEMU exited with status {status} before the host requested acknowledged QMP powerdown; serial log: {}; build log: {}",
            rendered.paths.serial_log_path.display(),
            rendered.paths.build_log_path.display()
        );
    }

    let qemu_exit_timeout_seconds = rendered.config.qemu_exit_timeout_seconds.max(1);
    let deadline = Instant::now() + Duration::from_secs(qemu_exit_timeout_seconds);
    if let Err(error) = request_qemu_powerdown(rendered, deadline) {
        return Err(qemu_failure_after_cleanup(
            qemu,
            anyhow!(
                "failed to complete QMP guest powerdown handshake after provisioning; serial log: {}; build log: {}: {error:#}",
                rendered.paths.serial_log_path.display(),
                rendered.paths.build_log_path.display()
            ),
        ));
    }
    while Instant::now() < deadline {
        if let Some(status) = poll_qemu_or_cleanup(qemu)? {
            return qemu_status_to_result(status, rendered);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        thread::sleep(QEMU_EXIT_POLL_INTERVAL.min(remaining));
    }

    if let Some(status) = poll_qemu_or_cleanup(qemu)? {
        return qemu_status_to_result(status, rendered);
    }

    Err(qemu_failure_after_cleanup(
        qemu,
        anyhow!(
            "timed out waiting {qemu_exit_timeout_seconds}s for QEMU to exit after a guest-originated QMP shutdown event; serial log: {}; build log: {}",
            rendered.paths.serial_log_path.display(),
            rendered.paths.build_log_path.display(),
        ),
    ))
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
fn request_qemu_powerdown(
    rendered: &RenderedDirectBuild,
    shutdown_deadline: Instant,
) -> Result<()> {
    let mut stream = UnixStream::connect(&rendered.paths.qmp_socket_path).with_context(|| {
        format!(
            "failed to connect to QMP socket '{}'",
            rendered.paths.qmp_socket_path.display()
        )
    })?;
    stream
        .set_read_timeout(Some(QMP_READ_POLL_INTERVAL))
        .context("failed to set QMP read timeout")?;
    stream
        .set_write_timeout(Some(QMP_IO_TIMEOUT))
        .context("failed to set QMP write timeout")?;
    let handshake_deadline = (Instant::now() + QMP_IO_TIMEOUT).min(shutdown_deadline);
    let reader_stream = stream
        .try_clone()
        .context("failed to clone QMP socket for response reads")?;
    let mut reader = BufReader::new(reader_stream);

    let greeting = read_qmp_message(&mut reader, "greeting", handshake_deadline)?;
    if !greeting
        .get("QMP")
        .is_some_and(serde_json::Value::is_object)
    {
        bail!("QMP socket returned an invalid greeting: {greeting}");
    }
    if execute_qmp_command(
        &mut stream,
        &mut reader,
        "qmp_capabilities",
        handshake_deadline,
    )? {
        bail!("QMP reported shutdown before the host requested system_powerdown");
    }
    if execute_qmp_command(
        &mut stream,
        &mut reader,
        "system_powerdown",
        handshake_deadline,
    )? {
        bail!("QMP reported shutdown before acknowledging system_powerdown");
    }
    wait_for_guest_shutdown_event(&mut reader, shutdown_deadline)
}

#[cfg(unix)]
fn execute_qmp_command(
    stream: &mut UnixStream,
    reader: &mut BufReader<UnixStream>,
    command: &str,
    deadline: Instant,
) -> Result<bool> {
    stream
        .set_write_timeout(Some(qmp_remaining(deadline, command)?))
        .with_context(|| format!("failed to set QMP {command} write timeout"))?;
    serde_json::to_writer(
        &mut *stream,
        &serde_json::json!({ "execute": command, "id": command }),
    )
    .with_context(|| format!("failed to encode QMP {command} command"))?;
    stream
        .write_all(b"\n")
        .with_context(|| format!("failed to terminate QMP {command} command"))?;
    stream
        .flush()
        .with_context(|| format!("failed to flush QMP {command} command"))?;

    let mut saw_shutdown = false;
    loop {
        let response = read_qmp_message(reader, command, deadline)?;
        if response.get("event").is_some() {
            saw_shutdown |= is_qmp_shutdown_event(&response);
            continue;
        }
        if response.get("id").and_then(serde_json::Value::as_str) != Some(command) {
            bail!("QMP {command} returned a response with a missing or mismatched id: {response}");
        }
        if let Some(error) = response.get("error") {
            bail!("QMP {command} command failed: {error}");
        }
        if response.get("return").is_some() {
            return Ok(saw_shutdown);
        }
        bail!("QMP {command} returned an unexpected response: {response}");
    }
}

#[cfg(unix)]
fn wait_for_guest_shutdown_event(
    reader: &mut BufReader<UnixStream>,
    deadline: Instant,
) -> Result<()> {
    loop {
        let message = read_qmp_message(reader, "guest SHUTDOWN event", deadline)?;
        if validate_guest_shutdown_event(&message)? {
            return Ok(());
        }
        if message.get("event").is_none() {
            bail!(
                "QMP returned an unexpected response while waiting for guest shutdown: {message}"
            );
        }
    }
}

#[cfg(unix)]
fn validate_guest_shutdown_event(message: &serde_json::Value) -> Result<bool> {
    if !is_qmp_shutdown_event(message) {
        return Ok(false);
    }
    let data = message.get("data").and_then(serde_json::Value::as_object);
    let guest = data
        .and_then(|data| data.get("guest"))
        .and_then(serde_json::Value::as_bool);
    let reason = data
        .and_then(|data| data.get("reason"))
        .and_then(serde_json::Value::as_str);
    if guest == Some(true) && reason == Some("guest-shutdown") {
        return Ok(true);
    }
    bail!("QMP reported a non-guest or unexpected SHUTDOWN event: {message}")
}

#[cfg(unix)]
fn is_qmp_shutdown_event(message: &serde_json::Value) -> bool {
    message.get("event").and_then(serde_json::Value::as_str) == Some("SHUTDOWN")
}

#[cfg(unix)]
fn read_qmp_message(
    reader: &mut BufReader<UnixStream>,
    phase: &str,
    deadline: Instant,
) -> Result<serde_json::Value> {
    const MAX_QMP_MESSAGE_BYTES: usize = 64 * 1024;
    let mut line = String::new();
    loop {
        qmp_remaining(deadline, phase)?;
        if line.len() > MAX_QMP_MESSAGE_BYTES {
            bail!("QMP {phase} response exceeded {MAX_QMP_MESSAGE_BYTES} bytes");
        }
        let remaining_capacity = MAX_QMP_MESSAGE_BYTES + 1 - line.len();
        let bytes = match reader.take(remaining_capacity as u64).read_line(&mut line) {
            Ok(bytes) => bytes,
            Err(error) if matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) => {
                if Instant::now() >= deadline {
                    bail!("QMP deadline expired while waiting for {phase}");
                }
                if line.len() > MAX_QMP_MESSAGE_BYTES {
                    bail!("QMP {phase} response exceeded {MAX_QMP_MESSAGE_BYTES} bytes");
                }
                continue;
            }
            Err(error) => {
                return Err(error).with_context(|| format!("failed to read QMP {phase} response"));
            }
        };
        if bytes == 0 {
            bail!("QMP socket closed before the {phase} response");
        }
        if line.len() > MAX_QMP_MESSAGE_BYTES {
            bail!("QMP {phase} response exceeded {MAX_QMP_MESSAGE_BYTES} bytes");
        }
        if !line.ends_with('\n') {
            bail!("QMP {phase} response was not newline-terminated");
        }
        if line.trim().is_empty() {
            line.clear();
            continue;
        }
        return serde_json::from_str(line.trim())
            .with_context(|| format!("QMP {phase} response was not valid JSON"));
    }
}

#[cfg(unix)]
fn qmp_remaining(deadline: Instant, phase: &str) -> Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .with_context(|| format!("QMP deadline expired while waiting for {phase}"))
}

#[cfg(not(unix))]
fn request_qemu_powerdown(
    _rendered: &RenderedDirectBuild,
    _shutdown_deadline: Instant,
) -> Result<()> {
    bail!("QMP powerdown over Unix sockets is not available on this platform")
}

fn poll_qemu_or_cleanup(qemu: &mut Child) -> Result<Option<ExitStatus>> {
    match qemu.try_wait() {
        Ok(status) => Ok(status),
        Err(error) => Err(qemu_failure_after_cleanup(
            qemu,
            Error::new(error).context(format!("failed to poll QEMU pid {}", qemu.id())),
        )),
    }
}

fn qemu_failure_after_cleanup(qemu: &mut Child, failure: Error) -> Error {
    match terminate_qemu(qemu) {
        Ok(status) => failure.context(format!(
            "QEMU pid {} was terminated and reaped with status {status}",
            qemu.id()
        )),
        Err(cleanup_error) => anyhow!(
            "{failure:#}; additionally failed to terminate and reap QEMU pid {}: {cleanup_error:#}",
            qemu.id()
        ),
    }
}

fn terminate_qemu(qemu: &mut Child) -> Result<ExitStatus> {
    let pid = qemu.id();
    if let Err(kill_error) = qemu.kill() {
        return match qemu.try_wait() {
            Ok(Some(status)) => Ok(status),
            Ok(None) => Err(Error::new(kill_error)
                .context(format!("failed to kill still-running QEMU pid {pid}"))),
            Err(poll_error) => Err(anyhow!(
                "failed to kill QEMU pid {pid}: {kill_error}; failed to determine whether it exited: {poll_error}"
            )),
        };
    }
    qemu.wait()
        .with_context(|| format!("failed to reap QEMU pid {pid} after killing it"))
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

    #[cfg(unix)]
    use std::io::{BufRead as _, BufReader, Write as _};
    #[cfg(unix)]
    use std::os::unix::net::{UnixListener, UnixStream};
    #[cfg(unix)]
    use std::path::PathBuf;
    #[cfg(unix)]
    use std::process::{Command, Stdio};
    #[cfg(unix)]
    use std::thread;
    use std::time::Duration;
    #[cfg(unix)]
    use std::time::Instant;

    use tempfile::{TempDir, tempdir};

    use super::{
        DIRECT_PROVISION_COMMAND, DirectBuildPrepareInput, DirectBuildRequest,
        QEMU_EXIT_POLL_INTERVAL, QMP_IO_TIMEOUT, QMP_READ_POLL_INTERVAL, RenderedDirectBuild,
        SSH_POLL_INTERVAL, prepare_direct_build_inputs, render_direct_build,
        wait_for_qemu_shutdown,
    };
    use crate::config::QemuBuildConfig;
    use crate::kino::KinoArtifact;

    fn render_test_direct_build(
        directory: &TempDir,
        mut config: QemuBuildConfig,
    ) -> RenderedDirectBuild {
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
        config.output_root = directory.path().join("dist");
        config.work_root = directory.path().join(".work");

        render_direct_build(&DirectBuildRequest {
            scenario_path: "scenarios/broken-nginx/scenario.hcl".into(),
            scenario,
            vm_name: "web".to_string(),
            config,
            base_image: catalog.base_image_by_name("trixie").unwrap().clone(),
            kino: KinoArtifact {
                binary_path: "/tmp/kino".into(),
                version: "0.1.24".to_string(),
            },
        })
        .unwrap()
    }

    #[test]
    fn ssh_readiness_poll_does_not_hammer_guest_limits() {
        assert_eq!(SSH_POLL_INTERVAL, std::time::Duration::from_secs(2));
    }

    #[test]
    fn direct_provisioning_requires_success_before_host_poweroff() {
        assert_eq!(
            DIRECT_PROVISION_COMMAND,
            "sudo bash /tmp/intar-provision.sh"
        );
        assert!(!DIRECT_PROVISION_COMMAND.contains("shutdown"));
        assert!(!DIRECT_PROVISION_COMMAND.contains("&&"));
    }

    #[test]
    fn qemu_exit_poll_is_independent_from_ssh_readiness_backoff() {
        assert_eq!(QEMU_EXIT_POLL_INTERVAL, Duration::from_millis(100));
        assert!(QEMU_EXIT_POLL_INTERVAL < SSH_POLL_INTERVAL);
    }

    #[cfg(unix)]
    fn write_qmp_message(stream: &mut UnixStream, message: &serde_json::Value) {
        serde_json::to_writer(&mut *stream, message).unwrap();
        stream.write_all(b"\n").unwrap();
        stream.flush().unwrap();
    }

    #[cfg(unix)]
    fn read_qmp_command(reader: &mut BufReader<UnixStream>, expected: &str) -> String {
        let mut command = String::new();
        reader.read_line(&mut command).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&command).unwrap(),
            serde_json::json!({ "execute": expected, "id": expected })
        );
        command
    }

    #[cfg(unix)]
    fn write_qmp_success(stream: &mut UnixStream, command: &str) {
        write_qmp_message(stream, &serde_json::json!({ "return": {}, "id": command }));
    }

    #[cfg(unix)]
    fn write_guest_shutdown_event(stream: &mut UnixStream) {
        write_qmp_message(
            stream,
            &serde_json::json!({
                "event": "SHUTDOWN",
                "data": { "guest": true, "reason": "guest-shutdown" }
            }),
        );
    }

    #[cfg(unix)]
    fn write_qmp_greeting(stream: &mut UnixStream) {
        write_qmp_message(
            stream,
            &serde_json::json!({
                "QMP": {
                    "version": {
                        "qemu": { "major": 9, "minor": 0, "micro": 0 },
                        "package": ""
                    },
                    "capabilities": []
                }
            }),
        );
    }

    #[cfg(unix)]
    fn serve_acknowledged_powerdown(
        listener: UnixListener,
        exit_marker: Option<PathBuf>,
    ) -> Vec<String> {
        let (mut stream, _) = listener.accept().unwrap();
        let reader_stream = stream.try_clone().unwrap();
        let mut reader = BufReader::new(reader_stream);
        write_qmp_greeting(&mut stream);

        let commands = vec![read_qmp_command(&mut reader, "qmp_capabilities"), {
            write_qmp_success(&mut stream, "qmp_capabilities");
            read_qmp_command(&mut reader, "system_powerdown")
        }];
        write_qmp_success(&mut stream, "system_powerdown");
        write_guest_shutdown_event(&mut stream);
        if let Some(exit_marker) = exit_marker {
            std::fs::write(exit_marker, "powerdown").unwrap();
        }
        commands
    }

    #[cfg(unix)]
    fn run_qmp_flood_case(payload: &'static [u8]) -> (String, Duration, usize) {
        let directory = tempdir().unwrap();
        let rendered = render_test_direct_build(&directory, QemuBuildConfig::default());
        let listener = UnixListener::bind(&rendered.paths.qmp_socket_path).unwrap();
        let qmp_server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let reader_stream = stream.try_clone().unwrap();
            let mut reader = BufReader::new(reader_stream);
            write_qmp_greeting(&mut stream);
            read_qmp_command(&mut reader, "qmp_capabilities");
            let mut writes = 0;
            loop {
                if stream
                    .write_all(payload)
                    .and_then(|()| stream.flush())
                    .is_err()
                {
                    break;
                }
                writes += 1;
                thread::sleep(Duration::from_millis(10));
            }
            writes
        });
        let mut qemu = Command::new("sh")
            .args(["-c", "sleep 60"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let started_at = Instant::now();

        let error = wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap_err();
        let elapsed = started_at.elapsed();
        let writes = qmp_server.join().unwrap();
        assert!(qemu.try_wait().unwrap().is_some());
        (format!("{error:#}"), elapsed, writes)
    }

    #[cfg(unix)]
    #[test]
    fn host_qmp_powerdown_accepts_a_clean_bounded_qemu_exit() {
        let directory = tempdir().unwrap();
        let rendered = render_test_direct_build(
            &directory,
            QemuBuildConfig {
                qemu_exit_timeout_seconds: 1,
                ..QemuBuildConfig::default()
            },
        );
        let listener = UnixListener::bind(&rendered.paths.qmp_socket_path).unwrap();
        let exit_marker = directory.path().join("qemu-exit");
        let server_marker = exit_marker.clone();
        let qmp_server =
            thread::spawn(move || serve_acknowledged_powerdown(listener, Some(server_marker)));
        let mut qemu = Command::new("sh")
            .args([
                "-c",
                "while [ ! -e \"$1\" ]; do sleep 0.01; done",
                "qemu-test",
            ])
            .arg(&exit_marker)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();

        wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap();

        assert_eq!(
            qmp_server.join().unwrap(),
            vec![
                "{\"execute\":\"qmp_capabilities\",\"id\":\"qmp_capabilities\"}\n",
                "{\"execute\":\"system_powerdown\",\"id\":\"system_powerdown\"}\n",
            ]
        );
        assert!(qemu.try_wait().unwrap().unwrap().success());
    }

    #[cfg(unix)]
    #[test]
    fn host_poweroff_fails_closed_when_qmp_is_unavailable() {
        let directory = tempdir().unwrap();
        let rendered = render_test_direct_build(&directory, QemuBuildConfig::default());
        let mut qemu = Command::new("sh")
            .args(["-c", "sleep 60"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let started_at = Instant::now();

        let error = wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap_err();
        let error = format!("{error:#}");

        assert!(started_at.elapsed() < Duration::from_secs(3));
        assert!(
            error.contains("failed to complete QMP guest powerdown handshake after provisioning")
        );
        assert!(error.contains("failed to connect to QMP socket"));
        assert!(error.contains("was terminated and reaped"));
        assert!(qemu.try_wait().unwrap().is_some());
    }

    #[cfg(unix)]
    #[test]
    fn host_poweroff_rejects_clean_qemu_exit_before_acknowledgement() {
        let directory = tempdir().unwrap();
        let rendered = render_test_direct_build(&directory, QemuBuildConfig::default());
        let mut qemu = Command::new("sh")
            .args(["-c", "exit 0"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        assert!(qemu.wait().unwrap().success());

        let error = wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap_err();

        assert!(format!("{error:#}").contains(
            "QEMU exited with status exit status: 0 before the host requested acknowledged QMP powerdown"
        ));
        assert!(qemu.try_wait().unwrap().is_some());
    }

    #[cfg(unix)]
    #[test]
    fn host_poweroff_fails_closed_when_qmp_returns_an_error() {
        let directory = tempdir().unwrap();
        let rendered = render_test_direct_build(&directory, QemuBuildConfig::default());
        let listener = UnixListener::bind(&rendered.paths.qmp_socket_path).unwrap();
        let qmp_server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let reader_stream = stream.try_clone().unwrap();
            let mut reader = BufReader::new(reader_stream);
            write_qmp_greeting(&mut stream);
            let command = read_qmp_command(&mut reader, "qmp_capabilities");
            write_qmp_message(
                &mut stream,
                &serde_json::json!({
                    "error": { "class": "CommandNotFound", "desc": "disabled" },
                    "id": "qmp_capabilities"
                }),
            );
            command
        });
        let mut qemu = Command::new("sh")
            .args(["-c", "sleep 60"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();

        let error = wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap_err();
        let error = format!("{error:#}");

        assert_eq!(
            qmp_server.join().unwrap(),
            "{\"execute\":\"qmp_capabilities\",\"id\":\"qmp_capabilities\"}\n"
        );
        assert!(error.contains("QMP qmp_capabilities command failed"));
        assert!(error.contains("CommandNotFound"));
        assert!(error.contains("was terminated and reaped"));
        assert!(qemu.try_wait().unwrap().is_some());
    }

    #[cfg(unix)]
    #[test]
    fn host_poweroff_requires_a_system_powerdown_acknowledgement() {
        let directory = tempdir().unwrap();
        let rendered = render_test_direct_build(&directory, QemuBuildConfig::default());
        let listener = UnixListener::bind(&rendered.paths.qmp_socket_path).unwrap();
        let qmp_server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let reader_stream = stream.try_clone().unwrap();
            let mut reader = BufReader::new(reader_stream);
            write_qmp_greeting(&mut stream);
            let capabilities = read_qmp_command(&mut reader, "qmp_capabilities");
            write_qmp_success(&mut stream, "qmp_capabilities");
            let powerdown = read_qmp_command(&mut reader, "system_powerdown");
            write_qmp_message(
                &mut stream,
                &serde_json::json!({
                    "error": { "class": "GenericError", "desc": "powerdown rejected" },
                    "id": "system_powerdown"
                }),
            );
            vec![capabilities, powerdown]
        });
        let mut qemu = Command::new("sh")
            .args(["-c", "sleep 60"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();

        let error = wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap_err();
        let error = format!("{error:#}");

        assert_eq!(qmp_server.join().unwrap().len(), 2);
        assert!(error.contains("QMP system_powerdown command failed"));
        assert!(error.contains("powerdown rejected"));
        assert!(error.contains("was terminated and reaped"));
        assert!(qemu.try_wait().unwrap().is_some());
    }

    #[cfg(unix)]
    #[test]
    fn host_poweroff_requires_a_guest_shutdown_event_after_acknowledgement() {
        let directory = tempdir().unwrap();
        let rendered = render_test_direct_build(
            &directory,
            QemuBuildConfig {
                qemu_exit_timeout_seconds: 1,
                ..QemuBuildConfig::default()
            },
        );
        let listener = UnixListener::bind(&rendered.paths.qmp_socket_path).unwrap();
        let qmp_server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let reader_stream = stream.try_clone().unwrap();
            let mut reader = BufReader::new(reader_stream);
            write_qmp_greeting(&mut stream);
            read_qmp_command(&mut reader, "qmp_capabilities");
            write_qmp_success(&mut stream, "qmp_capabilities");
            read_qmp_command(&mut reader, "system_powerdown");
            write_qmp_success(&mut stream, "system_powerdown");
            thread::sleep(Duration::from_millis(1_100));
        });
        let mut qemu = Command::new("sh")
            .args(["-c", "sleep 60"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let started_at = Instant::now();

        let error = wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap_err();
        let error = format!("{error:#}");

        qmp_server.join().unwrap();
        assert!(started_at.elapsed() >= Duration::from_millis(900));
        assert!(started_at.elapsed() < Duration::from_secs(3));
        assert!(error.contains("QMP deadline expired while waiting for guest SHUTDOWN event"));
        assert!(error.contains("was terminated and reaped"));
        assert!(qemu.try_wait().unwrap().is_some());
    }

    #[cfg(unix)]
    #[test]
    fn host_poweroff_rejects_a_non_guest_shutdown_event() {
        let directory = tempdir().unwrap();
        let rendered = render_test_direct_build(&directory, QemuBuildConfig::default());
        let listener = UnixListener::bind(&rendered.paths.qmp_socket_path).unwrap();
        let qmp_server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let reader_stream = stream.try_clone().unwrap();
            let mut reader = BufReader::new(reader_stream);
            write_qmp_greeting(&mut stream);
            read_qmp_command(&mut reader, "qmp_capabilities");
            write_qmp_success(&mut stream, "qmp_capabilities");
            read_qmp_command(&mut reader, "system_powerdown");
            write_qmp_success(&mut stream, "system_powerdown");
            write_qmp_message(
                &mut stream,
                &serde_json::json!({
                    "event": "SHUTDOWN",
                    "data": { "guest": false, "reason": "host-qmp-quit" }
                }),
            );
        });
        let mut qemu = Command::new("sh")
            .args(["-c", "sleep 60"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();

        let error = wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap_err();
        let error = format!("{error:#}");

        qmp_server.join().unwrap();
        assert!(
            error.contains("QMP reported a non-guest or unexpected SHUTDOWN event"),
            "unexpected error: {error}"
        );
        assert!(error.contains("host-qmp-quit"));
        assert!(error.contains("was terminated and reaped"));
        assert!(qemu.try_wait().unwrap().is_some());
    }

    #[cfg(unix)]
    #[test]
    fn host_poweroff_rejects_shutdown_buffered_before_system_powerdown_ack() {
        let directory = tempdir().unwrap();
        let rendered = render_test_direct_build(&directory, QemuBuildConfig::default());
        let listener = UnixListener::bind(&rendered.paths.qmp_socket_path).unwrap();
        let qmp_server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let reader_stream = stream.try_clone().unwrap();
            let mut reader = BufReader::new(reader_stream);
            write_qmp_greeting(&mut stream);
            read_qmp_command(&mut reader, "qmp_capabilities");
            write_qmp_success(&mut stream, "qmp_capabilities");
            // Queueing a shutdown before the client can send system_powerdown
            // must not be accepted as proof that the request was honored.
            write_guest_shutdown_event(&mut stream);
            read_qmp_command(&mut reader, "system_powerdown");
            write_qmp_success(&mut stream, "system_powerdown");
        });
        let mut qemu = Command::new("sh")
            .args(["-c", "sleep 60"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();

        let error = wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap_err();
        let error = format!("{error:#}");

        qmp_server.join().unwrap();
        assert!(
            error.contains("QMP reported shutdown before acknowledging system_powerdown"),
            "unexpected error: {error}"
        );
        assert!(error.contains("was terminated and reaped"));
        assert!(qemu.try_wait().unwrap().is_some());
    }

    #[cfg(unix)]
    #[test]
    fn host_poweroff_ignores_unrelated_events_after_acknowledgement() {
        let directory = tempdir().unwrap();
        let rendered = render_test_direct_build(
            &directory,
            QemuBuildConfig {
                qemu_exit_timeout_seconds: 1,
                ..QemuBuildConfig::default()
            },
        );
        let listener = UnixListener::bind(&rendered.paths.qmp_socket_path).unwrap();
        let exit_marker = directory.path().join("qemu-exit");
        let server_marker = exit_marker.clone();
        let qmp_server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let reader_stream = stream.try_clone().unwrap();
            let mut reader = BufReader::new(reader_stream);
            write_qmp_greeting(&mut stream);
            read_qmp_command(&mut reader, "qmp_capabilities");
            write_qmp_success(&mut stream, "qmp_capabilities");
            read_qmp_command(&mut reader, "system_powerdown");
            write_qmp_success(&mut stream, "system_powerdown");
            write_qmp_message(
                &mut stream,
                &serde_json::json!({ "event": "DEVICE_DELETED", "data": {} }),
            );
            write_guest_shutdown_event(&mut stream);
            std::fs::write(server_marker, "powerdown").unwrap();
        });
        let mut qemu = Command::new("sh")
            .args([
                "-c",
                "while [ ! -e \"$1\" ]; do sleep 0.01; done",
                "qemu-test",
            ])
            .arg(&exit_marker)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();

        wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap();

        qmp_server.join().unwrap();
        assert!(qemu.try_wait().unwrap().unwrap().success());
    }

    #[cfg(unix)]
    #[test]
    fn host_poweroff_preserves_qmp_lines_fragmented_across_read_polls() {
        let directory = tempdir().unwrap();
        let rendered = render_test_direct_build(
            &directory,
            QemuBuildConfig {
                qemu_exit_timeout_seconds: 1,
                ..QemuBuildConfig::default()
            },
        );
        let listener = UnixListener::bind(&rendered.paths.qmp_socket_path).unwrap();
        let exit_marker = directory.path().join("qemu-exit");
        let server_marker = exit_marker.clone();
        let qmp_server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let reader_stream = stream.try_clone().unwrap();
            let mut reader = BufReader::new(reader_stream);
            write_qmp_greeting(&mut stream);
            read_qmp_command(&mut reader, "qmp_capabilities");
            write_qmp_success(&mut stream, "qmp_capabilities");
            read_qmp_command(&mut reader, "system_powerdown");
            write_qmp_success(&mut stream, "system_powerdown");
            stream.write_all(b"{\"event\":\"SHUT").unwrap();
            stream.flush().unwrap();
            thread::sleep(QMP_READ_POLL_INTERVAL + Duration::from_millis(50));
            stream
                .write_all(b"DOWN\",\"data\":{\"guest\":true,\"reason\":\"guest-shutdown\"}}\n")
                .unwrap();
            stream.flush().unwrap();
            std::fs::write(server_marker, "powerdown").unwrap();
        });
        let mut qemu = Command::new("sh")
            .args([
                "-c",
                "while [ ! -e \"$1\" ]; do sleep 0.01; done",
                "qemu-test",
            ])
            .arg(&exit_marker)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();

        wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap();

        qmp_server.join().unwrap();
        assert!(qemu.try_wait().unwrap().unwrap().success());
    }

    #[cfg(unix)]
    #[test]
    fn host_poweroff_fails_when_qmp_closes_after_powerdown_ack() {
        let directory = tempdir().unwrap();
        let rendered = render_test_direct_build(&directory, QemuBuildConfig::default());
        let listener = UnixListener::bind(&rendered.paths.qmp_socket_path).unwrap();
        let qmp_server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let reader_stream = stream.try_clone().unwrap();
            let mut reader = BufReader::new(reader_stream);
            write_qmp_greeting(&mut stream);
            read_qmp_command(&mut reader, "qmp_capabilities");
            write_qmp_success(&mut stream, "qmp_capabilities");
            read_qmp_command(&mut reader, "system_powerdown");
            write_qmp_success(&mut stream, "system_powerdown");
        });
        let mut qemu = Command::new("sh")
            .args(["-c", "sleep 60"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();

        let error = wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap_err();
        let error = format!("{error:#}");

        qmp_server.join().unwrap();
        assert!(
            error.contains("QMP socket closed before the guest SHUTDOWN event response"),
            "unexpected error: {error}"
        );
        assert!(error.contains("was terminated and reaped"));
        assert!(qemu.try_wait().unwrap().is_some());
    }

    #[cfg(unix)]
    #[test]
    fn host_poweroff_rejects_a_mismatched_qmp_response_id() {
        let directory = tempdir().unwrap();
        let rendered = render_test_direct_build(&directory, QemuBuildConfig::default());
        let listener = UnixListener::bind(&rendered.paths.qmp_socket_path).unwrap();
        let qmp_server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let reader_stream = stream.try_clone().unwrap();
            let mut reader = BufReader::new(reader_stream);
            write_qmp_greeting(&mut stream);
            read_qmp_command(&mut reader, "qmp_capabilities");
            write_qmp_message(
                &mut stream,
                &serde_json::json!({ "return": {}, "id": "wrong-command" }),
            );
        });
        let mut qemu = Command::new("sh")
            .args(["-c", "sleep 60"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();

        let error = wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap_err();
        let error = format!("{error:#}");

        qmp_server.join().unwrap();
        assert!(error.contains("missing or mismatched id"));
        assert!(error.contains("wrong-command"));
        assert!(error.contains("was terminated and reaped"));
        assert!(qemu.try_wait().unwrap().is_some());
    }

    #[cfg(unix)]
    #[test]
    fn host_poweroff_fails_closed_when_qmp_closes_without_acknowledging() {
        let directory = tempdir().unwrap();
        let rendered = render_test_direct_build(&directory, QemuBuildConfig::default());
        let listener = UnixListener::bind(&rendered.paths.qmp_socket_path).unwrap();
        let qmp_server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let reader_stream = stream.try_clone().unwrap();
            let mut reader = BufReader::new(reader_stream);
            write_qmp_greeting(&mut stream);
            read_qmp_command(&mut reader, "qmp_capabilities")
        });
        let mut qemu = Command::new("sh")
            .args(["-c", "sleep 60"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();

        let error = wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap_err();
        let error = format!("{error:#}");

        assert_eq!(
            qmp_server.join().unwrap(),
            "{\"execute\":\"qmp_capabilities\",\"id\":\"qmp_capabilities\"}\n"
        );
        assert!(error.contains("QMP socket closed before the qmp_capabilities response"));
        assert!(error.contains("was terminated and reaped"));
        assert!(qemu.try_wait().unwrap().is_some());
    }

    #[cfg(unix)]
    #[test]
    fn host_poweroff_fails_closed_when_qmp_reply_is_malformed() {
        let directory = tempdir().unwrap();
        let rendered = render_test_direct_build(&directory, QemuBuildConfig::default());
        let listener = UnixListener::bind(&rendered.paths.qmp_socket_path).unwrap();
        let qmp_server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let reader_stream = stream.try_clone().unwrap();
            let mut reader = BufReader::new(reader_stream);
            write_qmp_greeting(&mut stream);
            let command = read_qmp_command(&mut reader, "qmp_capabilities");
            stream.write_all(b"{not-json}\n").unwrap();
            stream.flush().unwrap();
            command
        });
        let mut qemu = Command::new("sh")
            .args(["-c", "sleep 60"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();

        let error = wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap_err();
        let error = format!("{error:#}");

        assert_eq!(
            qmp_server.join().unwrap(),
            "{\"execute\":\"qmp_capabilities\",\"id\":\"qmp_capabilities\"}\n"
        );
        assert!(error.contains("QMP qmp_capabilities response was not valid JSON"));
        assert!(error.contains("was terminated and reaped"));
        assert!(qemu.try_wait().unwrap().is_some());
    }

    #[cfg(unix)]
    #[test]
    fn host_poweroff_fails_closed_when_qmp_never_acknowledges() {
        let directory = tempdir().unwrap();
        let rendered = render_test_direct_build(&directory, QemuBuildConfig::default());
        let listener = UnixListener::bind(&rendered.paths.qmp_socket_path).unwrap();
        let qmp_server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let reader_stream = stream.try_clone().unwrap();
            let mut reader = BufReader::new(reader_stream);
            write_qmp_greeting(&mut stream);
            let command = read_qmp_command(&mut reader, "qmp_capabilities");
            thread::sleep(QMP_IO_TIMEOUT + Duration::from_millis(100));
            command
        });
        let mut qemu = Command::new("sh")
            .args(["-c", "sleep 60"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let started_at = Instant::now();

        let error = wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap_err();
        let error = format!("{error:#}");

        assert_eq!(
            qmp_server.join().unwrap(),
            "{\"execute\":\"qmp_capabilities\",\"id\":\"qmp_capabilities\"}\n"
        );
        assert!(started_at.elapsed() >= QMP_IO_TIMEOUT);
        assert!(started_at.elapsed() < Duration::from_secs(4));
        assert!(error.contains("QMP deadline expired while waiting for qmp_capabilities"));
        assert!(error.contains("was terminated and reaped"));
        assert!(qemu.try_wait().unwrap().is_some());
    }

    #[cfg(unix)]
    #[test]
    fn host_poweroff_has_an_absolute_deadline_during_qmp_floods() {
        for payload in [
            b"{\"event\":\"DEVICE_DELETED\"}\n".as_slice(),
            b"\n".as_slice(),
        ] {
            let (error, elapsed, writes) = run_qmp_flood_case(payload);

            assert!(elapsed >= QMP_IO_TIMEOUT);
            assert!(elapsed < Duration::from_secs(4));
            assert!(writes > 10);
            assert!(error.contains("QMP deadline expired while waiting for qmp_capabilities"));
            assert!(error.contains("was terminated and reaped"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn host_poweroff_fails_closed_when_acknowledged_qemu_stays_alive() {
        let directory = tempdir().unwrap();
        let rendered = render_test_direct_build(
            &directory,
            QemuBuildConfig {
                qemu_exit_timeout_seconds: 1,
                ..QemuBuildConfig::default()
            },
        );
        let listener = UnixListener::bind(&rendered.paths.qmp_socket_path).unwrap();
        let qmp_server = thread::spawn(move || serve_acknowledged_powerdown(listener, None));
        let mut qemu = Command::new("sh")
            .args(["-c", "sleep 60"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let started_at = Instant::now();

        let error = wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap_err();
        let error = format!("{error:#}");

        assert_eq!(qmp_server.join().unwrap().len(), 2);
        assert!(started_at.elapsed() >= Duration::from_millis(900));
        assert!(started_at.elapsed() < Duration::from_secs(3));
        assert!(error.contains(
            "timed out waiting 1s for QEMU to exit after a guest-originated QMP shutdown event"
        ));
        assert!(error.contains("was terminated and reaped"));
        assert!(qemu.try_wait().unwrap().is_some());
    }

    #[cfg(unix)]
    #[test]
    fn host_poweroff_rejects_nonzero_qemu_exit_after_acknowledgement() {
        let directory = tempdir().unwrap();
        let rendered = render_test_direct_build(
            &directory,
            QemuBuildConfig {
                qemu_exit_timeout_seconds: 1,
                ..QemuBuildConfig::default()
            },
        );
        let listener = UnixListener::bind(&rendered.paths.qmp_socket_path).unwrap();
        let exit_marker = directory.path().join("qemu-exit");
        let server_marker = exit_marker.clone();
        let qmp_server =
            thread::spawn(move || serve_acknowledged_powerdown(listener, Some(server_marker)));
        let mut qemu = Command::new("sh")
            .args([
                "-c",
                "while [ ! -e \"$1\" ]; do sleep 0.01; done; exit 7",
                "qemu-test",
            ])
            .arg(&exit_marker)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();

        let error = wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap_err();

        assert_eq!(qmp_server.join().unwrap().len(), 2);
        let error = format!("{error:#}");
        assert!(
            error.contains("QEMU exited with status exit status: 7"),
            "unexpected error: {error}"
        );
        assert!(qemu.try_wait().unwrap().is_some());
    }

    #[test]
    fn direct_render_uses_raw_zstd_outputs_and_direct_boot_args() {
        let directory = tempdir().unwrap();
        let rendered = render_test_direct_build(&directory, QemuBuildConfig::default());

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
