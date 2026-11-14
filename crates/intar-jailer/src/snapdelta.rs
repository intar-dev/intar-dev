//! `intar-jailer apply-snapdelta`: rebuilds a VM memory file from a base and
//! an untrusted `intar-snapdelta` delta inside the transient unit jailerd
//! starts for it. The unit opens the three files (`OpenFile=`) and runs this
//! helper as a dynamic user without capabilities, network or a writable
//! file system; the helper takes no paths, only the inherited descriptors.

use std::collections::BTreeMap;
use std::fs::File;

use anyhow::{Context as _, Result, bail, ensure};
use landlock::{
    ABI, Access as _, AccessFs, CompatLevel, Compatible as _, LandlockStatus, Ruleset,
    RulesetAttr as _, RulesetStatus,
};
use rustix::fs::{OFlags, fcntl_getfl};
use rustix::process::{PidfdFlags, PidfdGetfdFlags, getpid, pidfd_getfd, pidfd_open};

/// Worker threads for the apply; the unit's `TasksMax=` leaves room for them.
const THREADS: usize = 2;
const NAMES: [&str; 3] = ["base", "delta", "out"];

pub(crate) fn run() -> Result<()> {
    let fds = listen_fds(
        std::env::var("LISTEN_PID").ok().as_deref(),
        std::env::var("LISTEN_FDS").ok().as_deref(),
        std::env::var("LISTEN_FDNAMES").ok().as_deref(),
        std::process::id(),
    )?;
    // The descriptors come from systemd's fd protocol (fds from 3), and no
    // Rust value in this process owns them. Turning a raw number into an
    // `OwnedFd` needs `unsafe`, and reopening `/proc/self/fd/<n>` would check
    // the root-only files' permissions again as the dynamic user and fail.
    // `pidfd_getfd` on our own pidfd duplicates each one safely: the same
    // open file description, with the access mode systemd opened it with.
    let pidfd = pidfd_open(getpid(), PidfdFlags::empty()).context("open own pidfd")?;
    let take = |name: &str| -> Result<File> {
        let raw = fds[name];
        Ok(File::from(
            pidfd_getfd(&pidfd, raw, PidfdGetfdFlags::empty())
                .with_context(|| format!("take inherited fd {name}"))?,
        ))
    };
    let (base, delta, out) = (take("base")?, take("delta")?, take("out")?);
    drop(pidfd);

    for (name, file, expected) in [
        ("base", &base, OFlags::RDONLY),
        ("delta", &delta, OFlags::RDONLY),
        ("out", &out, OFlags::RDWR),
    ] {
        let mode = fcntl_getfl(file).with_context(|| format!("{name} flags"))? & OFlags::RWMODE;
        ensure!(mode == expected, "{name} is not opened {expected:?}");
        let meta = file.metadata().with_context(|| format!("stat {name}"))?;
        ensure!(meta.is_file(), "{name} is not a regular file");
    }
    ensure!(out.metadata()?.len() == 0, "out is not empty");

    deny_all_paths()?;
    intar_snapdelta::apply_files(&base, &delta, &out, THREADS).context("apply snapdelta")?;
    Ok(())
}

/// Maps the fd names of systemd's fd protocol to their descriptors: exactly
/// `base`, `delta` and `out`, each once, passed to this very process.
fn listen_fds(
    pid: Option<&str>,
    count: Option<&str>,
    names: Option<&str>,
    own_pid: u32,
) -> Result<BTreeMap<&'static str, i32>> {
    let pid: u32 = pid.context("LISTEN_PID missing")?.parse()?;
    ensure!(pid == own_pid, "LISTEN_PID is not this process");
    let count: usize = count.context("LISTEN_FDS missing")?.parse()?;
    let names: Vec<&str> = names
        .context("LISTEN_FDNAMES missing")?
        .split(':')
        .collect();
    ensure!(
        count == NAMES.len() && names.len() == count,
        "expected exactly the fds base, delta and out"
    );
    let mut fds = BTreeMap::new();
    for (index, name) in names.into_iter().enumerate() {
        let Some(&known) = NAMES.iter().find(|&&known| known == name) else {
            bail!("unexpected fd name {name:?}")
        };
        ensure!(
            fds.insert(known, 3 + i32::try_from(index)?).is_none(),
            "fd name {name} passed twice"
        );
    }
    Ok(fds)
}

/// A Landlock domain that handles every file-system access and allows none:
/// from here on no path can be opened, executed or changed. Descriptors
/// opened before keep the access they were opened with.
fn deny_all_paths() -> Result<()> {
    let status = Ruleset::default()
        .set_compatibility(CompatLevel::HardRequirement)
        .handle_access(AccessFs::from_all(ABI::V3))?
        .create()?
        .restrict_self()?;
    ensure!(
        status.ruleset == RulesetStatus::FullyEnforced
            && matches!(
                status.landlock,
                LandlockStatus::Available { effective_abi, .. } if effective_abi >= ABI::V3
            ),
        "Landlock ABI 3 is not fully enforced"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listen_fds_takes_exactly_the_three_names() -> Result<()> {
        let fds = listen_fds(Some("7"), Some("3"), Some("out:base:delta"), 7)?;
        assert_eq!(fds["out"], 3);
        assert_eq!(fds["base"], 4);
        assert_eq!(fds["delta"], 5);

        let refused = |pid, count, names| listen_fds(pid, count, names, 7).is_err();
        assert!(refused(Some("8"), Some("3"), Some("base:delta:out")));
        assert!(refused(None, Some("3"), Some("base:delta:out")));
        assert!(refused(Some("7"), Some("4"), Some("base:delta:out:x")));
        assert!(refused(Some("7"), Some("3"), Some("base:delta")));
        assert!(refused(Some("7"), Some("3"), Some("base:base:out")));
        assert!(refused(Some("7"), Some("3"), Some("base:delta:spec")));
        assert!(refused(Some("7"), Some("3"), None));
        Ok(())
    }
}
