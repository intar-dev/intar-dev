#![deny(unsafe_code)]

#[cfg(target_os = "linux")]
use std::fs::File;
#[cfg(target_os = "linux")]
use std::io::Read as _;
#[cfg(target_os = "linux")]
use std::os::fd::OwnedFd;
#[cfg(target_os = "linux")]
use std::os::unix::ffi::OsStrExt as _;
#[cfg(target_os = "linux")]
use std::os::unix::fs::MetadataExt as _;
#[cfg(target_os = "linux")]
use std::path::Path;
use std::path::PathBuf;
#[cfg(target_os = "linux")]
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
#[cfg(target_os = "linux")]
use std::time::Duration;

#[cfg(target_os = "linux")]
use anyhow::Context as _;
use anyhow::{Result, bail};
use clap::{Parser, Subcommand};
#[cfg(target_os = "linux")]
use intar_jailer_protocol::{
    CpuQuota, JailerdConfig, MAX_FRAME_BYTES, PROTOCOL_VERSION, ProtocolError, Request,
    RequestEnvelope, Response, ResponseEnvelope, ValidatedId,
};
#[cfg(target_os = "linux")]
use intar_jailerd::{
    BootCpuGuardianRequest, FileSystemJailPreparer, HostReadiness, JailerdCore, SystemdHostBackend,
    host_cpu_capacity_millis, launch_vm_v2_response, prepare_image_v2_response,
    run_boot_cpu_guardian, self_test,
};
#[cfg(target_os = "linux")]
use rustix::net::{
    AddressFamily, RecvFlags, SendFlags, SocketAddrUnix, SocketFlags, SocketType, accept_with,
    bind, listen, recv, send, socket_with,
};
#[cfg(target_os = "linux")]
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

#[cfg(target_os = "linux")]
const MAINTENANCE_LOCK_PATH: &str = "/run/intar-jailerd/maintenance.lock";
#[cfg(target_os = "linux")]
const MAX_CLIENT_CONNECTIONS: usize = 32;
#[cfg(target_os = "linux")]
const CLIENT_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(target_os = "linux")]
const BOOT_LEASE_WATCHDOG_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug, Parser)]
#[command(name = "intar-jailerd")]
#[command(about = "Root-owned Intar VM isolation supervisor")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Run {
        #[arg(long, default_value = "/etc/intar-jailerd/config.toml")]
        config: PathBuf,
    },
    SelfTest {
        #[arg(long, default_value = "/etc/intar-jailerd/config.toml")]
        config: PathBuf,
        #[arg(long)]
        kernel: PathBuf,
        #[arg(long)]
        kernel_sha256: String,
        #[arg(long, requires = "initrd_sha256")]
        initrd: Option<PathBuf>,
        #[arg(long, requires = "initrd")]
        initrd_sha256: Option<String>,
        #[arg(long)]
        root_disk: PathBuf,
        #[arg(long)]
        root_disk_sha256: String,
        #[arg(long)]
        runtime_disk: PathBuf,
        #[arg(long)]
        runtime_disk_sha256: String,
        #[arg(long)]
        recording_disk: PathBuf,
        #[arg(long)]
        recording_disk_sha256: String,
    },
    #[command(hide = true)]
    SelfTestWorker {
        #[arg(long)]
        report: PathBuf,
        #[arg(long)]
        allowed_dir: PathBuf,
        #[arg(long)]
        denied_path: PathBuf,
    },
    #[command(hide = true)]
    SelfTestAgentApiWorker {
        #[arg(long)]
        socket: PathBuf,
        #[arg(long)]
        expected_uid: u32,
        #[arg(long)]
        expected_gid: u32,
    },
    #[command(hide = true)]
    BootCpuLeaseGuardian {
        #[arg(long)]
        generation: String,
        #[arg(long)]
        unit_name: String,
        #[arg(long)]
        steady_cpu_millis: u32,
        #[arg(long)]
        deadline_uptime_millis: u64,
    },
}

fn main() {
    if let Err(error) = run() {
        eprintln!("intar-jailerd: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let cli = Cli::parse();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    #[cfg(not(target_os = "linux"))]
    {
        let _ = cli;
        bail!("intar-jailerd is supported only on Linux")
    }
    #[cfg(target_os = "linux")]
    match cli.command {
        Command::Run { config } => run_server(&config),
        Command::SelfTest {
            config,
            kernel,
            kernel_sha256,
            initrd,
            initrd_sha256,
            root_disk,
            root_disk_sha256,
            runtime_disk,
            runtime_disk_sha256,
            recording_disk,
            recording_disk_sha256,
        } => run_self_test(
            &config,
            SelfTestCliArtifacts {
                kernel,
                kernel_sha256,
                initrd,
                initrd_sha256,
                root_disk,
                root_disk_sha256,
                runtime_disk,
                runtime_disk_sha256,
                recording_disk,
                recording_disk_sha256,
            },
        ),
        Command::SelfTestWorker {
            report,
            allowed_dir,
            denied_path,
        } => self_test::worker(&report, &allowed_dir, &denied_path),
        Command::SelfTestAgentApiWorker {
            socket,
            expected_uid,
            expected_gid,
        } => self_test::agent_api_worker(&socket, expected_uid, expected_gid),
        Command::BootCpuLeaseGuardian {
            generation,
            unit_name,
            steady_cpu_millis,
            deadline_uptime_millis,
        } => {
            require_root()?;
            let generation =
                ValidatedId::parse(generation).context("validate guardian generation")?;
            let steady_quota = CpuQuota::from_millis(steady_cpu_millis)
                .context("validate guardian steady CPU quota")?;
            let request = BootCpuGuardianRequest::new(
                generation,
                unit_name,
                steady_quota,
                deadline_uptime_millis,
            )?;
            run_boot_cpu_guardian(request)
        }
    }
}

#[cfg(target_os = "linux")]
fn run_server(config_path: &Path) -> Result<()> {
    require_root()?;
    // Install, uninstall and the destructive self-test take this lock
    // exclusively. Keeping a shared descriptor for the entire daemon lifetime
    // makes those operations mutually exclusive with every control request.
    let _maintenance_lock = acquire_maintenance_lock(rustix::fs::FlockOperation::LockShared)
        .context("acquire daemon maintenance lock")?;
    let config = load_config(config_path)?;
    // Absence leaves the host deliberately unschedulable.  A present but
    // malformed, stale, tampered, or wrong-boot attestation is a startup
    // error, rather than being silently treated like an operator who has not
    // run the proof yet.
    let verified_self_test =
        self_test::load_verified(&config).context("verify privileged self-test attestation")?;
    let listener = match activated_socket::take()? {
        Some(listener) => {
            info!("using systemd-activated control socket");
            listener
        }
        None => bind_control_socket(&config)?,
    };
    validate_control_listener(&listener, &config.socket_path)?;
    let total_cpu_millis = host_cpu_capacity_millis()?;
    let backend = SystemdHostBackend::connect(&config)?;
    let mut readiness = HostReadiness::probe(&config, config_path);
    readiness.landlock_abi = verified_self_test.as_ref().map(|value| value.landlock_abi);
    readiness.privileged_self_test_passed = verified_self_test.as_ref().is_some_and(|value| {
        value.quota_verified
            && value.burst_verified
            && value.boot_quota_transition_verified
            && value.network_verified
            && value.landlock_negative_access
            && value.cloud_hypervisor_lifecycle_verified
    });
    readiness.kvm_accounting_proven = verified_self_test
        .as_ref()
        .is_some_and(|value| value.kvm_accounting_proven);
    let core = Arc::new(Mutex::new(JailerdCore::new_with_readiness(
        config.clone(),
        backend,
        FileSystemJailPreparer::default(),
        total_cpu_millis,
        readiness,
    )?));
    let watchdog_core = Arc::clone(&core);
    std::thread::Builder::new()
        .name("jailerd-boot-lease-watchdog".to_owned())
        .spawn(move || {
            loop {
                std::thread::sleep(BOOT_LEASE_WATCHDOG_INTERVAL);
                match watchdog_core.lock() {
                    Ok(mut core) => match core.enforce_boot_deadlines() {
                        Ok(sealed) if sealed > 0 => {
                            info!(sealed, "sealed expired VM boot CPU leases")
                        }
                        Ok(_) => {}
                        Err(error) => error!(?error, "boot CPU lease watchdog failed"),
                    },
                    Err(_) => {
                        error!("jailerd state lock poisoned; boot CPU lease watchdog exiting");
                        return;
                    }
                }
            }
        })
        .context("spawn boot CPU lease watchdog")?;
    info!(
        socket = %config.socket_path.display(),
        total_cpu_millis,
        "jailerd control service ready"
    );
    let active_clients = Arc::new(AtomicUsize::new(0));

    loop {
        let connection = accept_with(&listener, SocketFlags::CLOEXEC)
            .context("accept jailerd control connection")?;
        let credentials = rustix::net::sockopt::socket_peercred(&connection)
            .context("authenticate control peer")?;
        if credentials.uid.as_raw() != config.agent_uid {
            warn!(
                peer_uid = credentials.uid.as_raw(),
                expected_uid = config.agent_uid,
                "rejected jailerd control peer"
            );
            continue;
        }
        let Some(client_slot) = ClientSlot::try_acquire(Arc::clone(&active_clients)) else {
            warn!(
                maximum = MAX_CLIENT_CONNECTIONS,
                "rejected jailerd control peer because the connection limit is reached"
            );
            continue;
        };
        rustix::net::sockopt::set_socket_timeout(
            &connection,
            rustix::net::sockopt::Timeout::Recv,
            Some(CLIENT_IDLE_TIMEOUT),
        )
        .context("set jailerd client receive timeout")?;
        rustix::net::sockopt::set_socket_timeout(
            &connection,
            rustix::net::sockopt::Timeout::Send,
            Some(CLIENT_IDLE_TIMEOUT),
        )
        .context("set jailerd client send timeout")?;
        let core = Arc::clone(&core);
        std::thread::Builder::new()
            .name("jailerd-client".to_owned())
            .spawn(move || {
                let _client_slot = client_slot;
                if let Err(error) = serve_connection(connection, &core) {
                    error!(?error, "jailerd control connection failed");
                }
            })
            .context("spawn jailerd client worker")?;
    }
}

#[cfg(target_os = "linux")]
struct ClientSlot(Arc<AtomicUsize>);

#[cfg(target_os = "linux")]
impl ClientSlot {
    fn try_acquire(active: Arc<AtomicUsize>) -> Option<Self> {
        active
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                (current < MAX_CLIENT_CONNECTIONS).then_some(current + 1)
            })
            .ok()
            .map(|_| Self(active))
    }
}

#[cfg(target_os = "linux")]
impl Drop for ClientSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

#[cfg(target_os = "linux")]
fn serve_connection(
    connection: OwnedFd,
    core: &Arc<Mutex<JailerdCore<SystemdHostBackend, FileSystemJailPreparer>>>,
) -> Result<()> {
    let mut buffer = vec![0_u8; MAX_FRAME_BYTES + 1];
    loop {
        let (_, length) = recv(&connection, &mut buffer, RecvFlags::TRUNC)
            .context("receive jailerd request packet")?;
        if length == 0 {
            return Ok(());
        }
        let (request_id, response) = if length > MAX_FRAME_BYTES {
            (
                0,
                Response::Error(ProtocolError::new(
                    "frame_too_large",
                    format!("protocol packets are limited to {MAX_FRAME_BYTES} bytes"),
                )),
            )
        } else {
            match RequestEnvelope::decode(&buffer[..length]) {
                Ok(envelope) if envelope.version == PROTOCOL_VERSION => {
                    let response = match envelope.request {
                        Request::PrepareImageV2(request) => {
                            // Importing and hashing a raw image can take many
                            // seconds. Snapshot the root-owned policy under the
                            // lifecycle lock, then release it so the boot-lease
                            // watchdog and VM finalization remain responsive.
                            let config = core
                                .lock()
                                .map_err(|_| anyhow::anyhow!("jailerd state lock poisoned"))?
                                .template_prepare_config();
                            config.map_or_else(
                                || {
                                    Response::Error(ProtocolError::new(
                                        "host_not_ready",
                                        "host readiness attestation does not permit template-backed image preparation",
                                    ))
                                },
                                |config| prepare_image_v2_response(&config, *request),
                            )
                        }
                        Request::LaunchVmV2(request) => launch_vm_v2_response(core, *request),
                        request => core
                            .lock()
                            .map_err(|_| anyhow::anyhow!("jailerd state lock poisoned"))?
                            .handle(request),
                    };
                    (envelope.request_id, response)
                }
                Ok(envelope) => (
                    envelope.request_id,
                    Response::Error(ProtocolError::new(
                        "unsupported_protocol_version",
                        format!("expected {PROTOCOL_VERSION}, got {}", envelope.version),
                    )),
                ),
                Err(error) => (
                    0,
                    Response::Error(ProtocolError::new("invalid_frame", error.to_string())),
                ),
            }
        };
        let packet = ResponseEnvelope::new(request_id, response).encode()?;
        let written = send(&connection, &packet, SendFlags::NOSIGNAL)
            .context("send jailerd response packet")?;
        if written != packet.len() {
            bail!("SOCK_SEQPACKET response was unexpectedly truncated")
        }
    }
}

#[cfg(target_os = "linux")]
fn bind_control_socket(config: &JailerdConfig) -> Result<OwnedFd> {
    use std::os::unix::fs::FileTypeExt as _;

    let parent = config
        .socket_path
        .parent()
        .context("control socket parent")?;
    std::fs::create_dir_all(parent).context("create control socket directory")?;
    let mut ancestor = Some(parent);
    while let Some(directory) = ancestor {
        let metadata = std::fs::symlink_metadata(directory)
            .with_context(|| format!("stat control socket ancestor {}", directory.display()))?;
        if !metadata.is_dir() || metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
            bail!(
                "control socket has an untrusted ancestor {}",
                directory.display()
            )
        }
        ancestor = directory.parent();
    }
    let parent_fd = rustix::fs::open(
        parent,
        rustix::fs::OFlags::RDONLY
            | rustix::fs::OFlags::DIRECTORY
            | rustix::fs::OFlags::CLOEXEC
            | rustix::fs::OFlags::NOFOLLOW,
        rustix::fs::Mode::empty(),
    )
    .context("open trusted control socket directory")?;
    let socket_name = config
        .socket_path
        .file_name()
        .context("control socket has no file name")?;
    if let Ok(metadata) = std::fs::symlink_metadata(&config.socket_path) {
        if !metadata.file_type().is_socket() || metadata.uid() != 0 || metadata.nlink() != 1 {
            bail!(
                "refusing to replace untrusted control socket path {}",
                config.socket_path.display()
            )
        }
        rustix::fs::unlinkat(&parent_fd, socket_name, rustix::fs::AtFlags::empty())
            .context("remove stale control socket relative to trusted directory")?;
        rustix::fs::fsync(&parent_fd).context("sync stale control socket removal")?;
    }
    let listener = socket_with(
        AddressFamily::UNIX,
        SocketType::SEQPACKET,
        SocketFlags::CLOEXEC,
        None,
    )?;
    let address = SocketAddrUnix::new(&config.socket_path)?;
    bind(&listener, &address).context("bind jailerd control socket")?;
    listen(&listener, 128).context("listen on jailerd control socket")?;
    rustix::fs::chmod(
        &config.socket_path,
        rustix::fs::Mode::RUSR
            | rustix::fs::Mode::WUSR
            | rustix::fs::Mode::RGRP
            | rustix::fs::Mode::WGRP,
    )
    .context("set control socket mode")?;
    rustix::fs::chown(
        &config.socket_path,
        Some(rustix::process::Uid::ROOT),
        Some(rustix::process::Gid::from_raw(config.agent_gid)),
    )
    .context("set control socket owner")?;
    let metadata = std::fs::symlink_metadata(&config.socket_path)
        .context("verify published control socket")?;
    if !metadata.file_type().is_socket()
        || metadata.uid() != 0
        || metadata.gid() != config.agent_gid
        || metadata.mode() & 0o777 != 0o660
        || metadata.nlink() != 1
    {
        bail!("published control socket metadata is invalid")
    }
    Ok(listener)
}

#[cfg(target_os = "linux")]
fn validate_control_listener(listener: &OwnedFd, expected_path: &Path) -> Result<()> {
    if rustix::net::sockopt::socket_type(listener)? != SocketType::SEQPACKET {
        bail!("control listener is not SOCK_SEQPACKET")
    }
    if !rustix::net::sockopt::socket_acceptconn(listener)? {
        bail!("control socket is not in listening state")
    }
    let address = SocketAddrUnix::try_from(rustix::net::getsockname(listener)?)
        .context("control listener is not bound to a Unix address")?;
    if address.path_bytes() != Some(expected_path.as_os_str().as_bytes()) {
        bail!(
            "control listener path does not match configured socket {}",
            expected_path.display()
        )
    }
    Ok(())
}

#[cfg(target_os = "linux")]
struct SelfTestCliArtifacts {
    kernel: PathBuf,
    kernel_sha256: String,
    initrd: Option<PathBuf>,
    initrd_sha256: Option<String>,
    root_disk: PathBuf,
    root_disk_sha256: String,
    runtime_disk: PathBuf,
    runtime_disk_sha256: String,
    recording_disk: PathBuf,
    recording_disk_sha256: String,
}

#[cfg(target_os = "linux")]
impl SelfTestCliArtifacts {
    fn into_artifacts(self) -> Result<self_test::SelfTestArtifacts> {
        let initrd = match (self.initrd, self.initrd_sha256) {
            (None, None) => None,
            (Some(path), Some(sha256)) => Some(self_test::VerifiedArtifact { path, sha256 }),
            _ => anyhow::bail!("--initrd and --initrd-sha256 must be supplied together"),
        };
        Ok(self_test::SelfTestArtifacts {
            kernel: self_test::VerifiedArtifact {
                path: self.kernel,
                sha256: self.kernel_sha256,
            },
            initrd,
            root_disk: self_test::VerifiedArtifact {
                path: self.root_disk,
                sha256: self.root_disk_sha256,
            },
            runtime_disk: self_test::VerifiedArtifact {
                path: self.runtime_disk,
                sha256: self.runtime_disk_sha256,
            },
            recording_disk: self_test::VerifiedArtifact {
                path: self.recording_disk,
                sha256: self.recording_disk_sha256,
            },
        })
    }
}

#[cfg(target_os = "linux")]
fn run_self_test(config_path: &Path, artifacts: SelfTestCliArtifacts) -> Result<()> {
    require_root()?;
    let _maintenance_lock = acquire_maintenance_lock(
        rustix::fs::FlockOperation::NonBlockingLockExclusive,
    )
    .context(
        "acquire exclusive maintenance lock; stop intar-jailerd.service before running self-test",
    )?;
    let config = load_config(config_path)?;
    let artifacts = artifacts.into_artifacts()?;
    let attestation = self_test::run(&config, &artifacts)?;
    println!("{}", serde_json::to_string_pretty(&attestation)?);
    Ok(())
}

#[cfg(target_os = "linux")]
fn acquire_maintenance_lock(operation: rustix::fs::FlockOperation) -> Result<File> {
    let path = Path::new(MAINTENANCE_LOCK_PATH);
    let parent = path.parent().context("maintenance lock parent")?;
    std::fs::create_dir_all(parent).context("create maintenance lock directory")?;
    let parent_metadata =
        std::fs::symlink_metadata(parent).context("stat maintenance lock directory")?;
    if !parent_metadata.is_dir()
        || parent_metadata.uid() != 0
        || parent_metadata.mode() & 0o022 != 0
    {
        bail!("maintenance lock directory must be root-owned and not group/other writable")
    }

    let fd = rustix::fs::open(
        path,
        rustix::fs::OFlags::RDWR
            | rustix::fs::OFlags::CREATE
            | rustix::fs::OFlags::CLOEXEC
            | rustix::fs::OFlags::NOFOLLOW,
        rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
    )
    .context("open maintenance lock")?;
    let file = File::from(fd);
    let metadata = file.metadata().context("stat maintenance lock")?;
    if !metadata.is_file()
        || metadata.uid() != 0
        || metadata.mode() & 0o777 != 0o600
        || metadata.nlink() != 1
    {
        bail!("maintenance lock must be a root-owned private regular file with one link")
    }
    rustix::fs::flock(&file, operation).context("lock maintenance boundary")?;
    Ok(file)
}

#[cfg(target_os = "linux")]
fn require_root() -> Result<()> {
    if rustix::process::geteuid() != rustix::process::Uid::ROOT {
        bail!("intar-jailerd must run as root")
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn load_config(path: &Path) -> Result<JailerdConfig> {
    if !path.is_absolute() {
        bail!("jailerd config path must be absolute")
    }
    let mut ancestor = path.parent();
    while let Some(directory) = ancestor {
        let metadata = std::fs::symlink_metadata(directory)
            .with_context(|| format!("stat config ancestor {}", directory.display()))?;
        if !metadata.is_dir() || metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
            bail!(
                "jailerd config has an untrusted ancestor {}",
                directory.display()
            )
        }
        ancestor = directory.parent();
    }
    let fd = rustix::fs::open(
        path,
        rustix::fs::OFlags::RDONLY | rustix::fs::OFlags::CLOEXEC | rustix::fs::OFlags::NOFOLLOW,
        rustix::fs::Mode::empty(),
    )
    .with_context(|| format!("open config {}", path.display()))?;
    let mut file = File::from(fd);
    let metadata = file
        .metadata()
        .with_context(|| format!("stat opened config {}", path.display()))?;
    let mode = metadata.mode() & 0o777;
    if !metadata.file_type().is_file()
        || metadata.uid() != 0
        || !matches!(mode, 0o400 | 0o600)
        || metadata.nlink() != 1
    {
        bail!("jailerd config must be a root-owned 0400/0600 regular file with one link")
    }
    let mut source = String::new();
    file.read_to_string(&mut source)
        .context("read jailerd config")?;
    let config: JailerdConfig = toml::from_str(&source).context("parse jailerd config")?;
    config.validate().context("validate jailerd config")?;
    Ok(config)
}

/// Systemd owns descriptor 3 after a valid socket activation handoff. This
/// module is the only unsafe code in the crate: converting that already-owned
/// descriptor into Rust ownership cannot be expressed by the safe std API.
#[cfg(target_os = "linux")]
#[allow(unsafe_code)]
mod activated_socket {
    use std::os::fd::{FromRawFd as _, OwnedFd};

    use anyhow::{Context as _, Result, bail};

    pub fn take() -> Result<Option<OwnedFd>> {
        let Some(pid) = std::env::var_os("LISTEN_PID") else {
            return Ok(None);
        };
        let pid: u32 = pid.to_string_lossy().parse().context("parse LISTEN_PID")?;
        if pid != std::process::id() {
            return Ok(None);
        }
        let count: u32 = std::env::var("LISTEN_FDS")
            .context("LISTEN_FDS missing")?
            .parse()
            .context("parse LISTEN_FDS")?;
        if count != 1 {
            bail!("intar-jailerd requires exactly one socket-activation FD")
        }
        // SAFETY: systemd guarantees that the first and only descriptor starts
        // at 3 and transfers ownership to this process. We validate PID/count
        // above and construct exactly one owner.
        let fd = unsafe { OwnedFd::from_raw_fd(3) };
        if rustix::net::sockopt::socket_type(&fd)? != rustix::net::SocketType::SEQPACKET {
            bail!("socket-activation FD is not SOCK_SEQPACKET")
        }
        Ok(Some(fd))
    }
}
