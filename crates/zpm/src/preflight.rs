//! Before anything is pulled or started: does this computer have the
//! processors, the memory and the disk space the lab's machines need? A lab
//! that starts and then starves is worse than one that says why it cannot.

use std::path::Path;

use crate::Error;

/// What all machines of a run need together.
#[derive(Clone, Copy, Debug)]
pub struct Needs {
    pub cpus: u32,
    pub memory_mib: u64,
    /// For the images and the run's own disks.
    pub disk_mib: u64,
}

/// What this computer has. `None` is "could not be measured", which never
/// refuses a run.
#[derive(Clone, Copy, Debug, Default)]
pub struct Has {
    pub cpus: Option<u32>,
    pub memory_mib: Option<u64>,
    pub disk_mib: Option<u64>,
}

impl Has {
    /// Measures this computer; `dir` is where the run's files will go.
    pub fn measure(dir: &Path) -> Self {
        Self {
            cpus: std::thread::available_parallelism()
                .ok()
                .and_then(|count| u32::try_from(count.get()).ok()),
            memory_mib: memory_mib(),
            disk_mib: disk_mib(dir),
        }
    }
}

/// Refuses a run this computer cannot hold, naming the first shortage.
pub fn check(needs: &Needs, has: &Has) -> Result<(), Error> {
    if let Some(cpus) = has.cpus.filter(|&cpus| cpus < needs.cpus) {
        return Err(Error::Preflight(format!(
            "This lab needs {} processors and this computer has {cpus}.",
            needs.cpus
        )));
    }
    if let Some(memory) = has.memory_mib.filter(|&memory| memory < needs.memory_mib) {
        return Err(Error::Preflight(format!(
            "This lab needs {} of memory and {} are available. Closing other programs may free enough.",
            size(needs.memory_mib),
            size(memory)
        )));
    }
    if let Some(disk) = has.disk_mib.filter(|&disk| disk < needs.disk_mib) {
        return Err(Error::Preflight(format!(
            "This lab needs {} of disk space and {} are free.",
            size(needs.disk_mib),
            size(disk)
        )));
    }
    Ok(())
}

fn size(mib: u64) -> String {
    if mib >= 1024 {
        format!("{:.1} GiB", mib as f64 / 1024.0)
    } else {
        format!("{mib} MiB")
    }
}

/// Memory a new program could get, as the kernel estimates it.
#[cfg(target_os = "linux")]
fn memory_mib() -> Option<u64> {
    let meminfo = std::fs::read_to_string("/proc/meminfo").ok()?;
    let line = meminfo
        .lines()
        .find(|line| line.starts_with("MemAvailable:"))?;
    Some(line.split_whitespace().nth(1)?.parse::<u64>().ok()? / 1024)
}

// ponytail: all installed memory, not what is free; macOS has no single
// "available" figure. Read vm_stat if labs start and then swap.
#[cfg(target_os = "macos")]
fn memory_mib() -> Option<u64> {
    let output = std::process::Command::new("/usr/sbin/sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .ok()?;
    Some(
        String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse::<u64>()
            .ok()?
            / (1024 * 1024),
    )
}

// ponytail: not measured on Windows yet (#405).
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn memory_mib() -> Option<u64> {
    None
}

#[cfg(unix)]
fn disk_mib(dir: &Path) -> Option<u64> {
    // The directory may not exist yet; its nearest existing parent is on the same disk.
    let existing = dir.ancestors().find(|path| path.exists())?;
    let stat = rustix::fs::statvfs(existing).ok()?;
    Some(stat.f_bavail.saturating_mul(stat.f_frsize) / (1024 * 1024))
}

#[cfg(not(unix))]
fn disk_mib(_dir: &Path) -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_first_shortage_and_lets_the_unmeasured_pass() {
        let needs = Needs {
            cpus: 4,
            memory_mib: 3072,
            disk_mib: 6144,
        };
        let plenty = Has {
            cpus: Some(8),
            memory_mib: Some(16_384),
            disk_mib: Some(100_000),
        };
        assert!(check(&needs, &plenty).is_ok());
        assert!(
            check(
                &needs,
                &Has {
                    cpus: Some(4),
                    memory_mib: Some(3072),
                    disk_mib: Some(6144)
                }
            )
            .is_ok()
        );
        // What could not be measured does not refuse a run.
        assert!(check(&needs, &Has::default()).is_ok());

        let refusal = |has: Has| match check(&needs, &has) {
            Err(Error::Preflight(reason)) => reason,
            other => panic!("expected a refusal, got {other:?}"),
        };
        assert_eq!(
            refusal(Has {
                cpus: Some(2),
                ..plenty
            }),
            "This lab needs 4 processors and this computer has 2."
        );
        assert_eq!(
            refusal(Has {
                memory_mib: Some(1800),
                ..plenty
            }),
            "This lab needs 3.0 GiB of memory and 1.8 GiB are available. Closing other programs may free enough."
        );
        assert_eq!(
            refusal(Has {
                disk_mib: Some(512),
                ..plenty
            }),
            "This lab needs 6.0 GiB of disk space and 512 MiB are free."
        );
        // Processors are named before memory when both are short.
        assert!(
            refusal(Has {
                cpus: Some(1),
                memory_mib: Some(1),
                ..plenty
            })
            .contains("processors")
        );
    }

    #[test]
    fn measures_this_computer() {
        let has = Has::measure(&std::env::temp_dir().join("zpm-not-there-yet"));
        assert!(has.cpus.is_some_and(|cpus| cpus >= 1));
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        assert!(has.memory_mib.is_some_and(|memory| memory > 64), "{has:?}");
        #[cfg(unix)]
        assert!(has.disk_mib.is_some(), "{has:?}");
    }
}
