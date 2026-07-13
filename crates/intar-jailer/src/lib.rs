#![deny(unsafe_code)]

#[cfg(target_os = "linux")]
use std::fs::File;
#[cfg(any(target_os = "linux", test))]
use std::fs::Metadata;
#[cfg(target_os = "linux")]
use std::io::Read as _;
#[cfg(any(target_os = "linux", test))]
use std::os::unix::fs::MetadataExt as _;
#[cfg(target_os = "linux")]
use std::path::Path;

#[cfg(target_os = "linux")]
use anyhow::Context as _;
use anyhow::{Result, bail};
use clap::Parser;
#[cfg(target_os = "linux")]
use intar_jailer_protocol::JailSpecV1;
#[cfg(target_os = "linux")]
use rustix::fs::{AtFlags, Mode, OFlags, ResolveFlags, open, openat2, unlinkat};

#[cfg(any(target_os = "linux", test))]
const CLOUD_HYPERVISOR_ARGS: [&str; 4] = [
    "--api-socket",
    "/run/cloud-hypervisor.sock",
    "--seccomp",
    "true",
];

#[derive(Debug, Parser)]
#[command(name = "intar-jailer")]
#[command(about = "Single-use Cloud Hypervisor isolation boundary")]
struct Cli {
    #[arg(long, value_name = "PATH", required_unless_present = "stage2")]
    spec: Option<std::path::PathBuf>,
    #[arg(long, hide = true)]
    stage2: bool,
    #[arg(long, hide = true, requires = "stage2")]
    uid: Option<u32>,
    #[arg(long, hide = true, requires = "stage2")]
    gid: Option<u32>,
}

pub fn run() -> Result<()> {
    let cli = Cli::parse();
    #[cfg(target_os = "linux")]
    {
        if cli.stage2 {
            return linux::run_stage2(
                cli.uid.context("stage2 requires --uid")?,
                cli.gid.context("stage2 requires --gid")?,
            );
        }
        linux::run_stage1(&cli.spec.context("--spec is required")?)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = cli;
        bail!("intar-jailer is supported only on Linux")
    }
}

#[cfg(target_os = "linux")]
fn load_root_owned_spec(path: &Path) -> Result<JailSpecV1> {
    if !path.is_absolute() {
        bail!("jail spec path must be absolute")
    }
    let fd = open(
        path,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .with_context(|| format!("open jail spec {}", path.display()))?;
    let mut file = File::from(fd);
    validate_spec_metadata(&file.metadata().context("stat jail spec")?)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).context("read jail spec")?;
    if bytes.len() > intar_jailer_protocol::MAX_FRAME_BYTES {
        bail!("jail spec exceeds protocol frame limit")
    }
    let spec: JailSpecV1 = serde_json::from_slice(&bytes).context("parse jail spec")?;
    spec.validate().context("validate jail spec")?;
    unlink_consumed_spec(path, &spec, &file)?;
    Ok(spec)
}

#[cfg(target_os = "linux")]
fn unlink_consumed_spec(path: &Path, spec: &JailSpecV1, opened: &File) -> Result<()> {
    let generation_dir = spec
        .jail_root
        .parent()
        .context("jail root has no generation directory")?;
    if spec.jail_root.file_name().and_then(|name| name.to_str()) != Some("root")
        || path.parent() != Some(generation_dir)
        || path.file_name().and_then(|name| name.to_str()) != Some("jail-spec-v1.json")
    {
        bail!("jail spec path does not match its declared jail root")
    }
    let directory_fd = open(
        generation_dir,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .context("open jail generation directory")?;
    let directory_metadata = File::from(directory_fd.try_clone()?).metadata()?;
    if !directory_metadata.is_dir()
        || directory_metadata.uid() != 0
        || directory_metadata.mode() & 0o022 != 0
    {
        bail!("jail generation directory is not trusted")
    }
    let verified_fd = openat2(
        &directory_fd,
        "jail-spec-v1.json",
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
        ResolveFlags::BENEATH
            | ResolveFlags::NO_SYMLINKS
            | ResolveFlags::NO_MAGICLINKS
            | ResolveFlags::NO_XDEV,
    )
    .context("reopen jail spec relative to trusted generation")?;
    let expected = opened.metadata()?;
    let actual = File::from(verified_fd).metadata()?;
    if expected.dev() != actual.dev() || expected.ino() != actual.ino() {
        bail!("jail spec changed before consumption")
    }
    unlinkat(&directory_fd, "jail-spec-v1.json", AtFlags::empty())
        .context("unlink consumed jail spec")?;
    rustix::fs::fsync(&directory_fd).context("sync consumed jail spec directory")?;
    Ok(())
}

#[cfg(any(target_os = "linux", test))]
fn validate_spec_metadata(metadata: &Metadata) -> Result<()> {
    if !metadata.file_type().is_file() {
        bail!("jail spec must be a regular file")
    }
    if metadata.uid() != 0 {
        bail!("jail spec must be owned by root")
    }
    if metadata.mode() & 0o777 != 0o600 {
        bail!("jail spec must have mode 0600")
    }
    if metadata.nlink() != 1 {
        bail!("jail spec must have exactly one link")
    }
    Ok(())
}

#[cfg(target_os = "linux")]
mod linux {
    use std::fs::{File, OpenOptions};
    use std::io::ErrorKind;
    use std::os::fd::OwnedFd;
    use std::os::unix::fs::{FileTypeExt as _, MetadataExt as _};
    use std::os::unix::process::ExitStatusExt as _;
    use std::path::Path;
    use std::process::{Command, Stdio};

    use anyhow::{Context as _, Result, bail, ensure};
    use intar_jailer_protocol::JailSpecV1;
    use landlock::{
        ABI, Access as _, AccessFs, BitFlags, CompatLevel, Compatible as _, LandlockStatus,
        PathBeneath, Ruleset, RulesetAttr as _, RulesetCreatedAttr as _, RulesetStatus,
        make_bitflags,
    };
    use rustix::fs::{Mode, OFlags, ResolveFlags, open, openat2};
    use rustix::mount::{
        MountFlags, MountPropagationFlags, UnmountFlags, mount, mount_bind, mount_change, unmount,
    };
    use rustix::process::{Resource, Rlimit, chdir, chroot, geteuid, pivot_root, setrlimit, umask};
    #[allow(deprecated)]
    use rustix::thread::unshare;
    use rustix::thread::{
        CapabilitiesSecureBits, CapabilitySet, CapabilitySets, LinkNameSpaceType, UnshareFlags,
        clear_ambient_capability_set, move_into_link_name_space,
        remove_capability_from_bounding_set, set_capabilities, set_capabilities_secure_bits,
        set_no_new_privs, set_thread_groups, set_thread_res_gid, set_thread_res_uid,
    };
    use rustix::{
        fd::AsFd as _,
        thread::{Gid, Uid},
    };

    use super::{CLOUD_HYPERVISOR_ARGS, load_root_owned_spec};

    type LandlockRule = (OwnedFd, BitFlags<AccessFs>);

    #[derive(Clone, Copy)]
    enum RuleAnchorKind {
        RootFile,
        VmFile,
        RootDirectory,
        VmDirectory,
        VmCharacterDevice { major: u32, minor: u32, mode: u32 },
    }

    pub(super) fn run_stage1(spec_path: &Path) -> Result<()> {
        require_root()?;
        ensure_process_environment_cleared(spec_path)?;
        let spec = load_root_owned_spec(spec_path)?;
        sanitize_inherited_fds()?;
        umask(Mode::RWXG | Mode::RWXO);
        apply_rlimits(&spec)?;
        join_network_namespace(&spec.netns_path)?;
        verify_host_devices()?;
        enter_namespaces()?;
        enter_root(&spec.jail_root)?;
        create_jail_devices(spec.uid, spec.gid)?;

        let mut child = Command::new("/intar-jailer")
            .arg("--stage2")
            .arg("--uid")
            .arg(spec.uid.to_string())
            .arg("--gid")
            .arg(spec.gid.to_string())
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .context("start PID-namespace jailer stage")?;
        drop_privileges(spec.uid, spec.gid).context("drop stage-1 waiter privileges")?;
        let status = child.wait().context("wait for Cloud Hypervisor")?;

        if status.success() {
            return Ok(());
        }
        if let Some(code) = status.code() {
            bail!("Cloud Hypervisor exited with status {code}")
        }
        bail!(
            "Cloud Hypervisor terminated by signal {}",
            status.signal().unwrap_or_default()
        )
    }

    pub(super) fn run_stage2(uid: u32, gid: u32) -> Result<()> {
        require_root()?;
        mount_proc()?;
        let landlock_rules = prepare_landlock_rules(uid, gid)?;
        drop_privileges(uid, gid)?;

        // This copied helper is deliberately outside the allowlist. Proving it
        // is readable after the UID/capability drop and then denied after
        // restriction makes the outer Landlock layer an exec-time invariant.
        File::open("/intar-jailer")
            .context("prove jailer helper is readable before Landlock restriction")?;
        apply_landlock(landlock_rules)?;
        match File::open("/intar-jailer") {
            Err(error) if error.kind() == ErrorKind::PermissionDenied => {}
            Ok(_) => bail!("Landlock did not deny the unallowlisted jailer helper"),
            Err(error) => {
                return Err(error)
                    .context("probe unallowlisted jailer helper after Landlock restriction");
            }
        }

        let stderr = OpenOptions::new()
            .append(true)
            .open("/logs/cloud-hypervisor.stderr.log")
            .context("open Cloud Hypervisor stderr log")?;

        // Cloud Hypervisor v53 assigns its CLI --landlock flag to the
        // vm-config argument group, which requires --kernel or --firmware and
        // would make the runtime create and boot a CLI-defined VM. Intar keeps
        // the exact pinned binary API-only: this inherited ruleset covers every
        // runtime thread, while each typed VmConfig also requests v53's
        // narrower landlock_enable layer.
        let error = Command::new("/cloud-hypervisor")
            .args(CLOUD_HYPERVISOR_ARGS)
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(stderr))
            .exec();
        Err(error).context("exec jailed Cloud Hypervisor")
    }

    fn prepare_landlock_rules(uid: u32, gid: u32) -> Result<Vec<LandlockRule>> {
        let root = open(
            "/",
            OFlags::PATH | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
        )
        .context("open jailed root for Landlock rules")?;
        let mut rules = Vec::new();

        push_jail_rule(
            &mut rules,
            &root,
            "cloud-hypervisor",
            RuleAnchorKind::RootFile,
            make_bitflags!(AccessFs::{Execute | ReadFile}),
            uid,
            gid,
        )?;
        push_jail_rule(
            &mut rules,
            &root,
            "boot/kernel",
            RuleAnchorKind::RootFile,
            AccessFs::ReadFile.into(),
            uid,
            gid,
        )?;
        match open_jail_rule_anchor(&root, "boot/initrd") {
            Ok(fd) => {
                validate_rule_anchor(&fd, "boot/initrd", RuleAnchorKind::RootFile, uid, gid)?;
                rules.push((fd, AccessFs::ReadFile.into()));
            }
            Err(error) if error == rustix::io::Errno::NOENT => {}
            Err(error) => return Err(error).context("open optional Landlock anchor boot/initrd"),
        }
        for (path, kind, access) in [
            (
                "disks/root.raw",
                RuleAnchorKind::VmFile,
                make_bitflags!(AccessFs::{ReadFile | WriteFile | Truncate}),
            ),
            (
                "disks/runtime.raw",
                RuleAnchorKind::RootFile,
                AccessFs::ReadFile.into(),
            ),
            (
                "disks/recordings.vfat",
                RuleAnchorKind::VmFile,
                make_bitflags!(AccessFs::{ReadFile | WriteFile | Truncate}),
            ),
        ] {
            push_jail_rule(&mut rules, &root, path, kind, access, uid, gid)?;
        }
        for path in [
            "logs/serial.log",
            "logs/console.log",
            "logs/cloud-hypervisor.stderr.log",
        ] {
            push_jail_rule(
                &mut rules,
                &root,
                path,
                RuleAnchorKind::VmFile,
                make_bitflags!(AccessFs::{WriteFile | Truncate}),
                uid,
                gid,
            )?;
        }
        push_jail_rule(
            &mut rules,
            &root,
            "run",
            RuleAnchorKind::VmDirectory,
            make_bitflags!(AccessFs::{
                ReadFile | WriteFile | RemoveFile | MakeReg | MakeSock | Truncate
            }),
            uid,
            gid,
        )?;
        for (path, kind, access) in [
            (
                "dev/kvm",
                RuleAnchorKind::VmCharacterDevice {
                    major: 10,
                    minor: 232,
                    mode: 0o600,
                },
                make_bitflags!(AccessFs::{ReadFile | WriteFile}),
            ),
            (
                "dev/net/tun",
                RuleAnchorKind::VmCharacterDevice {
                    major: 10,
                    minor: 200,
                    mode: 0o600,
                },
                make_bitflags!(AccessFs::{ReadFile | WriteFile}),
            ),
            (
                "dev/urandom",
                RuleAnchorKind::VmCharacterDevice {
                    major: 1,
                    minor: 9,
                    mode: 0o400,
                },
                AccessFs::ReadFile.into(),
            ),
            (
                "dev/null",
                RuleAnchorKind::VmCharacterDevice {
                    major: 1,
                    minor: 3,
                    mode: 0o600,
                },
                make_bitflags!(AccessFs::{ReadFile | WriteFile}),
            ),
        ] {
            push_jail_rule(&mut rules, &root, path, kind, access, uid, gid)?;
        }

        // procfs is the one intentional mount boundary inside the jail, so it
        // is pinned independently after mount rather than reached through a
        // lookup that weakens NO_XDEV for every other anchor.
        let proc_fd = open(
            "/proc",
            OFlags::PATH | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
        )
        .context("open fresh procfs Landlock anchor")?;
        validate_rule_anchor(&proc_fd, "proc", RuleAnchorKind::RootDirectory, uid, gid)?;
        rules.push((proc_fd, make_bitflags!(AccessFs::{ReadFile | ReadDir})));
        Ok(rules)
    }

    fn open_jail_rule_anchor(
        root: &impl std::os::fd::AsFd,
        relative: &str,
    ) -> rustix::io::Result<OwnedFd> {
        openat2(
            root,
            relative,
            OFlags::PATH | OFlags::CLOEXEC,
            Mode::empty(),
            ResolveFlags::BENEATH
                | ResolveFlags::NO_SYMLINKS
                | ResolveFlags::NO_MAGICLINKS
                | ResolveFlags::NO_XDEV,
        )
    }

    fn push_jail_rule(
        rules: &mut Vec<LandlockRule>,
        root: &impl std::os::fd::AsFd,
        relative: &str,
        kind: RuleAnchorKind,
        access: BitFlags<AccessFs>,
        uid: u32,
        gid: u32,
    ) -> Result<()> {
        let fd = open_jail_rule_anchor(root, relative)
            .with_context(|| format!("open Landlock anchor {relative}"))?;
        validate_rule_anchor(&fd, relative, kind, uid, gid)?;
        rules.push((fd, access));
        Ok(())
    }

    fn validate_rule_anchor(
        fd: &impl std::os::fd::AsFd,
        path: &str,
        kind: RuleAnchorKind,
        uid: u32,
        gid: u32,
    ) -> Result<()> {
        let stat = rustix::fs::fstat(fd).with_context(|| format!("stat Landlock anchor {path}"))?;
        let file_type = rustix::fs::FileType::from_raw_mode(stat.st_mode);
        let expected_owner = match kind {
            RuleAnchorKind::RootFile | RuleAnchorKind::RootDirectory => (0, 0),
            RuleAnchorKind::VmFile
            | RuleAnchorKind::VmDirectory
            | RuleAnchorKind::VmCharacterDevice { .. } => (uid, gid),
        };
        ensure!(
            (stat.st_uid, stat.st_gid) == expected_owner,
            "Landlock anchor {path} has unexpected owner {}:{}",
            stat.st_uid,
            stat.st_gid
        );
        match kind {
            RuleAnchorKind::RootFile | RuleAnchorKind::VmFile => {
                ensure!(
                    file_type == rustix::fs::FileType::RegularFile && stat.st_nlink == 1,
                    "Landlock anchor {path} is not a one-link regular file"
                );
            }
            RuleAnchorKind::RootDirectory | RuleAnchorKind::VmDirectory => {
                ensure!(
                    file_type == rustix::fs::FileType::Directory && stat.st_nlink >= 1,
                    "Landlock anchor {path} is not a linked directory"
                );
            }
            RuleAnchorKind::VmCharacterDevice { major, minor, mode } => {
                ensure!(
                    file_type == rustix::fs::FileType::CharacterDevice
                        && rustix::fs::major(stat.st_rdev) == major
                        && rustix::fs::minor(stat.st_rdev) == minor
                        && stat.st_mode & 0o777 == mode
                        && stat.st_nlink == 1,
                    "Landlock anchor {path} is not the expected character device"
                );
            }
        }
        Ok(())
    }

    fn apply_landlock(rules: Vec<LandlockRule>) -> Result<()> {
        let requested_abi = ABI::V3;
        let mut ruleset = Ruleset::default()
            .set_compatibility(CompatLevel::HardRequirement)
            .handle_access(AccessFs::from_all(requested_abi))?
            .set_compatibility(CompatLevel::HardRequirement)
            .create()?
            .set_compatibility(CompatLevel::HardRequirement);
        for (fd, access) in rules {
            ruleset = ruleset.add_rule(PathBeneath::new(fd, access))?;
        }
        let status = ruleset.restrict_self()?;
        ensure!(
            status.ruleset == RulesetStatus::FullyEnforced,
            "jailer Landlock ruleset was not fully enforced"
        );
        ensure!(
            matches!(
                status.landlock,
                LandlockStatus::Available { effective_abi, .. } if effective_abi >= ABI::V3
            ),
            "jailer Landlock ABI 3 is not fully available"
        );
        Ok(())
    }

    fn ensure_process_environment_cleared(spec_path: &Path) -> Result<()> {
        if std::env::vars_os().next().is_none() {
            return Ok(());
        }

        // Re-exec the exact running jailer with an empty environment. This
        // gives stage 1 a process-wide scrub without weakening the workspace's
        // `forbid(unsafe_code)` policy or trusting a caller-provided marker.
        let error = Command::new("/proc/self/exe")
            .arg("--spec")
            .arg(spec_path)
            .env_clear()
            .exec();
        Err(error).context("re-exec jailer with an empty environment")
    }

    fn require_root() -> Result<()> {
        if geteuid() != Uid::ROOT {
            bail!("intar-jailer must be invoked as root and is never setuid")
        }
        Ok(())
    }

    fn apply_rlimits(spec: &JailSpecV1) -> Result<()> {
        setrlimit(
            Resource::Nofile,
            Rlimit {
                current: Some(spec.nofile_limit),
                maximum: Some(spec.nofile_limit),
            },
        )
        .context("set RLIMIT_NOFILE")?;
        if let Some(bytes) = spec.file_size_limit {
            setrlimit(
                Resource::Fsize,
                Rlimit {
                    current: Some(bytes),
                    maximum: Some(bytes),
                },
            )
            .context("set RLIMIT_FSIZE")?;
        }
        Ok(())
    }

    fn sanitize_inherited_fds() -> Result<()> {
        // intar-jailer is single-threaded. Collect first so the /proc iterator's
        // own directory descriptor is closed only after enumeration completes.
        let mut unexpected = std::fs::read_dir("/proc/self/fd")
            .context("enumerate inherited file descriptors")?
            .map(|entry| {
                let entry = entry.context("read inherited file descriptor entry")?;
                entry
                    .file_name()
                    .to_string_lossy()
                    .parse::<i32>()
                    .context("parse inherited file descriptor")
            })
            .collect::<Result<Vec<_>>>()?;
        unexpected.retain(|fd| *fd > 2);
        unexpected.sort_unstable();
        unexpected.dedup();
        for fd in unexpected {
            match nix::unistd::close(fd) {
                Ok(()) | Err(nix::errno::Errno::EBADF) => {}
                Err(error) => return Err(error).context(format!("close inherited fd {fd}")),
            }
        }
        Ok(())
    }

    fn join_network_namespace(path: &Path) -> Result<()> {
        let fd = open(
            path,
            OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
        )
        .with_context(|| format!("open network namespace {}", path.display()))?;
        move_into_link_name_space(fd.as_fd(), Some(LinkNameSpaceType::Network))
            .context("join run network namespace")
    }

    #[allow(
        deprecated,
        reason = "safe legacy rustix wrapper; the jailer is single-threaded"
    )]
    fn enter_namespaces() -> Result<()> {
        unshare(
            UnshareFlags::NEWNS
                | UnshareFlags::NEWPID
                | UnshareFlags::NEWUTS
                | UnshareFlags::NEWIPC
                | UnshareFlags::NEWCGROUP,
        )
        .context("unshare jail namespaces")?;
        rustix::system::sethostname(b"intar-vm").context("set isolated hostname")?;
        Ok(())
    }

    fn enter_root(root: &Path) -> Result<()> {
        mount_change(
            "/",
            MountPropagationFlags::PRIVATE | MountPropagationFlags::REC,
        )
        .context("make host mounts non-propagating")?;
        mount_bind(root, root).context("self-bind jail root")?;
        chdir(root).context("chdir to jail root")?;
        std::fs::create_dir("old_root").context("create old-root pivot directory")?;
        pivot_root(".", "old_root").context("pivot into jail root")?;
        chdir("/").context("chdir after pivot")?;
        unmount("/old_root", UnmountFlags::DETACH | UnmountFlags::NOFOLLOW)
            .context("detach old root")?;
        std::fs::remove_dir("/old_root").context("remove old-root pivot directory")?;
        chroot("/").context("defensive chroot")?;
        chdir("/").context("chdir after chroot")?;
        Ok(())
    }

    fn mount_proc() -> Result<()> {
        mount(
            "proc",
            "/proc",
            "proc",
            MountFlags::RDONLY | MountFlags::NOSUID | MountFlags::NODEV | MountFlags::NOEXEC,
            None,
        )
        .context("mount PID-namespace procfs")
    }

    fn verify_host_devices() -> Result<()> {
        for (path, expected_major, expected_minor) in [
            ("/dev/kvm", 10, 232),
            ("/dev/net/tun", 10, 200),
            ("/dev/urandom", 1, 9),
            ("/dev/null", 1, 3),
        ] {
            let metadata = std::fs::symlink_metadata(path)
                .with_context(|| format!("inspect required host device {path}"))?;
            if !metadata.file_type().is_char_device() {
                bail!("required host device {path} is not a character device")
            }
            let (major, minor) = (
                rustix::fs::major(metadata.rdev()),
                rustix::fs::minor(metadata.rdev()),
            );
            if (major, minor) != (expected_major, expected_minor) {
                bail!("required host device {path} has unexpected major/minor {major}:{minor}")
            }
        }
        Ok(())
    }

    fn create_jail_devices(uid: u32, gid: u32) -> Result<()> {
        for (path, major, minor, mode) in [
            ("/dev/kvm", 10, 232, 0o600),
            ("/dev/net/tun", 10, 200, 0o600),
            ("/dev/urandom", 1, 9, 0o400),
            ("/dev/null", 1, 3, 0o600),
        ] {
            rustix::fs::mknodat(
                rustix::fs::CWD,
                path,
                rustix::fs::FileType::CharacterDevice,
                Mode::from_raw_mode(mode),
                rustix::fs::makedev(major, minor),
            )
            .with_context(|| format!("create jailed device {path}"))?;
            rustix::fs::chown(path, Some(Uid::from_raw(uid)), Some(Gid::from_raw(gid)))
                .with_context(|| format!("set jailed device owner on {path}"))?;

            let metadata = std::fs::symlink_metadata(path)
                .with_context(|| format!("verify jailed device {path}"))?;
            let actual_mode = metadata.mode() & 0o777;
            let (actual_major, actual_minor) = (
                rustix::fs::major(metadata.rdev()),
                rustix::fs::minor(metadata.rdev()),
            );
            if !metadata.file_type().is_char_device()
                || (actual_major, actual_minor) != (major, minor)
                || actual_mode != mode
                || metadata.uid() != uid
                || metadata.gid() != gid
                || metadata.nlink() != 1
            {
                bail!("jailed device {path} failed post-creation verification")
            }
        }
        Ok(())
    }

    fn drop_privileges(uid: u32, gid: u32) -> Result<()> {
        if uid == 0 || gid == 0 {
            bail!("refusing root VM identity")
        }
        clear_ambient_capability_set().context("clear ambient capabilities")?;
        // CapabilitySet is a u64 bitset. Walk the full representable range so
        // a newer kernel capability cannot silently remain in the bounding
        // set; kernels report EINVAL for bits above cap_last_cap.
        for bit in 0..=63_u32 {
            let capability = CapabilitySet::from_bits_retain(1_u64 << bit);
            match remove_capability_from_bounding_set(capability) {
                Ok(()) | Err(rustix::io::Errno::INVAL) => {}
                Err(error) => {
                    return Err(error)
                        .with_context(|| format!("drop capability {bit} from bounding set"));
                }
            }
        }
        set_capabilities_secure_bits(
            CapabilitiesSecureBits::NO_ROOT
                | CapabilitiesSecureBits::NO_ROOT_LOCKED
                | CapabilitiesSecureBits::NO_SETUID_FIXUP
                | CapabilitiesSecureBits::NO_SETUID_FIXUP_LOCKED,
        )
        .context("lock capability securebits")?;
        set_thread_groups(&[]).context("clear supplementary groups")?;
        let gid = Gid::from_raw(gid);
        let uid = Uid::from_raw(uid);
        set_thread_res_gid(gid, gid, gid).context("drop group identity")?;
        set_thread_res_uid(uid, uid, uid).context("drop user identity")?;
        set_capabilities(
            None,
            CapabilitySets {
                effective: CapabilitySet::empty(),
                permitted: CapabilitySet::empty(),
                inheritable: CapabilitySet::empty(),
            },
        )
        .context("clear process capabilities")?;
        set_no_new_privs(true).context("set no_new_privs")?;
        Ok(())
    }

    use std::os::unix::process::CommandExt as _;
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;

    use super::*;

    #[test]
    fn rejects_group_readable_spec() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("spec.json");
        std::fs::write(&path, b"{}").expect("write fixture");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640))
            .expect("chmod fixture");
        assert!(validate_spec_metadata(&std::fs::metadata(path).expect("metadata")).is_err());
    }

    #[test]
    fn rejects_hardlinked_spec() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("spec.json");
        let alias = directory.path().join("alias.json");
        std::fs::write(&path, b"{}").expect("write fixture");
        std::fs::hard_link(&path, alias).expect("hard link fixture");
        assert!(validate_spec_metadata(&std::fs::metadata(path).expect("metadata")).is_err());
    }

    #[test]
    fn cloud_hypervisor_v53_startup_is_api_only() {
        assert_eq!(
            CLOUD_HYPERVISOR_ARGS,
            [
                "--api-socket",
                "/run/cloud-hypervisor.sock",
                "--seccomp",
                "true"
            ]
        );
        assert!(!CLOUD_HYPERVISOR_ARGS.contains(&"--landlock"));
        assert!(!CLOUD_HYPERVISOR_ARGS.contains(&"--kernel"));
        assert!(!CLOUD_HYPERVISOR_ARGS.contains(&"--firmware"));
    }
}
