//! First-recording event for the guest lab-release channel.
//!
//! The event says that one authenticated, recorded terminal session is live.
//! The guest runtime supervisor starts the heavy lab services after the first
//! event, or after its own fallback timer, so a student who never opens a
//! terminal still gets a complete lab.
//!
//! Path of the event:
//!
//! 1. The recorder process (`kino record-ssh`/`record-command`) runs as the
//!    recording user. It can not write the root-only release channel.
//! 2. The recorder sends one bounded request to the existing Kino control
//!    socket.
//! 3. The probe service runs as root. It checks the peer credentials, then
//!    writes the event line to the root-only release channel.
//! 4. The supervisor reads the release channel and starts the lab.
//!
//! The request carries one fixed action value. There is no command, no unit
//! name, and no argument, so no shell can ask for an arbitrary systemd action.
//! The release is a timing signal, not a security boundary: the guest is a
//! single-user environment with passwordless sudo.

use crate::run_cli_wire::write_message;
#[cfg(target_os = "linux")]
use intar_contracts::run_cli::{RUN_CLI_FRAME_HEADER_BYTES, run_cli_frame_payload_len};
use serde::{Deserialize, Serialize};
#[cfg(target_os = "linux")]
use std::io::{Read as _, Write as _};
#[cfg(target_os = "linux")]
use std::time::Duration;

pub(crate) const ENV_KINO_LAB_RELEASE_FIFO: &str = "KINO_LAB_RELEASE_FIFO";
pub(crate) const ENV_KINO_LAB_RELEASE_UID: &str = "KINO_LAB_RELEASE_UID";
pub(crate) const ENV_VM_HOSTNAME: &str = "INTAR_VM_HOSTNAME";

pub(crate) const LAB_RELEASE_PROTOCOL_VERSION: u16 = 1;

const EVENT_TOKEN: &str = "INTAR_EVENT";
const CHANNEL_VERSION: &str = "v2";
const RECORDING_STARTED_EVENT: &str = "recording_started";
/// The recorder must not delay the learner's first command. One short attempt
/// on a detached thread is enough, because the supervisor also releases the
/// lab from its fallback timer.
///
/// ponytail: the connect call itself is unbounded, but a Unix socket connect
/// is immediate for a live socket and fails at once for an absent one, and the
/// whole call already runs off the terminal path. Add a poll-based connect
/// deadline only if a real guest shows a stall.
#[cfg(target_os = "linux")]
const RECORDER_IO_TIMEOUT: Duration = Duration::from_millis(100);

/// One bounded request from a recorder process.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "snake_case")]
pub(crate) struct LabReleaseRequestV1 {
    pub protocol_version: u16,
    pub request_id: String,
    pub action: LabReleaseActionV1,
}

/// The only action a recorder can request.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum LabReleaseActionV1 {
    RecordingStarted,
}

impl LabReleaseRequestV1 {
    /// Built by the recorder, which exists on Linux only.
    #[cfg(any(target_os = "linux", test))]
    pub(crate) fn recording_started(request_id: String) -> Self {
        Self {
            protocol_version: LAB_RELEASE_PROTOCOL_VERSION,
            request_id,
            action: LabReleaseActionV1::RecordingStarted,
        }
    }

    pub(crate) fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.protocol_version == LAB_RELEASE_PROTOCOL_VERSION,
            "unsupported lab release protocol version {}",
            self.protocol_version
        );
        anyhow::ensure!(
            !self.request_id.is_empty() && self.request_id.len() <= 128,
            "invalid lab release request id"
        );
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "snake_case")]
pub(crate) struct LabReleaseResponseV1 {
    pub protocol_version: u16,
    pub request_id: String,
    pub accepted: bool,
}

/// The event line for the release channel.
pub(crate) fn recording_started_line(vm_hostname: &str, pid: u32) -> String {
    format!(
        "{EVENT_TOKEN} {CHANNEL_VERSION} {RECORDING_STARTED_EVENT} vm={vm_hostname} kino={pid}\n"
    )
}

/// Publish the event to the root-only release channel.
///
/// The probe service calls this after it accepts a recorder request. The
/// supervisor also releases the lab from its fallback timer, so a missing
/// channel must never end the probe service.
pub(crate) fn publish_recording_started() {
    let Ok(path) = std::env::var(ENV_KINO_LAB_RELEASE_FIFO) else {
        return;
    };
    if path.is_empty() {
        return;
    }
    let vm_hostname = std::env::var(ENV_VM_HOSTNAME).unwrap_or_default();
    match crate::startup::write_channel_line(
        &path,
        &recording_started_line(&vm_hostname, std::process::id()),
    ) {
        Ok(()) => eprintln!("kino recording event published to {path}"),
        Err(error) => eprintln!("kino recording event was not published: {error}"),
    }
}

/// Accept a recorder request from an already framed control message.
pub(crate) async fn handle_request(
    stream: &mut tokio::net::UnixStream,
    request: LabReleaseRequestV1,
    peer: PeerIdentity,
) -> anyhow::Result<()> {
    request.validate()?;
    let accepted = match authorize_peer(peer, configured_recording_uid()) {
        Ok(()) => {
            publish_recording_started();
            true
        }
        Err(reason) => {
            eprintln!(
                "kino refused lab release request {} from uid {}: {reason}",
                request.request_id, peer.uid
            );
            false
        }
    };
    write_message(
        stream,
        &LabReleaseResponseV1 {
            protocol_version: LAB_RELEASE_PROTOCOL_VERSION,
            request_id: request.request_id,
            accepted,
        },
    )
    .await?;
    Ok(())
}

/// The peer credentials of one control connection.
#[derive(Clone, Copy, Debug)]
pub(crate) struct PeerIdentity {
    pub uid: u32,
    pub pid: Option<u32>,
}

fn configured_recording_uid() -> Option<u32> {
    std::env::var(ENV_KINO_LAB_RELEASE_UID)
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
}

/// A recorder request is authorized when the peer runs as the recording user
/// and the peer executable is this Kino build.
fn authorize_peer(peer: PeerIdentity, recording_uid: Option<u32>) -> Result<(), &'static str> {
    let expected_uid = recording_uid.ok_or("the recording user is not configured")?;
    if peer.uid != expected_uid {
        return Err("the peer is not the recording user");
    }
    let peer_pid = peer.pid.ok_or("the peer process id is not known")?;
    let Ok(current) = std::env::current_exe() else {
        return Err("the Kino executable path is not known");
    };
    let Ok(peer_exe) = std::fs::read_link(format!("/proc/{peer_pid}/exe")) else {
        return Err("the peer executable is not readable");
    };
    if peer_exe != current {
        return Err("the peer is not a Kino recorder");
    }
    Ok(())
}

/// Report one live recording from the recorder process, best effort.
///
/// This returns immediately. The request runs on a detached thread with short
/// timeouts, so a slow or absent control socket never delays the recorded
/// command or the terminal I/O path.
#[cfg(target_os = "linux")]
pub(crate) fn notify_recording_started(request_id: &str) {
    let request_id = request_id.to_owned();
    // The thread is detached on purpose. The process exits when the session
    // ends, and the supervisor's fallback timer covers a lost request.
    let spawned = std::thread::Builder::new()
        .name("kino-lab-release".to_owned())
        .spawn(move || {
            if let Err(error) = send_recording_started(&request_id) {
                eprintln!("kino lab release request was not accepted: {error}");
            }
        });
    if let Err(error) = spawned {
        eprintln!("kino lab release request was not sent: {error}");
    }
}

#[cfg(target_os = "linux")]
fn send_recording_started(request_id: &str) -> anyhow::Result<()> {
    let path = crate::run_cli_control::configured_socket_path();
    let request = LabReleaseRequestV1::recording_started(request_id.to_owned());
    let frame = intar_contracts::run_cli::encode_run_cli_frame(&request)
        .map_err(|error| anyhow::anyhow!("lab release frame was not encoded: {error}"))?;
    let mut stream = std::os::unix::net::UnixStream::connect(&path).map_err(|error| {
        anyhow::anyhow!(
            "control socket {} is not reachable: {error}",
            path.display()
        )
    })?;
    stream.set_write_timeout(Some(RECORDER_IO_TIMEOUT))?;
    stream.set_read_timeout(Some(RECORDER_IO_TIMEOUT))?;
    stream.write_all(&frame)?;
    stream.flush()?;

    let response: LabReleaseResponseV1 = read_frame_blocking(&mut stream)?;
    anyhow::ensure!(
        response.protocol_version == LAB_RELEASE_PROTOCOL_VERSION,
        "unsupported lab release response version {}",
        response.protocol_version
    );
    anyhow::ensure!(
        response.request_id == request.request_id,
        "lab release response does not match the request"
    );
    anyhow::ensure!(response.accepted, "the probe service refused the request");
    Ok(())
}

#[cfg(target_os = "linux")]
fn read_frame_blocking<T>(stream: &mut std::os::unix::net::UnixStream) -> anyhow::Result<T>
where
    T: serde::de::DeserializeOwned,
{
    let mut prefix = [0_u8; RUN_CLI_FRAME_HEADER_BYTES];
    stream.read_exact(&mut prefix)?;
    let payload_len = run_cli_frame_payload_len(prefix)
        .map_err(|error| anyhow::anyhow!("lab release response frame is invalid: {error}"))?;
    let mut frame = Vec::with_capacity(RUN_CLI_FRAME_HEADER_BYTES + payload_len);
    frame.extend_from_slice(&prefix);
    frame.resize(RUN_CLI_FRAME_HEADER_BYTES + payload_len, 0);
    stream.read_exact(&mut frame[RUN_CLI_FRAME_HEADER_BYTES..])?;
    intar_contracts::run_cli::decode_run_cli_frame(&frame)
        .map_err(|error| anyhow::anyhow!("lab release response frame is invalid: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recording_event_carries_the_known_event_value() {
        assert_eq!(
            recording_started_line("klustered-server", 4242),
            "INTAR_EVENT v2 recording_started vm=klustered-server kino=4242\n"
        );
    }

    #[test]
    fn the_request_accepts_only_the_recording_started_action() {
        let request = LabReleaseRequestV1::recording_started("request-1".to_owned());
        request.validate().expect("valid request");
        assert_eq!(
            serde_json::to_string(&request).expect("serialize request"),
            "{\"protocol_version\":1,\"request_id\":\"request-1\",\"action\":\"recording_started\"}"
        );
        assert!(
            serde_json::from_str::<LabReleaseRequestV1>(
                "{\"protocol_version\":1,\"request_id\":\"r\",\"action\":\"start_unit\"}"
            )
            .is_err(),
            "an unknown action must not deserialize"
        );
        assert!(
            serde_json::from_str::<LabReleaseRequestV1>(
                "{\"protocol_version\":1,\"request_id\":\"r\",\"action\":\"recording_started\",\"unit\":\"k3s\"}"
            )
            .is_err(),
            "an extra field must not deserialize"
        );
    }

    #[test]
    fn validation_rejects_a_foreign_protocol_version_and_an_empty_request_id() {
        let mut request = LabReleaseRequestV1::recording_started("request-1".to_owned());
        request.protocol_version = 2;
        assert!(request.validate().is_err());
        let request = LabReleaseRequestV1::recording_started(String::new());
        assert!(request.validate().is_err());
    }

    #[test]
    fn authorization_rejects_a_peer_that_is_not_the_recording_user() {
        let foreign_user = PeerIdentity {
            uid: 1001,
            pid: Some(std::process::id()),
        };
        assert_eq!(
            authorize_peer(foreign_user, Some(1000)),
            Err("the peer is not the recording user")
        );
        assert_eq!(
            authorize_peer(foreign_user, None),
            Err("the recording user is not configured")
        );
        // This test process runs the test binary, not the Kino probe binary,
        // so the executable check must refuse it as well.
        let same_user = PeerIdentity {
            uid: 1000,
            pid: Some(std::process::id()),
        };
        assert!(authorize_peer(same_user, Some(1000)).is_err());
    }
}
