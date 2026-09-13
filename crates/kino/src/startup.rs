//! Versioned guest startup channels.
//!
//! The guest runtime supervisor creates the startup channel as a root-only
//! named pipe before it starts Kino and reads the channel itself. Kino runs as
//! root in the guest, so it can write the channel. An unprivileged learner
//! shell can not write it.
//!
//! * `KINO_READY_FIFO` carries one startup ACK line. The supervisor uses the
//!   ACK to decide that the probe service is ready. It does not use a fixed
//!   wait after the spawn.
//!
//! The channel is optional only for Kino that runs outside the scenario
//! guest. In a guest image (`INTAR_GUEST_BOOTSTRAP_ABI` is set) the channel
//! is required: the supervisor has no other readiness source. A channel that
//! is set but unusable is always a startup error.

use std::path::Path;

pub(crate) const ENV_KINO_READY_FIFO: &str = "KINO_READY_FIFO";
pub(crate) const ENV_KINO_SHA256: &str = "INTAR_KINO_SHA256";
pub(crate) const ENV_GUEST_BOOTSTRAP_ABI: &str = "INTAR_GUEST_BOOTSTRAP_ABI";

const ACK_TOKEN: &str = "INTAR_KINO_READY";
const CHANNEL_VERSION: &str = "v2";
/// Owner and mode that the guest runtime supervisor must use for the channel.
#[cfg(target_os = "linux")]
const CHANNEL_UID: u32 = 0;
#[cfg(target_os = "linux")]
const CHANNEL_MODE: u32 = 0o600;

/// The startup ACK line. The supervisor parses exactly these fields in this
/// order and rejects every other version.
pub(crate) fn ready_line(sha256: &str, pid: u32) -> String {
    format!("{ACK_TOKEN} {CHANNEL_VERSION} sha256={sha256} pid={pid}\n")
}

/// Publish the startup ACK.
///
/// Call this after every listener is bound, the serve task is polled, and
/// every background task is spawned. A failure here must stop the process:
/// the supervisor treats a missing ACK as a failed boot.
pub(crate) fn publish_ready() -> anyhow::Result<()> {
    let path = match ready_channel_path(
        std::env::var(ENV_KINO_READY_FIFO).ok(),
        std::env::var_os(ENV_GUEST_BOOTSTRAP_ABI).is_some(),
    )? {
        Some(path) => path,
        None => {
            return Ok(());
        }
    };
    let sha256 = std::env::var(ENV_KINO_SHA256).unwrap_or_default();
    anyhow::ensure!(
        is_lower_hex_sha256(&sha256),
        "{ENV_KINO_SHA256} is missing or invalid; the startup ACK cannot bind to this Kino build"
    );
    write_channel_line(&path, &ready_line(&sha256, std::process::id()))
        .map_err(|error| anyhow::anyhow!("failed to publish the startup ACK to {path}: {error}"))?;
    eprintln!("kino startup ACK published to {path}");
    Ok(())
}

/// Decide the startup channel path for one boot.
///
/// Guest Kino must publish the ACK, because the runtime supervisor waits for
/// it and has no other readiness source. Kino also runs outside the guest,
/// where no supervisor waits and no channel exists.
fn ready_channel_path(raw: Option<String>, guest_boot: bool) -> anyhow::Result<Option<String>> {
    let raw = raw.filter(|value| !value.is_empty());
    let Some(raw) = raw else {
        anyhow::ensure!(
            !guest_boot,
            "{ENV_KINO_READY_FIFO} is required when {ENV_GUEST_BOOTSTRAP_ABI} is set"
        );
        return Ok(None);
    };
    anyhow::ensure!(
        Path::new(&raw).is_absolute(),
        "{ENV_KINO_READY_FIFO} must be an absolute path: {raw}"
    );
    Ok(Some(raw))
}

pub(crate) fn is_lower_hex_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

/// Write one line to the named pipe that the runtime supervisor created.
///
/// The open uses `O_NOFOLLOW` and never waits for a reader. The open then
/// verifies the channel type, the owner, and the mode, so Kino cannot be
/// redirected to write a regular file or a pipe that another user controls.
#[cfg(target_os = "linux")]
pub(crate) fn write_channel_line(path: &str, line: &str) -> anyhow::Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::{FileTypeExt as _, MetadataExt as _, OpenOptionsExt as _};

    let flags = rustix::fs::OFlags::NONBLOCK.bits() | rustix::fs::OFlags::NOFOLLOW.bits();
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .custom_flags(flags as i32)
        .open(path)?;
    let metadata = file.metadata()?;
    anyhow::ensure!(
        metadata.file_type().is_fifo(),
        "guest startup channel is not a named pipe: {path}"
    );
    anyhow::ensure!(
        metadata.uid() == CHANNEL_UID,
        "guest startup channel is not owned by root: {path}"
    );
    anyhow::ensure!(
        metadata.mode() & 0o777 == CHANNEL_MODE,
        "guest startup channel mode is not {CHANNEL_MODE:o}: {path}"
    );
    file.write_all(line.as_bytes())?;
    file.flush()?;
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn write_channel_line(path: &str, _line: &str) -> anyhow::Result<()> {
    anyhow::bail!("guest startup channels are only supported on Linux: {path}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_line_carries_version_digest_and_pid() {
        assert_eq!(
            ready_line(&"a".repeat(64), 4242),
            format!("INTAR_KINO_READY v2 sha256={} pid=4242\n", "a".repeat(64))
        );
    }

    #[test]
    fn sha256_check_rejects_short_and_uppercase_digests() {
        assert!(is_lower_hex_sha256(&"a".repeat(64)));
        assert!(!is_lower_hex_sha256(&"a".repeat(63)));
        assert!(!is_lower_hex_sha256(&"A".repeat(64)));
        assert!(!is_lower_hex_sha256(""));
    }

    #[test]
    fn guest_ack_requires_a_channel_and_an_absolute_path() {
        assert!(
            ready_channel_path(None, true).is_err(),
            "a guest boot without a channel must fail"
        );
        assert!(
            ready_channel_path(Some("relative.fifo".to_owned()), false).is_err(),
            "a relative channel path must fail"
        );
        assert!(
            ready_channel_path(None, false)
                .expect("Kino outside the guest needs no channel")
                .is_none()
        );
        assert_eq!(
            ready_channel_path(Some("/run/intar/kino-ready.fifo".to_owned()), true)
                .expect("a guest boot with a channel"),
            Some("/run/intar/kino-ready.fifo".to_owned())
        );
        assert_eq!(
            ready_channel_path(Some(String::new()), false).expect("an empty value means absent"),
            None
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn channel_write_accepts_the_supervisor_pipe_and_rejects_other_paths() {
        use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};

        let temp = tempfile::tempdir().expect("temp dir");
        let fifo = temp.path().join("kino-ready.fifo");
        assert!(
            std::process::Command::new("mkfifo")
                .arg(&fifo)
                .status()
                .expect("run mkfifo")
                .success()
        );
        // A FIFO holds no data of its own, so an open can fail before the
        // checks under test run: a write-only open with no reader fails with
        // ENXIO, and a blocking read-only open waits for a writer that never
        // comes. One read-write keeper handle holds both ends open for the
        // whole test. The production open stays write-only, non-blocking, and
        // no-follow.
        let _keeper = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&fifo)
            .expect("open the pipe read-write as the keeper");
        // The guest supervisor creates the pipe as root with mode 0600. This
        // test process owns its own pipe, so it also owns the root check.
        if std::fs::metadata(temp.path()).expect("metadata").uid() != 0 {
            // A non-root test process can still prove the type checks.
            std::fs::set_permissions(&fifo, std::fs::Permissions::from_mode(0o600))
                .expect("set fifo mode");
            let error = write_channel_line(fifo.to_str().expect("fifo path"), "line\n")
                .expect_err("a non-root pipe owner must be rejected");
            assert!(error.to_string().contains("owned by root"), "{error}");
            let regular = temp.path().join("regular");
            std::fs::write(&regular, b"").expect("write regular file");
            let error = write_channel_line(regular.to_str().expect("path"), "line\n")
                .expect_err("a regular file must be rejected");
            assert!(
                error.to_string().contains("not a named pipe")
                    || error
                        .to_string()
                        .contains("Too many levels of symbolic links"),
                "{error}"
            );
            return;
        }

        std::fs::set_permissions(&fifo, std::fs::Permissions::from_mode(0o600))
            .expect("set fifo mode");
        let reader = std::fs::OpenOptions::new()
            .read(true)
            .open(&fifo)
            .expect("open fifo for reading");
        write_channel_line(fifo.to_str().expect("fifo path"), "ready\n")
            .expect("write to the supervisor pipe");
        let mut line = String::new();
        std::io::BufRead::read_line(&mut std::io::BufReader::new(reader), &mut line)
            .expect("read the ack line");
        assert_eq!(line, "ready\n");
    }
}
