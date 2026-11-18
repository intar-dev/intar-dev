//! A small CLI to try `zpm` by hand and on a test host: it boots one machine
//! from files that are already on disk and stops it again.
//!
//! The desktop app ships its own QEMU and never takes one from `PATH`; this
//! tool does, unless `--qemu` says otherwise.

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{Duration, Instant};

use clap::Parser;
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
    /// More raw disks in the guest's order, the run disk first. `:ro` makes one read-only.
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
    #[arg(long)]
    vsock_cid: Option<u32>,
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

    std::fs::create_dir_all(&args.dir)?;
    let overlay = args.dir.join("root.qcow2");
    let _ = std::fs::remove_file(&overlay);
    create_overlay(&args.qemu_img, &args.root_base, &overlay)?;

    let mut disks = vec![Disk {
        path: overlay,
        format: DiskFormat::Qcow2,
        read_only: false,
    }];
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
    let mut vm = Vm::start(&qemu, &machine, &args.dir.join("qemu.log"))?;
    println!("started with {accel:?}; ssh on 127.0.0.1:{}", args.ssh_port);

    let end = Instant::now() + Duration::from_secs(args.seconds);
    while Instant::now() < end && vm.is_running() {
        std::thread::sleep(Duration::from_millis(200));
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
