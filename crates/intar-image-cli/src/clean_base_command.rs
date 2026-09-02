use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result, bail, ensure};
use clap::Args;
use intar_image_build::{
    BuildSeedInput, BuildSshSession, DirectBootQemuInput, DirectQemuShutdownInput,
    PUBLISHED_BOOT_CMDLINE, QemuBuildConfig, acknowledged_qmp_shutdown, ensure_base_rootfs,
    generate_build_ssh_key, render_direct_boot_qemu_command, sha256_file_hex, write_build_seed,
    write_raw_zstd_artifact,
};
use intar_image_scenario::BaseImageSpec;
use serde::{Deserialize, Serialize};

use super::{BASE_IMAGES_PATH, load_base_image_catalog, load_build_config};

const SYSTEM_IMAGE: &str = "debian-13";
const BASE_NAME: &str = "trixie";
const SSH_HOST: &str = "127.0.0.1";
const SSH_USERNAME: &str = "ubuntu";
const QMP_SOCKET_FILE: &str = "qmp.sock";
const RAW_FILE: &str = "clean-debian13.raw.zst";
const KERNEL_FILE: &str = "clean-debian13-vmlinuz";
const INITRD_FILE: &str = "clean-debian13-initrd.img";
const PACKAGE_INVENTORY_FILE: &str = "package-inventory.txt";
const PROOF_FILE: &str = "proof.json";
const CHECKSUMS_FILE: &str = "SHA256SUMS";
const MAX_RAW_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MIN_RAW_BYTES: u64 = 512 * 1024 * 1024;
const MAX_KERNEL_BYTES: u64 = 128 * 1024 * 1024;
const MAX_INITRD_BYTES: u64 = 512 * 1024 * 1024;
const MAX_COMPRESSED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_INVENTORY_BYTES: u64 = 2 * 1024 * 1024;
const SSH_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(30);
const SSH_OPERATION_TIMEOUT: Duration = Duration::from_secs(120);
const GUEST_PROOF_COMMAND: &str = r#"sudo -- /bin/bash -ceu '
. /etc/os-release
test "${ID}" = debian
test "${VERSION_ID}" = 13
test "$(uname -m)" = x86_64
test "$(dpkg --print-architecture)" = amd64
for command in docker containerd ctr podman buildah skopeo kubelet kubectl talosctl kino; do
  ! command -v "${command}" >/dev/null 2>&1
done
for path in \
  /usr/local/bin/kino \
  /usr/local/libexec/intar \
  /var/lib/docker \
  /var/lib/containerd \
  /var/lib/containers \
  /var/lib/kubelet \
  /etc/kubernetes \
  /etc/talos; do
  test ! -e "${path}"
done
if dpkg-query -W -f="\${binary:Package}\n" 2>/dev/null |
  grep -Eiq "^(docker|containerd|podman|buildah|skopeo|kubelet|kubectl|talos|intar)"; then
  exit 1
fi
dpkg-query -W -f="\${binary:Package}\t\${Version}\n" |
  LC_ALL=C sort > /tmp/intar-clean-base-packages.txt
test "$(wc -c < /tmp/intar-clean-base-packages.txt)" -le 2097152
cat > /tmp/intar-clean-base-proof.json <<EOF
{"schema_version":1,"debian_13":true,"x86_64":true,"dpkg_amd64":true,"ssh_ready":true,"forbidden_packages_absent":true,"forbidden_commands_absent":true,"forbidden_paths_absent":true}
EOF
test "$(wc -c < /tmp/intar-clean-base-proof.json)" -le 4096
'"#;

#[derive(Debug, Args)]
pub(super) struct BuildBaseCommand {
    #[arg(long, default_value = BASE_IMAGES_PATH)]
    base_images: PathBuf,
    #[arg(long, default_value = BASE_NAME)]
    base: String,
    #[arg(long)]
    config: PathBuf,
    #[arg(long)]
    output: PathBuf,
    #[arg(long)]
    repository: String,
    #[arg(long)]
    source_sha: String,
    #[arg(long)]
    production_run_id: u64,
    #[arg(long)]
    workflow_run_id: u64,
    #[arg(long)]
    workflow_run_attempt: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct GuestProof {
    schema_version: u32,
    debian_13: bool,
    x86_64: bool,
    dpkg_amd64: bool,
    ssh_ready: bool,
    forbidden_packages_absent: bool,
    forbidden_commands_absent: bool,
    forbidden_paths_absent: bool,
}

#[derive(Debug, Serialize)]
struct PublishedFile {
    name: String,
    sha256: String,
    size_bytes: u64,
}

#[derive(Debug, Serialize)]
struct CleanBaseProof {
    schema_version: u32,
    repository: String,
    source_sha: String,
    production_run_id: u64,
    workflow_run_id: u64,
    workflow_run_attempt: u64,
    system_image: &'static str,
    base_name: String,
    base_definition_sha256: String,
    architecture: &'static str,
    boot_cmdline: &'static str,
    raw_disk_sha256: String,
    raw_disk_size_bytes: u64,
    files: Vec<PublishedFile>,
    guest: GuestProof,
    fresh_seed: bool,
    kvm: bool,
    qmp_shutdown_acknowledged: bool,
    pristine_filesystem_verified: bool,
    disposable_filesystem_verified: bool,
    pristine_source_unchanged: bool,
}

pub(super) fn build_base_command(args: &BuildBaseCommand) -> Result<()> {
    validate_provenance(args)?;
    validate_output_path(&args.output)?;

    let mut config = load_build_config(Some(&args.config))?.qemu;
    validate_config(&config)?;
    let catalog = load_base_image_catalog(&args.base_images)?;
    let base = catalog
        .base_image_by_name(&args.base)
        .with_context(|| format!("base image '{}' was not found", args.base))?
        .clone();
    validate_base(&base)?;

    let output_parent = args
        .output
        .parent()
        .context("clean-base output has no parent")?;
    fs::create_dir_all(output_parent).with_context(|| {
        format!(
            "failed to create clean-base output parent '{}'",
            output_parent.display()
        )
    })?;
    let staging = tempfile::Builder::new()
        .prefix(".intar-clean-base-")
        .tempdir_in(output_parent)
        .context("failed to create clean-base staging directory")?;
    config.work_root = staging.path().join("build-work");
    config.output_root = staging.path().join("build-output");
    ensure!(
        !config.work_root.exists() && !config.output_root.exists(),
        "clean-base build roots must be fresh"
    );

    let artifact = ensure_base_rootfs(&base, &config)
        .context("failed to build the clean Debian base rootfs")?;
    validate_artifact_file(
        &artifact.base_ext4_path,
        MIN_RAW_BYTES,
        MAX_RAW_BYTES,
        "raw disk",
    )?;
    validate_artifact_file(&artifact.kernel_path, 1, MAX_KERNEL_BYTES, "kernel")?;
    validate_artifact_file(&artifact.initrd_path, 1, MAX_INITRD_BYTES, "initrd")?;

    verify_ext4(
        &config.e2fsck_binary,
        &artifact.base_ext4_path,
        "pristine source",
    )?;
    let raw_sha_before = sha256_file_hex(&artifact.base_ext4_path)?;
    let proof_root = staging.path().join("cold-boot-proof");
    fs::create_dir(&proof_root).context("failed to create cold-boot proof directory")?;
    let disposable_disk = proof_root.join("root.raw");
    fs::copy(&artifact.base_ext4_path, &disposable_disk)
        .context("failed to clone the pristine clean-base disk")?;
    let seed_disk = proof_root.join("intarbuild.img");
    let ssh_key = generate_build_ssh_key().context("failed to create clean-base proof SSH key")?;
    write_build_seed(&BuildSeedInput {
        path: &seed_disk,
        ssh_authorized_keys_openssh: std::slice::from_ref(&ssh_key.public_key_openssh),
        guest_ip_cidr: "10.0.2.15/24",
        gateway: "10.0.2.2",
        dns: "10.0.2.3",
        iface: None,
    })
    .context("failed to write clean-base proof seed")?;

    let serial_log = proof_root.join("serial.log");
    let build_log = proof_root.join("build.log");
    fs::write(&build_log, b"== clean Debian 13 cold-boot proof ==\n")
        .context("failed to initialize clean-base proof log")?;
    let qmp_socket = proof_root.join(QMP_SOCKET_FILE);
    let ssh_port = allocate_loopback_port()?;
    let qemu_command = render_direct_boot_qemu_command(&DirectBootQemuInput {
        config: &config,
        root_disk_path: &disposable_disk,
        seed_disk_path: &seed_disk,
        kernel_path: &artifact.kernel_path,
        initrd_path: &artifact.initrd_path,
        serial_log_path: &serial_log,
        qmp_socket_path: Path::new(QMP_SOCKET_FILE),
        ssh_host_port: ssh_port,
        memory_mib: config.build_memory_mb,
        cpu_count: config.build_cpus,
        boot_cmdline: PUBLISHED_BOOT_CMDLINE,
    });
    let mut qemu = Command::new(&qemu_command.binary)
        .args(&qemu_command.args)
        .current_dir(&proof_root)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .with_context(|| format!("failed to start '{}'", qemu_command.binary.display()))?;

    let guest_proof_path = proof_root.join("guest-proof.json");
    let inventory_path = proof_root.join(PACKAGE_INVENTORY_FILE);
    let guest_result = prove_guest(
        &config,
        &mut qemu,
        ssh_port,
        &ssh_key,
        &guest_proof_path,
        &inventory_path,
    );
    let guest = match guest_result {
        Ok(proof) => proof,
        Err(error) => {
            return Err(error_after_qemu_cleanup(&mut qemu, error));
        }
    };
    acknowledged_qmp_shutdown(
        &mut qemu,
        &DirectQemuShutdownInput {
            qmp_socket_path: &qmp_socket,
            serial_log_path: &serial_log,
            build_log_path: &build_log,
            timeout_seconds: config.qemu_exit_timeout_seconds,
        },
    )
    .context("clean-base proof guest did not complete acknowledged QMP shutdown")?;
    verify_ext4(
        &config.e2fsck_binary,
        &disposable_disk,
        "disposable proof clone",
    )?;
    verify_ext4(
        &config.e2fsck_binary,
        &artifact.base_ext4_path,
        "pristine source after proof",
    )?;
    let raw_sha_after = sha256_file_hex(&artifact.base_ext4_path)?;
    ensure!(
        raw_sha_before == raw_sha_after,
        "pristine clean-base disk changed during cold-boot proof"
    );

    let payload = staging.path().join("payload");
    fs::create_dir(&payload).context("failed to create clean-base payload directory")?;
    let compressed_path = payload.join(RAW_FILE);
    let temporary_checksum = staging.path().join("raw-zstd.sha256");
    let compressed = write_raw_zstd_artifact(
        &artifact.base_ext4_path,
        &compressed_path,
        &temporary_checksum,
    )?;
    validate_artifact_file(
        &compressed.compressed_path,
        1,
        MAX_COMPRESSED_BYTES,
        "compressed raw disk",
    )?;
    copy_regular(&artifact.kernel_path, &payload.join(KERNEL_FILE))?;
    copy_regular(&artifact.initrd_path, &payload.join(INITRD_FILE))?;
    copy_regular(&inventory_path, &payload.join(PACKAGE_INVENTORY_FILE))?;
    validate_artifact_file(
        &payload.join(PACKAGE_INVENTORY_FILE),
        1,
        MAX_INVENTORY_BYTES,
        "package inventory",
    )?;

    let published_files = published_files(&payload)?;
    let proof = CleanBaseProof {
        schema_version: 1,
        repository: args.repository.clone(),
        source_sha: args.source_sha.clone(),
        production_run_id: args.production_run_id,
        workflow_run_id: args.workflow_run_id,
        workflow_run_attempt: args.workflow_run_attempt,
        system_image: SYSTEM_IMAGE,
        base_name: base.name,
        base_definition_sha256: artifact.definition_hash,
        architecture: "x86_64",
        boot_cmdline: PUBLISHED_BOOT_CMDLINE,
        raw_disk_sha256: raw_sha_before,
        raw_disk_size_bytes: compressed.virtual_size_bytes,
        files: published_files,
        guest,
        fresh_seed: true,
        kvm: true,
        qmp_shutdown_acknowledged: true,
        pristine_filesystem_verified: true,
        disposable_filesystem_verified: true,
        pristine_source_unchanged: true,
    };
    let mut proof_json =
        serde_json::to_vec_pretty(&proof).context("failed to serialize clean-base proof")?;
    proof_json.push(b'\n');
    fs::write(payload.join(PROOF_FILE), proof_json).context("failed to write clean-base proof")?;
    write_checksums(&payload)?;

    fs::rename(&payload, &args.output).with_context(|| {
        format!(
            "failed to atomically promote clean-base artifact to '{}'",
            args.output.display()
        )
    })?;
    println!(
        "built {} at {} from {}",
        SYSTEM_IMAGE,
        args.output.display(),
        args.source_sha
    );
    Ok(())
}

fn validate_provenance(args: &BuildBaseCommand) -> Result<()> {
    ensure!(
        args.repository == "intar-dev/intar-dev",
        "clean-base repository must be intar-dev/intar-dev"
    );
    ensure!(
        args.source_sha.len() == 40
            && args
                .source_sha
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "clean-base source SHA must be 40 lowercase hexadecimal characters"
    );
    ensure!(
        args.production_run_id > 0 && args.workflow_run_id > 0,
        "clean-base workflow and production run IDs must be positive"
    );
    ensure!(
        args.workflow_run_attempt == 1,
        "clean-base workflow reruns are not valid production evidence"
    );
    Ok(())
}

fn validate_output_path(output: &Path) -> Result<()> {
    ensure!(output.is_absolute(), "clean-base output must be absolute");
    ensure!(!output.exists(), "clean-base output already exists");
    let parent = output.parent().context("clean-base output has no parent")?;
    if parent.exists() {
        let metadata = fs::symlink_metadata(parent)?;
        ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "clean-base output parent must be a real directory"
        );
    }
    Ok(())
}

fn validate_config(config: &QemuBuildConfig) -> Result<()> {
    ensure!(
        config.target_arch == "amd64",
        "clean-base target architecture must be amd64"
    );
    ensure!(config.accelerator == "kvm", "clean-base proof requires KVM");
    ensure!(
        config.qemuargs.is_empty(),
        "clean-base proof rejects custom QEMU arguments"
    );
    ensure!(
        (1..=16).contains(&config.build_cpus),
        "clean-base build CPU count is out of bounds"
    );
    ensure!(
        (1024..=32768).contains(&config.build_memory_mb),
        "clean-base build memory is out of bounds"
    );
    for (label, path) in [
        ("qemu", &config.qemu_binary),
        ("mmdebstrap", &config.mmdebstrap_binary),
        ("mke2fs", &config.mke2fs_binary),
        ("e2fsck", &config.e2fsck_binary),
    ] {
        ensure!(
            path.is_absolute() && path.is_file(),
            "clean-base {label} binary must be an absolute regular file"
        );
    }
    Ok(())
}

fn validate_base(base: &BaseImageSpec) -> Result<()> {
    ensure!(base.name == BASE_NAME, "clean-base name must be trixie");
    ensure!(base.suite == "trixie", "clean-base suite must be trixie");
    ensure!(
        base.arch == "amd64",
        "clean-base architecture must be amd64"
    );
    ensure!(
        base.kernel_package == "linux-image-cloud-amd64",
        "clean-base kernel package must be linux-image-cloud-amd64"
    );
    let forbidden = [
        "docker",
        "containerd",
        "podman",
        "buildah",
        "skopeo",
        "kubernetes",
        "kubelet",
        "talos",
        "intar",
    ];
    for package in std::iter::once(base.kernel_package.as_str())
        .chain(base.packages.iter().map(String::as_str))
    {
        let normalized = package.to_ascii_lowercase();
        ensure!(
            !forbidden.iter().any(|item| normalized.contains(item)),
            "clean-base package '{package}' is forbidden"
        );
    }
    Ok(())
}

fn validate_artifact_file(path: &Path, minimum: u64, maximum: u64, label: &str) -> Result<()> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("failed to stat {label} '{}'", path.display()))?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "{label} is not a regular file"
    );
    ensure!(
        (minimum..=maximum).contains(&metadata.len()),
        "{label} size {} is outside {minimum}..={maximum}",
        metadata.len()
    );
    Ok(())
}

fn allocate_loopback_port() -> Result<u16> {
    let listener = std::net::TcpListener::bind((SSH_HOST, 0))
        .context("failed to allocate clean-base SSH port")?;
    Ok(listener.local_addr()?.port())
}

fn block_on_timeout<F>(
    runtime: &tokio::runtime::Runtime,
    duration: Duration,
    future: F,
) -> std::result::Result<F::Output, tokio::time::error::Elapsed>
where
    F: Future,
{
    runtime.block_on(async move { tokio::time::timeout(duration, future).await })
}

fn prove_guest(
    config: &QemuBuildConfig,
    qemu: &mut Child,
    port: u16,
    ssh_key: &intar_image_build::BuildSshKey,
    guest_proof_path: &Path,
    inventory_path: &Path,
) -> Result<GuestProof> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("failed to create clean-base SSH runtime")?;
    let deadline = Instant::now() + Duration::from_secs(config.ssh_wait_timeout_seconds.max(1));
    let mut last_error: anyhow::Error;
    let mut session = loop {
        if let Some(status) = qemu.try_wait().context("failed to poll clean-base QEMU")? {
            bail!("clean-base QEMU exited before SSH readiness: {status}");
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        let attempt_timeout = SSH_ATTEMPT_TIMEOUT.min(remaining);
        match block_on_timeout(
            &runtime,
            attempt_timeout,
            BuildSshSession::connect(SSH_HOST, port, SSH_USERNAME, &ssh_key.private_key),
        ) {
            Ok(Ok(mut ssh)) => {
                match block_on_timeout(&runtime, attempt_timeout, ssh.run("true", false)) {
                    Ok(Ok(())) => break ssh,
                    Ok(Err(error)) => last_error = error,
                    Err(_) => {
                        last_error = anyhow::anyhow!("clean-base SSH readiness probe timed out")
                    }
                }
            }
            Ok(Err(error)) => last_error = error,
            Err(_) => last_error = anyhow::anyhow!("clean-base SSH connection attempt timed out"),
        }
        if Instant::now() >= deadline {
            return Err(last_error).context("timed out waiting for clean-base SSH");
        }
        thread::sleep(Duration::from_secs(2));
    };

    block_on_timeout(
        &runtime,
        SSH_OPERATION_TIMEOUT,
        session.run(GUEST_PROOF_COMMAND, false),
    )
    .context("clean-base guest absence proof timed out")?
    .context("clean-base guest identity or absence proof failed")?;
    block_on_timeout(
        &runtime,
        SSH_OPERATION_TIMEOUT,
        session.download_file_limited("/tmp/intar-clean-base-proof.json", guest_proof_path, 4096),
    )
    .context("clean-base guest proof download timed out")?
    .context("failed to download clean-base guest proof")?;
    block_on_timeout(
        &runtime,
        SSH_OPERATION_TIMEOUT,
        session.download_file_limited(
            "/tmp/intar-clean-base-packages.txt",
            inventory_path,
            MAX_INVENTORY_BYTES,
        ),
    )
    .context("clean-base package inventory download timed out")?
    .context("failed to download clean-base package inventory")?;
    let proof_bytes =
        fs::read(guest_proof_path).context("failed to read clean-base guest proof")?;
    ensure!(
        proof_bytes.len() <= 4096,
        "clean-base guest proof exceeds size limit"
    );
    let proof: GuestProof =
        serde_json::from_slice(&proof_bytes).context("clean-base guest proof is invalid")?;
    ensure!(
        proof.schema_version == 1
            && proof.debian_13
            && proof.x86_64
            && proof.dpkg_amd64
            && proof.ssh_ready
            && proof.forbidden_packages_absent
            && proof.forbidden_commands_absent
            && proof.forbidden_paths_absent,
        "clean-base guest proof contains a failed assertion"
    );
    Ok(proof)
}

fn error_after_qemu_cleanup(qemu: &mut Child, failure: anyhow::Error) -> anyhow::Error {
    let pid = qemu.id();
    match terminate_qemu(qemu) {
        Ok(status) => failure.context(format!(
            "QEMU pid {pid} was terminated and reaped with status {status}"
        )),
        Err(cleanup_error) => anyhow::anyhow!(
            "{failure:#}; additionally failed to terminate and reap QEMU pid {pid}: {cleanup_error:#}"
        ),
    }
}

fn terminate_qemu(qemu: &mut Child) -> Result<std::process::ExitStatus> {
    let pid = qemu.id();
    if let Err(kill_error) = qemu.kill() {
        return match qemu.try_wait() {
            Ok(Some(status)) => Ok(status),
            Ok(None) => Err(anyhow::Error::new(kill_error)
                .context(format!("failed to kill still-running QEMU pid {pid}"))),
            Err(poll_error) => Err(anyhow::anyhow!(
                "failed to kill QEMU pid {pid}: {kill_error}; failed to determine whether it exited: {poll_error}"
            )),
        };
    }
    qemu.wait()
        .with_context(|| format!("failed to reap QEMU pid {pid} after killing it"))
}

fn verify_ext4(binary: &Path, disk: &Path, label: &str) -> Result<()> {
    let status = Command::new(binary)
        .args(["-fn"])
        .arg(disk)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .with_context(|| format!("failed to run offline filesystem verification for {label}"))?;
    ensure!(
        status.success(),
        "offline filesystem verification failed for {label}: {status}"
    );
    Ok(())
}

fn copy_regular(source: &Path, destination: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(source)
        .with_context(|| format!("failed to stat '{}'", source.display()))?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "copy source is not a regular file: {}",
        source.display()
    );
    fs::copy(source, destination).with_context(|| {
        format!(
            "failed to copy '{}' to '{}'",
            source.display(),
            destination.display()
        )
    })?;
    Ok(())
}

fn published_files(payload: &Path) -> Result<Vec<PublishedFile>> {
    [RAW_FILE, KERNEL_FILE, INITRD_FILE, PACKAGE_INVENTORY_FILE]
        .into_iter()
        .map(|name| {
            let path = payload.join(name);
            Ok(PublishedFile {
                name: name.to_string(),
                sha256: sha256_file_hex(&path)?,
                size_bytes: fs::metadata(&path)?.len(),
            })
        })
        .collect()
}

fn write_checksums(payload: &Path) -> Result<()> {
    let mut lines = String::new();
    for name in [
        RAW_FILE,
        KERNEL_FILE,
        INITRD_FILE,
        PACKAGE_INVENTORY_FILE,
        PROOF_FILE,
    ] {
        lines.push_str(&format!(
            "{}  {name}\n",
            sha256_file_hex(&payload.join(name))?
        ));
    }
    fs::write(payload.join(CHECKSUMS_FILE), lines).context("failed to write clean-base checksums")
}

#[cfg(test)]
mod tests {
    use std::process::Command;
    use std::time::Duration;

    use super::{GUEST_PROOF_COMMAND, GuestProof, block_on_timeout, validate_artifact_file};

    #[test]
    fn timeout_enters_the_runtime_before_creating_the_timer() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("create test runtime");
        let value = block_on_timeout(&runtime, Duration::from_secs(1), async { 7_u8 })
            .expect("complete test future");
        assert_eq!(value, 7);
        let timed_out = block_on_timeout(&runtime, Duration::from_millis(1), async {
            tokio::time::sleep(Duration::from_secs(1)).await;
        });
        assert!(timed_out.is_err());
    }

    #[test]
    fn guest_proof_rejects_unknown_fields() {
        let proof = br#"{
          "schema_version":1,
          "debian_13":true,
          "x86_64":true,
          "dpkg_amd64":true,
          "ssh_ready":true,
          "forbidden_packages_absent":true,
          "forbidden_commands_absent":true,
          "forbidden_paths_absent":true,
          "unexpected":true
        }"#;
        assert!(serde_json::from_slice::<GuestProof>(proof).is_err());
    }

    #[test]
    fn artifact_bounds_are_enforced() {
        let directory = tempfile::tempdir().expect("create test directory");
        let path = directory.path().join("artifact");
        std::fs::write(&path, [0_u8; 4]).expect("write test artifact");
        assert!(validate_artifact_file(&path, 1, 4, "test").is_ok());
        assert!(validate_artifact_file(&path, 5, 8, "test").is_err());
    }

    #[test]
    fn guest_proof_command_has_valid_bash_syntax() {
        let directory = tempfile::tempdir().expect("create test directory");
        let path = directory.path().join("guest-proof.sh");
        std::fs::write(&path, GUEST_PROOF_COMMAND).expect("write guest proof script");
        let status = Command::new("bash")
            .args(["-n"])
            .arg(path)
            .status()
            .expect("run bash syntax check");
        assert!(status.success());
    }
}
