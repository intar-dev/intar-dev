//! Applies an `intar-snapdelta` delta outside jailerd's root process.
//!
//! The delta is untrusted registry data, so its decoder runs in a transient
//! systemd unit (`intar-jailer apply-snapdelta`): a dynamic user without
//! capabilities, network, devices or a writable file system, with a syscall
//! filter, bounded memory, tasks and run time. systemd opens the three files
//! for it (`OpenFile=`: base and delta read-only, out read-write), and the
//! helper locks itself out of every path (Landlock) before it reads a byte.
//! The caller still treats the output as untrusted and checks its digest.

use std::path::Path;
use std::time::Duration;

use anyhow::Result;

/// `OpenFile=` came in systemd 253.
#[cfg(any(target_os = "linux", test))]
const MIN_SYSTEMD_VERSION: u32 = 253;

#[cfg(target_os = "linux")]
pub(crate) fn apply_snapdelta_sandboxed(
    jailer_binary: &Path,
    base: &Path,
    delta: &Path,
    out: &Path,
    timeout: Duration,
    memory_max_bytes: u64,
) -> Result<()> {
    linux::apply(jailer_binary, base, delta, out, timeout, memory_max_bytes)
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn apply_snapdelta_sandboxed(
    _jailer_binary: &Path,
    _base: &Path,
    _delta: &Path,
    _out: &Path,
    _timeout: Duration,
    _memory_max_bytes: u64,
) -> Result<()> {
    anyhow::bail!("the snapdelta sandbox needs Linux and systemd")
}

/// Whether this host can run [`apply_snapdelta_sandboxed`]: systemd is at
/// least 253 (it understands `OpenFile=`) and `jailer_binary` is a file. It
/// does not run the sandbox; a host that fails at it (no Landlock ABI 3,
/// for one) fails each apply instead, closed. The systemd probe runs once.
#[cfg(target_os = "linux")]
pub(crate) fn snapdelta_sandbox_available(jailer_binary: &Path) -> bool {
    static SYSTEMD_OK: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    jailer_binary.is_file() && *SYSTEMD_OK.get_or_init(linux::systemd_new_enough)
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn snapdelta_sandbox_available(_jailer_binary: &Path) -> bool {
    false
}

/// The leading number of systemd's `Version` property ("259.1-1-arch",
/// "255.4-1ubuntu8", "v257").
#[cfg(any(target_os = "linux", test))]
fn systemd_major(version: &str) -> Option<u32> {
    let digits: String = version
        .trim_start_matches('v')
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

#[cfg(target_os = "linux")]
mod linux {
    use std::path::Path;
    use std::time::{Duration, Instant};

    use anyhow::{Context as _, Result, bail, ensure};
    use zbus::{OwnedObjectPath, Variant};

    use super::{MIN_SYSTEMD_VERSION, systemd_major};
    use crate::SystemdHostBackend;

    /// `OpenFile=` flags (systemd `OpenFileFlag`): bit 0 opens read-only; no
    /// flag opens read-write.
    const OPEN_FILE_READ_ONLY: u64 = 1;
    /// The helper's main thread and its two apply workers, with room to spare.
    const TASKS_MAX: u64 = 8;

    /// systemd's own `TimeoutStartSec=` stops the helper at the timeout; this
    /// margin only bounds the wait for it to report that.
    const WAIT_MARGIN: Duration = Duration::from_secs(10);
    const CLEANUP_TIMEOUT: Duration = Duration::from_secs(10);
    const POLL: Duration = Duration::from_millis(50);
    /// `CLD_EXITED`, systemd's `ExecMainCode` for a normal exit.
    const CLD_EXITED: i32 = 1;

    pub(super) fn systemd_new_enough() -> bool {
        let version = || -> Result<String> {
            let connection = zbus::block_on(zbus::Connection::system())?;
            let manager = SystemdHostBackend::manager(&connection)?;
            Ok(zbus::block_on(manager.get_property("Version"))?)
        };
        version()
            .ok()
            .and_then(|version| systemd_major(&version))
            .is_some_and(|major| major >= MIN_SYSTEMD_VERSION)
    }

    pub(super) fn apply(
        jailer_binary: &Path,
        base: &Path,
        delta: &Path,
        out: &Path,
        timeout: Duration,
        memory_max_bytes: u64,
    ) -> Result<()> {
        let utf8 = |path: &Path, what: &str| {
            path.to_str()
                .map(ToOwned::to_owned)
                .with_context(|| format!("snapdelta {what} path is not UTF-8"))
        };
        ensure!(
            !timeout.is_zero() && memory_max_bytes > 0,
            "the snapdelta sandbox needs a timeout and a memory limit"
        );
        let spec = UnitSpec {
            jailer_binary: utf8(jailer_binary, "jailer")?,
            base: utf8(base, "base")?,
            delta: utf8(delta, "delta")?,
            out: utf8(out, "out")?,
            timeout,
            memory_max_bytes,
        };
        run_unit(spec.properties(), timeout + WAIT_MARGIN)
    }

    /// Starts a transient unit with `properties`, waits up to `wait` for it
    /// to exit successfully, then stops and removes it whatever happened.
    pub(super) fn run_unit(
        properties: Vec<(&'static str, Variant<'static>)>,
        wait: Duration,
    ) -> Result<()> {
        let unit_name = format!("intar-snapdelta-{}.service", uuid::Uuid::new_v4());
        let connection =
            zbus::block_on(zbus::Connection::system()).context("connect to system D-Bus")?;
        let manager = SystemdHostBackend::manager(&connection)?;

        let started: zbus::Result<OwnedObjectPath> = zbus::block_on(manager.call(
            "StartTransientUnit",
            &(
                unit_name.as_str(),
                "fail",
                properties,
                Vec::<(&str, Vec<(&str, Variant<'_>)>)>::new(),
            ),
        ));
        let result = match started {
            Ok(_) => wait_for_success(&connection, &manager, &unit_name, wait),
            Err(error) => Err(error).context("start the snapdelta unit"),
        };
        // Always leave nothing behind, whatever happened above.
        let cleanup = stop_and_reset(&connection, &manager, &unit_name);
        result.and(cleanup)
    }

    pub(super) struct UnitSpec {
        pub(super) jailer_binary: String,
        pub(super) base: String,
        pub(super) delta: String,
        pub(super) out: String,
        pub(super) timeout: Duration,
        pub(super) memory_max_bytes: u64,
    }

    impl UnitSpec {
        pub(super) fn properties(&self) -> Vec<(&'static str, Variant<'static>)> {
            let exec_start = vec![(
                self.jailer_binary.clone(),
                vec![self.jailer_binary.clone(), "apply-snapdelta".to_owned()],
                false,
            )];
            let open_files = vec![
                (self.base.clone(), "base".to_owned(), OPEN_FILE_READ_ONLY),
                (self.delta.clone(), "delta".to_owned(), OPEN_FILE_READ_ONLY),
                (self.out.clone(), "out".to_owned(), 0_u64),
            ];
            let names = |names: &[&str]| -> Vec<String> {
                names.iter().map(|&name| name.to_owned()).collect()
            };
            let timeout_usec = u64::try_from(self.timeout.as_micros()).unwrap_or(u64::MAX);
            vec![
                ("Description", Variant::new("Intar snapdelta apply")),
                ("Slice", Variant::new("intar-vms.slice")),
                // A oneshot's run is its activation, bounded by
                // TimeoutStartSec=; RemainAfterExit keeps a successful unit
                // (active, exited) so its result can be read before reset.
                ("Type", Variant::new("oneshot")),
                ("RemainAfterExit", Variant::new(true)),
                ("TimeoutStartUSec", Variant::new(timeout_usec)),
                ("ExecStart", Variant::new(exec_start)),
                ("OpenFile", Variant::new(open_files)),
                // Identity and privileges.
                ("DynamicUser", Variant::new(true)),
                ("NoNewPrivileges", Variant::new(true)),
                ("CapabilityBoundingSet", Variant::new(0_u64)),
                ("AmbientCapabilities", Variant::new(0_u64)),
                ("RestrictSUIDSGID", Variant::new(true)),
                ("UMask", Variant::new(0o077_u32)),
                // File system: read-only everywhere, nothing private exposed.
                // The helper also denies itself every path (Landlock).
                ("ProtectSystem", Variant::new("strict")),
                ("ProtectHome", Variant::new("yes")),
                ("PrivateTmp", Variant::new(true)),
                // Not even the private, per-unit scratch space is reachable.
                (
                    "InaccessiblePaths",
                    Variant::new(names(&["/tmp", "/var/tmp", "/dev/shm"])),
                ),
                ("PrivateDevices", Variant::new(true)),
                ("PrivateIPC", Variant::new(true)),
                ("ProtectProc", Variant::new("invisible")),
                ("ProcSubset", Variant::new("pid")),
                ("ProtectKernelTunables", Variant::new(true)),
                ("ProtectKernelModules", Variant::new(true)),
                ("ProtectKernelLogs", Variant::new(true)),
                ("ProtectControlGroups", Variant::new(true)),
                ("ProtectClock", Variant::new(true)),
                ("ProtectHostname", Variant::new(true)),
                // Network: none. stdout/stderr reach the journal over sockets
                // systemd connects before exec, so no family is needed.
                ("PrivateNetwork", Variant::new(true)),
                (
                    "RestrictAddressFamilies",
                    Variant::new((true, Vec::<String>::new())),
                ),
                // Kernel surface.
                ("RestrictNamespaces", Variant::new(0_u64)),
                ("RestrictRealtime", Variant::new(true)),
                ("LockPersonality", Variant::new(true)),
                ("MemoryDenyWriteExecute", Variant::new(true)),
                ("SystemCallArchitectures", Variant::new(names(&["native"]))),
                (
                    "SystemCallFilter",
                    Variant::new((true, names(&["@system-service", "pidfd_getfd"]))),
                ),
                (
                    "SystemCallFilter",
                    Variant::new((
                        false,
                        names(&[
                            "@privileged",
                            "@resources",
                            "@mount",
                            "@network-io",
                            "@keyring",
                            "@setuid",
                            "@chown",
                        ]),
                    )),
                ),
                // Resources.
                ("MemoryMax", Variant::new(self.memory_max_bytes)),
                ("MemorySwapMax", Variant::new(0_u64)),
                ("TasksMax", Variant::new(TASKS_MAX)),
                ("LimitCORE", Variant::new(0_u64)),
                ("KillMode", Variant::new("control-group")),
            ]
        }
    }

    fn unit_proxy<'a>(
        connection: &'a zbus::Connection,
        path: OwnedObjectPath,
        interface: &'static str,
    ) -> Result<zbus::Proxy<'a>> {
        Ok(zbus::block_on(zbus::Proxy::new(
            connection,
            "org.freedesktop.systemd1",
            path,
            interface,
        ))?)
    }

    fn wait_for_success(
        connection: &zbus::Connection,
        manager: &zbus::Proxy<'_>,
        unit_name: &str,
        wait: Duration,
    ) -> Result<()> {
        let deadline = Instant::now() + wait;
        let path = SystemdHostBackend::get_unit_path(manager, unit_name)?
            .context("the snapdelta unit vanished after its start")?;
        let unit = unit_proxy(connection, path.clone(), "org.freedesktop.systemd1.Unit")?;
        let service = unit_proxy(connection, path, "org.freedesktop.systemd1.Service")?;
        loop {
            let active: String = zbus::block_on(unit.get_property("ActiveState"))?;
            let sub: String = zbus::block_on(unit.get_property("SubState"))?;
            if active == "failed" || (active == "active" && sub == "exited") {
                break;
            }
            ensure!(
                Instant::now() < deadline,
                "the snapdelta unit did not finish in time ({active}/{sub})"
            );
            std::thread::sleep(POLL);
        }
        let result: String = zbus::block_on(service.get_property("Result"))?;
        let code: i32 = zbus::block_on(service.get_property("ExecMainCode"))?;
        let status: i32 = zbus::block_on(service.get_property("ExecMainStatus"))?;
        if result != "success" || code != CLD_EXITED || status != 0 {
            bail!("the snapdelta helper failed (result {result}, code {code}, status {status})")
        }
        Ok(())
    }

    fn stop_and_reset(
        connection: &zbus::Connection,
        manager: &zbus::Proxy<'_>,
        unit_name: &str,
    ) -> Result<()> {
        let deadline = Instant::now() + CLEANUP_TIMEOUT;
        let mut stop_sent = false;
        while let Some(path) = SystemdHostBackend::get_unit_path(manager, unit_name)? {
            let unit = unit_proxy(connection, path, "org.freedesktop.systemd1.Unit")?;
            // The unit can be unloaded between GetUnit and here.
            let active: Option<String> = zbus::block_on(unit.get_property("ActiveState")).ok();
            match active.as_deref() {
                Some("inactive" | "failed") => {
                    let _: zbus::Result<()> =
                        zbus::block_on(manager.call("ResetFailedUnit", &(unit_name,)));
                }
                Some(_) if !stop_sent => {
                    let _: zbus::Result<OwnedObjectPath> =
                        zbus::block_on(manager.call("StopUnit", &(unit_name, "replace")));
                    stop_sent = true;
                }
                _ => {}
            }
            ensure!(
                Instant::now() < deadline,
                "the snapdelta unit {unit_name} was not stopped and removed"
            );
            std::thread::sleep(POLL);
        }
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn systemd_major_reads_the_leading_number() {
        assert_eq!(systemd_major("259.1-1-arch"), Some(259));
        assert_eq!(systemd_major("255.4-1ubuntu8"), Some(255));
        assert_eq!(systemd_major("v257"), Some(257));
        assert_eq!(systemd_major("253"), Some(253));
        assert_eq!(systemd_major("unknown"), None);
        assert!(systemd_major("252.9").is_some_and(|major| major < MIN_SYSTEMD_VERSION));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_unit_opens_inputs_read_only_and_drops_everything() {
        let spec = linux::UnitSpec {
            jailer_binary: "/usr/lib/intar/intar-jailer".to_owned(),
            base: "/b".to_owned(),
            delta: "/d".to_owned(),
            out: "/o".to_owned(),
            timeout: Duration::from_secs(60),
            memory_max_bytes: 1 << 30,
        };
        let properties = spec.properties();
        let get = |name: &str| {
            properties
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| format!("{value:?}"))
                .unwrap_or_default()
        };
        let open_files = get("OpenFile");
        assert!(
            open_files.contains(r#"Str("/b"), Str("base"), U64(1)"#),
            "{open_files}"
        );
        assert!(
            open_files.contains(r#"Str("/d"), Str("delta"), U64(1)"#),
            "{open_files}"
        );
        assert!(
            open_files.contains(r#"Str("/o"), Str("out"), U64(0)"#),
            "{open_files}"
        );
        assert!(get("ExecStart").contains("apply-snapdelta"));
        for name in [
            "DynamicUser",
            "PrivateNetwork",
            "NoNewPrivileges",
            "RemainAfterExit",
        ] {
            assert_eq!(
                get(name),
                format!("{:?}", zbus::Variant::new(true)),
                "{name}"
            );
        }
        for name in [
            "CapabilityBoundingSet",
            "AmbientCapabilities",
            "MemorySwapMax",
        ] {
            assert_eq!(
                get(name),
                format!("{:?}", zbus::Variant::new(0_u64)),
                "{name}"
            );
        }
        assert_eq!(
            get("TimeoutStartUSec"),
            format!("{:?}", zbus::Variant::new(60_000_000_u64))
        );
        assert_eq!(
            get("MemoryMax"),
            format!("{:?}", zbus::Variant::new(1_u64 << 30))
        );
    }

    /// A hand-made delta (the format of `intar-snapdelta`): 4 pages in one
    /// chunk; the fork keeps page 0, zeroes page 1 and replaces pages 2 and 3.
    #[cfg(target_os = "linux")]
    pub(crate) fn delta_for(base: &[u8], fork: &[u8]) -> Result<Vec<u8>> {
        const PAGE: usize = 4096;
        let map = [0_u8, 1, 2, 2];
        let map_frame = zstd::bulk::compress(&map, 3)?;
        let data = zstd::bulk::compress(&fork[2 * PAGE..], 3)?;
        assert_eq!(base.len(), 4 * PAGE);
        let mut delta = b"SNPDLT1\0".to_vec();
        delta.extend(4096_u32.to_le_bytes());
        delta.extend(4_u32.to_le_bytes());
        delta.extend(4_u64.to_le_bytes());
        delta.extend(0_u32.to_le_bytes());
        delta.extend(1_u32.to_le_bytes());
        delta.extend((map_frame.len() as u64).to_le_bytes());
        delta.extend(u32::try_from(data.len())?.to_le_bytes());
        delta.extend(map_frame);
        delta.extend(data);
        Ok(delta)
    }

    /// Runs the real sandbox: needs root, systemd >= 253, Landlock ABI 3 and
    /// an `intar-jailer` the dynamic user can execute, at
    /// `INTAR_SNAPDELTA_TEST_JAILER` (not under /root, /home, /tmp or /var/tmp,
    /// which the unit hides).
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "needs root, systemd and a reachable intar-jailer"]
    fn sandboxed_apply_on_this_host() -> Result<()> {
        use std::fs;

        let jailer = std::path::PathBuf::from(std::env::var("INTAR_SNAPDELTA_TEST_JAILER")?);
        assert!(snapdelta_sandbox_available(&jailer));
        let dir = tempfile::tempdir()?;
        let path = |name: &str| dir.path().join(name);
        let page = |byte: u8| vec![byte; 4096];
        let base = [page(1), page(2), page(3), page(4)].concat();
        let fork = [page(1), page(0), page(7), page(8)].concat();
        fs::write(path("base"), &base)?;
        fs::write(path("delta"), delta_for(&base, &fork)?)?;
        let timeout = Duration::from_secs(30);
        let apply = |delta: &str| {
            apply_snapdelta_sandboxed(
                &jailer,
                &path("base"),
                &path(delta),
                &path("out"),
                timeout,
                256 << 20,
            )
        };

        fs::write(path("out"), b"")?;
        apply("delta")?;
        assert_eq!(fs::read(path("out"))?, fork);
        assert_eq!(fs::read(path("base"))?, base);

        // A non-empty out and a bad delta both fail, and nothing is left.
        let error = apply("delta").err().map(|error| format!("{error:#}"));
        assert!(error.is_some_and(|error| error.contains("helper failed")));
        fs::write(path("out"), b"")?;
        fs::write(path("bad"), b"SNPDLT1\0 but nothing that decodes")?;
        assert!(apply("bad").is_err());
        assert_eq!(fs::metadata(path("out"))?.len(), 0);

        // The same unit with a shell probe in place of the helper: what the
        // sandbox itself (before the helper's Landlock) allows and denies.
        let probe = r#"
            set -u
            test "$(id -u)" != 0 || exit 10
            test "$LISTEN_FDNAMES" = base:delta:out || exit 11
            ( echo x >&3 ) 2>/dev/null && exit 12
            ( echo x >&4 ) 2>/dev/null && exit 13
            echo probe >&5 || exit 14
            cat /etc/shadow >/dev/null 2>&1 && exit 15
            ls /root >/dev/null 2>&1 && exit 16
            for dir in /tmp /var/tmp /dev/shm /run /var/lib /etc; do
                touch $dir/intar-snapdelta-probe 2>/dev/null && exit 17
            done
            touch /usr/intar-snapdelta-probe 2>/dev/null && exit 18
            test -e /proc/1/environ && exit 19
            test "$(ls /sys/class/net)" = lo || exit 20
            grep -Eq '^CapEff:[[:space:]]+0+$' /proc/self/status || exit 21
            grep -Eq '^CapBnd:[[:space:]]+0+$' /proc/self/status || exit 22
            grep -Eq '^NoNewPrivs:[[:space:]]+1$' /proc/self/status || exit 23
            grep -Eq '^Seccomp:[[:space:]]+2$' /proc/self/status || exit 24
            test -e /dev/kvm && exit 25
            exit 0
        "#;
        // The unit's properties with `script` run by a shell in place of the
        // helper, and a run time limit of `limit`.
        let shell_unit = |script: &str, limit: Duration| {
            let mut properties = linux::UnitSpec {
                jailer_binary: jailer.to_string_lossy().into_owned(),
                base: path("base").to_string_lossy().into_owned(),
                delta: path("delta").to_string_lossy().into_owned(),
                out: path("out").to_string_lossy().into_owned(),
                timeout: limit,
                memory_max_bytes: 256 << 20,
            }
            .properties();
            let shell = "/bin/sh".to_owned();
            let exec = vec![(
                shell.clone(),
                vec![shell, "-c".to_owned(), script.to_owned()],
                false,
            )];
            for (name, value) in &mut properties {
                if *name == "ExecStart" {
                    *value = zbus::Variant::new(exec.clone());
                }
            }
            properties
        };
        fs::write(path("out"), b"")?;
        linux::run_unit(shell_unit(probe, timeout), timeout)?;
        assert_eq!(fs::read(path("out"))?, b"probe\n");
        assert_eq!(fs::read(path("base"))?, base);

        // systemd ends a helper that overruns its time limit, and the
        // unit is still removed.
        let started = std::time::Instant::now();
        let error = linux::run_unit(
            shell_unit("sleep 60", Duration::from_secs(1)),
            Duration::from_secs(11),
        )
        .err()
        .map(|error| format!("{error:#}"));
        assert!(error.is_some_and(|error| error.contains("result timeout")));
        assert!(started.elapsed() < Duration::from_secs(10));
        Ok(())
    }
}
