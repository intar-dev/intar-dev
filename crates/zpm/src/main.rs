//! A small CLI to try `zpm` by hand and on a test host: it boots one machine
//! from files that are already on disk and stops it again.
//!
//! The desktop app ships its own QEMU and never takes one from `PATH`; this
//! tool does, unless `--qemu` says otherwise.

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{Duration, Instant};

use clap::Parser;
use zpm::rundisk::{Boot, boot_json, write_recording_disk, write_run_disk};
use zpm::{Accel, Arch, Disk, DiskFormat, Machine, UserNetwork, Vm, create_overlay};

#[derive(Parser)]
#[command(about = "Boot one machine under QEMU and stop it again")]
struct Args {
    /// Where the run's files go: the root overlay, the logs, the control socket.
    #[arg(long)]
    dir: PathBuf,
    #[arg(long)]
    kernel: PathBuf,
    #[arg(long)]
    initrd: Option<PathBuf>,
    /// The machine image's raw root disk; the run writes to an overlay on it.
    #[arg(long)]
    root_base: PathBuf,
    /// The machine's spec blob. With `--kino` and `--ssh-key`, zpm writes the
    /// run disk and the recordings disk itself.
    #[arg(long, requires_all = ["kino", "ssh_key"])]
    spec: Option<PathBuf>,
    /// The Kino binary for the run disk.
    #[arg(long)]
    kino: Option<PathBuf>,
    /// An OpenSSH public key file that may log in to the guest.
    #[arg(long)]
    ssh_key: Option<PathBuf>,
    /// More raw disks in the guest's order, after the ones zpm writes. `:ro` makes one read-only.
    #[arg(long = "disk")]
    disks: Vec<String>,
    #[arg(
        long,
        default_value = "root=/dev/vda rw console=ttyS0 quiet loglevel=4 systemd.show_status=false"
    )]
    cmdline: String,
    #[arg(long, default_value_t = 1)]
    cpus: u32,
    #[arg(long, default_value_t = 512)]
    memory: u64,
    #[arg(long, default_value_t = 2252)]
    ssh_port: u16,
    /// The guest's AF_VSOCK id for Kino's reports (Linux).
    #[arg(long, conflicts_with = "tcp")]
    vsock_cid: Option<u32>,
    /// Take Kino's reports over TCP instead, as on a host without vsock.
    #[arg(long)]
    tcp: bool,
    /// With `--tcp`: answer every run CLI command with this response file (a test stand-in for intar).
    #[arg(long, requires = "tcp")]
    canned_run_cli: Option<PathBuf>,
    /// The machine image's architecture; this computer's by default.
    #[arg(long)]
    arch: Option<String>,
    /// Run without hardware acceleration. Slow; for tests only.
    #[arg(long)]
    emulate: bool,
    #[arg(long)]
    qemu: Option<PathBuf>,
    #[arg(long, default_value = "qemu-img")]
    qemu_img: PathBuf,
    /// Stop the machine after this many seconds.
    #[arg(long, default_value_t = 60)]
    seconds: u64,
}

fn run(args: Args) -> Result<(), zpm::Error> {
    let arch = match &args.arch {
        Some(name) => Arch::parse(name),
        None => Arch::host(),
    }
    .ok_or_else(|| zpm::Error::Qemu("no machine images exist for this architecture".into()))?;
    let accel = if args.emulate {
        Accel::Tcg
    } else {
        Accel::detect(arch)?
    };

    // The overlay and the two small disks; the image itself is already on disk.
    let needs = zpm::preflight::Needs {
        cpus: args.cpus,
        memory_mib: args.memory,
        disk_mib: 256,
    };
    zpm::preflight::check(&needs, &zpm::preflight::Has::measure(&args.dir))?;
    std::fs::create_dir_all(&args.dir)?;
    let overlay = args.dir.join("root.qcow2");
    let _ = std::fs::remove_file(&overlay);
    create_overlay(&args.qemu_img, &args.root_base, &overlay)?;

    // Listen before the guest exists, so its first report is not missed.
    let (tcp_reports, run_cli) = if args.tcp {
        let canned: Option<intar_contracts::run_cli::RunCliResponseV1> = match &args.canned_run_cli
        {
            Some(path) => Some(
                serde_json::from_slice(&std::fs::read(path)?).map_err(|error| {
                    zpm::Error::Qemu(format!(
                        "the canned run CLI response is unreadable: {error}"
                    ))
                })?,
            ),
            None => None,
        };
        let broker = zpm::broker::serve_tcp(move |request| {
            let mut response = canned.clone()?;
            response.request_id.clone_from(&request.request_id);
            Some(response)
        })?;
        (Some(zpm::reports::listen_tcp()?), Some(broker))
    } else {
        (None, None)
    };
    let mut disks = vec![Disk {
        path: overlay,
        format: DiskFormat::Qcow2,
        read_only: false,
    }];
    if let (Some(spec), Some(kino), Some(ssh_key)) = (&args.spec, &args.kino, &args.ssh_key) {
        // Kino dials the gateway address, which QEMU maps to this computer's loopback.
        let host = match (&tcp_reports, &run_cli) {
            (Some(reports), Some(run_cli)) => Some(intar_contracts::guest::GuestHostV3::Tcp {
                address: "10.77.52.1".to_owned(),
                report_port: reports.port,
                run_cli_port: run_cli.port,
            }),
            _ => None,
        };
        let json = boot_json(&Boot {
            hostname: "zpm",
            ip_cidr: "10.77.52.2/28",
            gateway: "10.77.52.1",
            dns: &["10.77.52.3".to_owned()],
            peers: &Default::default(),
            authorized_keys: &[std::fs::read_to_string(ssh_key)?],
            spec: &std::fs::read(spec)?,
            host,
        })?;
        let run_disk = args.dir.join("run.raw");
        write_run_disk(&run_disk, &json, &std::fs::read(kino)?)?;
        let recordings = args.dir.join("rec.vfat");
        write_recording_disk(&recordings)?;
        disks.push(Disk {
            path: run_disk,
            format: DiskFormat::Raw,
            read_only: true,
        });
        disks.push(Disk {
            path: recordings,
            format: DiskFormat::Raw,
            read_only: false,
        });
    }
    for disk in &args.disks {
        let (path, read_only) = match disk.strip_suffix(":ro") {
            Some(path) => (path, true),
            None => (disk.as_str(), false),
        };
        disks.push(Disk {
            path: path.into(),
            format: DiskFormat::Raw,
            read_only,
        });
    }
    let machine = Machine {
        arch,
        accel,
        cpus: args.cpus,
        memory_mib: args.memory,
        kernel: args.kernel,
        initrd: args.initrd,
        cmdline: args.cmdline,
        disks,
        // The addresses the boot spike's run disk names.
        network: UserNetwork {
            network: "10.77.52.0/28".into(),
            gateway: "10.77.52.1".into(),
            dns: "10.77.52.3".into(),
            guest: "10.77.52.2".into(),
            mac: "02:00:00:00:34:02".into(),
        },
        ssh_port: args.ssh_port,
        vsock_cid: args.vsock_cid,
        serial_log: args.dir.join("serial.log"),
        qmp_socket: args.dir.join("qmp.sock"),
    };
    let qemu = args.qemu.unwrap_or_else(|| arch.qemu_binary().into());
    #[cfg(target_os = "linux")]
    let mut vsock_reports = match args.vsock_cid {
        Some(_) => Some(zpm::reports::listen_vsock()?),
        None => None,
    };
    let started = Instant::now();
    let mut vm = Vm::start(&qemu, &machine, &args.dir.join("qemu.log"))?;
    println!("started with {accel:?}; ssh on 127.0.0.1:{}", args.ssh_port);

    let end = started + Duration::from_secs(args.seconds);
    let (mut ssh_seen, mut lab_seen) = (false, None);
    let mut show = |report: zpm::reports::GuestReport| {
        let ms = started.elapsed().as_millis();
        if let Some(reason) = &report.failed {
            println!("guest failed after {ms} ms: {reason}");
        }
        if report.ssh_ready && !ssh_seen {
            ssh_seen = true;
            println!("ssh ready after {ms} ms");
        }
        if lab_seen.as_ref() != Some(&report.lab.state) {
            println!(
                "lab {:?} after {ms} ms, {} task(s)",
                report.lab.state,
                report.lab.tasks.len()
            );
            lab_seen = Some(report.lab.state);
        }
    };
    while Instant::now() < end && vm.is_running() {
        #[cfg(target_os = "linux")]
        while let Some(Ok((cid, report))) = vsock_reports.as_mut().map(|reports| reports.try_recv())
        {
            // Reports of another machine on this computer are not this run's.
            if Some(cid) == args.vsock_cid {
                show(report);
            }
        }
        while let Some(Ok(report)) = tcp_reports
            .as_ref()
            .map(|listener| listener.reports.try_recv())
        {
            show(report);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let ran_to_the_end = vm.is_running();
    vm.stop(Duration::from_secs(5));
    println!(
        "{}",
        if ran_to_the_end {
            "stopped"
        } else {
            "the machine stopped by itself"
        }
    );
    Ok(())
}

fn main() -> ExitCode {
    match run(Args::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("zpm: {error}");
            ExitCode::FAILURE
        }
    }
}
