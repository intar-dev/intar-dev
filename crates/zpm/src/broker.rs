//! The run CLI's broker: what the learner's `intar` command in a guest talks
//! to for status, hints and the solution.
//!
//! Kino opens one connection per command and sends one length-prefixed JSON
//! request. The broker answers it through `answer`, which the app implements
//! by asking intar. Shell completion is the exception: it is answered here,
//! from the aliases of the last view that passed through, so pressing Tab
//! never waits on the network and never shows an error.
//!
//! The behaviour follows intar-agent's broker (`vm/manager/run_cli.rs`): a
//! request that is malformed or late gets no answer at all, and the number of
//! commands in flight is bounded, because the guest is not trusted.
//
// ponytail: TCP on the loopback interface only; a Linux host over vsock and
// the app's own network (#408) come with their listeners.

use std::io::{Read as _, Write as _};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use intar_contracts::run_cli::{
    RUN_CLI_FRAME_HEADER_BYTES, RUN_CLI_MAX_COMPLETION_ALIASES, RUN_CLI_PROTOCOL_VERSION,
    RunCliActionV1, RunCliRequestV1, RunCliResponseV1, RunCliResultV1, RunCliViewV1,
    decode_run_cli_frame, encode_run_cli_frame, run_cli_frame_payload_len,
};

/// A guest has to send its one request promptly.
const READ_TIMEOUT: Duration = Duration::from_secs(2);
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the aliases of a view stay good for completion.
const COMPLETION_TTL: Duration = Duration::from_secs(15);
const MAX_CONNECTIONS: usize = 16;

/// One machine's broker. The listener is on a free loopback port and closes
/// when this is dropped.
pub struct RunCliBroker {
    pub port: u16,
    stop: Arc<AtomicBool>,
}

impl Drop for RunCliBroker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

#[derive(Default)]
struct Completion {
    aliases: Vec<String>,
    valid_until: Option<Instant>,
}

/// Serves one machine's run CLI. `answer` gets every request except shell
/// completion; `None` from it closes the connection without an answer, which
/// the CLI reports as the workspace being unavailable.
pub fn serve_tcp(
    answer: impl Fn(&RunCliRequestV1) -> Option<RunCliResponseV1> + Send + Sync + 'static,
) -> std::io::Result<RunCliBroker> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = stop.clone();
    let answer = Arc::new(answer);
    let completion = Arc::new(Mutex::new(Completion::default()));
    let open = Arc::new(AtomicUsize::new(0));
    std::thread::Builder::new()
        .name("zpm-run-cli".into())
        .spawn(move || {
            while !stopped.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        // Over the bound a connection is dropped, not queued.
                        if open.fetch_add(1, Ordering::Relaxed) >= MAX_CONNECTIONS {
                            open.fetch_sub(1, Ordering::Relaxed);
                            continue;
                        }
                        let (answer, completion, open) =
                            (answer.clone(), completion.clone(), open.clone());
                        let spawned = std::thread::Builder::new()
                            .name("zpm-run-cli-command".into())
                            .spawn({
                                let open = open.clone();
                                move || {
                                    let _ = handle(stream, answer.as_ref(), &completion);
                                    open.fetch_sub(1, Ordering::Relaxed);
                                }
                            });
                        if spawned.is_err() {
                            open.fetch_sub(1, Ordering::Relaxed);
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    Err(_) => break,
                }
            }
        })?;
    Ok(RunCliBroker { port, stop })
}

fn handle(
    mut stream: TcpStream,
    answer: &(impl Fn(&RunCliRequestV1) -> Option<RunCliResponseV1> + ?Sized),
    completion: &Mutex<Completion>,
) -> Option<()> {
    stream.set_nonblocking(false).ok()?;
    stream.set_read_timeout(Some(READ_TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(WRITE_TIMEOUT)).ok()?;
    let mut header = [0_u8; RUN_CLI_FRAME_HEADER_BYTES];
    stream.read_exact(&mut header).ok()?;
    let length = run_cli_frame_payload_len(header).ok()?;
    let mut frame = header.to_vec();
    frame.resize(RUN_CLI_FRAME_HEADER_BYTES + length, 0);
    stream
        .read_exact(&mut frame[RUN_CLI_FRAME_HEADER_BYTES..])
        .ok()?;
    let request: RunCliRequestV1 = decode_run_cli_frame(&frame).ok()?;
    request.validate().ok()?;

    let response = if matches!(request.action, RunCliActionV1::Completion) {
        let cached = completion.lock().ok()?;
        let fresh = cached
            .valid_until
            .is_some_and(|until| Instant::now() < until);
        RunCliResponseV1 {
            protocol_version: RUN_CLI_PROTOCOL_VERSION,
            request_id: request.request_id.clone(),
            result: RunCliResultV1::Completion {
                aliases: if fresh {
                    cached.aliases.clone()
                } else {
                    Vec::new()
                },
            },
        }
    } else {
        let response = answer(&request)?;
        // An answer for another request, or of the wrong shape, is not passed on.
        if response.request_id != request.request_id {
            return None;
        }
        let mut cached = completion.lock().ok()?;
        match &response.result {
            RunCliResultV1::Ok { view } => {
                cached.aliases = completion_aliases(view);
                cached.valid_until = Some(Instant::now() + COMPLETION_TTL);
            }
            _ => *cached = Completion::default(),
        }
        response
    };
    response.validate_for_action(&request.action).ok()?;
    stream
        .write_all(&encode_run_cli_frame(&response).ok()?)
        .ok()?;
    stream.flush().ok()
}

/// The aliases a learner may reveal a hint for right now, and nothing else
/// of the view: completion never carries titles, bodies or check names.
fn completion_aliases(view: &RunCliViewV1) -> Vec<String> {
    let mut aliases: Vec<String> = view
        .hint_groups
        .iter()
        .filter(|group| group.can_reveal)
        .map(|group| group.alias.clone())
        .filter(|alias| {
            alias
                .bytes()
                .next()
                .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
                && alias
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
        .collect();
    aliases.sort_unstable();
    aliases.dedup();
    aliases.truncate(RUN_CLI_MAX_COMPLETION_ALIASES);
    aliases
}

#[cfg(test)]
mod tests {
    use super::*;

    const VIEW: &str = include_str!("../../intar-contracts/fixtures/run-cli/response-v1.json");

    fn request(id: &str, action: RunCliActionV1) -> RunCliRequestV1 {
        RunCliRequestV1 {
            protocol_version: RUN_CLI_PROTOCOL_VERSION,
            request_id: id.to_owned(),
            action,
        }
    }

    /// One command as Kino sends it: a connection, a frame, the answer if any.
    fn ask(port: u16, frame: &[u8]) -> Option<RunCliResponseV1> {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("timeout");
        stream.write_all(frame).expect("write");
        let mut answer = Vec::new();
        stream.read_to_end(&mut answer).ok()?;
        decode_run_cli_frame(&answer).ok()
    }

    fn frame(request: &RunCliRequestV1) -> Vec<u8> {
        encode_run_cli_frame(request).expect("frame")
    }

    #[test]
    fn answers_commands_through_the_app_and_completion_from_its_cache() {
        let asked = Arc::new(AtomicUsize::new(0));
        let counted = asked.clone();
        let broker = serve_tcp(move |request| {
            counted.fetch_add(1, Ordering::Relaxed);
            let mut response: RunCliResponseV1 = serde_json::from_str(VIEW).expect("fixture");
            // `stale` stands for an answer that belongs to another request.
            if request.request_id != "stale" {
                response.request_id.clone_from(&request.request_id);
            }
            (request.request_id != "silent").then_some(response)
        })
        .expect("serve");
        let port = broker.port;

        // Before any view has passed through, Tab completes nothing, and asks nobody.
        let empty =
            ask(port, &frame(&request("c0", RunCliActionV1::Completion))).expect("completion");
        assert_eq!(empty.result, RunCliResultV1::Completion { aliases: vec![] });
        assert_eq!(asked.load(Ordering::Relaxed), 0);

        let status = ask(port, &frame(&request("s1", RunCliActionV1::Status))).expect("status");
        assert_eq!(status.request_id, "s1");
        assert!(matches!(status.result, RunCliResultV1::Ok { .. }));

        // Now completion offers the aliases that view allowed, still without asking.
        let offered =
            ask(port, &frame(&request("c1", RunCliActionV1::Completion))).expect("completion");
        assert_eq!(
            offered.result,
            RunCliResultV1::Completion {
                aliases: vec!["check-3".to_owned(), "general".to_owned()]
            }
        );
        assert_eq!(asked.load(Ordering::Relaxed), 1);

        // No answer from the app, an answer for another request, and garbage: the guest gets nothing.
        assert!(ask(port, &frame(&request("silent", RunCliActionV1::Status))).is_none());
        assert!(ask(port, &frame(&request("stale", RunCliActionV1::Status))).is_none());
        assert!(ask(port, &[0, 0, 0, 2, b'{', b'}']).is_none());
        assert!(ask(port, &u32::MAX.to_be_bytes()).is_none());
        // The broker still serves after those.
        assert!(ask(port, &frame(&request("s2", RunCliActionV1::Status))).is_some());

        drop(broker);
        std::thread::sleep(Duration::from_millis(100));
        assert!(
            TcpStream::connect(("127.0.0.1", port)).is_err(),
            "the port is closed"
        );
    }
}
