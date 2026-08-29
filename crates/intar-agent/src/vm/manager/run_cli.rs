use super::*;

#[cfg(test)]
use intar_contracts::run_cli::RUN_CLI_PROTOCOL_VERSION;
#[cfg(any(target_os = "linux", test))]
use intar_contracts::run_cli::{
    RUN_CLI_FRAME_HEADER_BYTES, RUN_CLI_MAX_FRAME_BYTES, RunCliRequestV1, RunCliResponseV1,
    RunCliResultV1, run_cli_frame_payload_len,
};
#[cfg(target_os = "linux")]
use intar_contracts::run_cli::{decode_run_cli_frame, encode_run_cli_frame};

#[cfg(target_os = "linux")]
const RUN_CLI_HOST_PORT: u32 = 18_082;
#[cfg(any(target_os = "linux", test))]
const RUN_CLI_READ_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(target_os = "linux")]
const RUN_CLI_WRITE_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(target_os = "linux")]
const RUN_CLI_ACCESS_REFRESH_TIMEOUT: Duration = Duration::from_secs(5);

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, thiserror::Error)]
#[error("control-plane rejected agent authentication")]
struct RunCliAuthenticationRejected;

/// Cloud Hypervisor's hybrid vsock transport forwards a guest connection to
/// host CID 2, port [`RUN_CLI_HOST_PORT`] to this Unix socket. The socket is
/// scoped to the VM's existing vsock device, so a guest cannot choose another
/// VM's listener or attach a run identity to the request.
#[cfg(target_os = "linux")]
pub(super) fn run_cli_socket_path(kino_vsock_path: &Path) -> PathBuf {
    let mut os = kino_vsock_path.as_os_str().to_owned();
    os.push(format!("_{RUN_CLI_HOST_PORT}"));
    PathBuf::from(os)
}

pub(super) async fn start_run_cli_broker(
    inner: &Arc<Inner>,
    vm_name: &str,
    details: &VmDetails,
) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        let run_id = details
            .run_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .ok_or_else(|| anyhow::anyhow!("vm details missing run_id"))?;
        let jail_generation = details
            .jail_generation
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .ok_or_else(|| anyhow::anyhow!("vm details missing jail_generation"))?;
        let kino_vsock_path = details
            .kino_vsock_path
            .as_deref()
            .map(PathBuf::from)
            .ok_or_else(|| anyhow::anyhow!("vm details missing kino_vsock_path"))?;
        let jail_uid = details
            .jail_uid
            .ok_or_else(|| anyhow::anyhow!("vm details missing jail_uid"))?;

        stop_run_cli_broker(inner, vm_name).await;
        let (listener, socket_path) = prepare_run_cli_listener(&kino_vsock_path, jail_uid).await?;

        let inner_for_task = Arc::clone(inner);
        let vm_name_owned = vm_name.to_string();
        let join = tokio::spawn(async move {
            run_run_cli_broker_task(
                inner_for_task,
                vm_name_owned,
                run_id,
                jail_generation,
                listener,
                socket_path,
            )
            .await;
        });
        let mut tasks = inner.run_cli_broker_tasks.lock().await;
        tasks.insert(vm_name.to_string(), VmRunCliBrokerTask { join });
        Ok(())
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = details;
        stop_run_cli_broker(inner, vm_name).await;
        Ok(())
    }
}

pub(super) async fn stop_run_cli_broker(inner: &Inner, vm_name: &str) {
    let task = {
        let mut tasks = inner.run_cli_broker_tasks.lock().await;
        tasks.remove(vm_name)
    };
    if let Some(task) = task {
        task.join.abort();
    }
}

#[cfg(target_os = "linux")]
async fn prepare_run_cli_listener(
    kino_vsock_path: &Path,
    jail_uid: u32,
) -> Result<(tokio::net::UnixListener, PathBuf)> {
    let socket_path = run_cli_socket_path(kino_vsock_path);
    let _ = tokio::fs::remove_file(&socket_path).await;
    let listener = tokio::net::UnixListener::bind(&socket_path)
        .with_context(|| format!("bind guest run CLI listener at {}", socket_path.display()))?;

    // This is the same VM-UID ACL activation used by the Kino readiness
    // listener. In particular, it pins the untrusted jail-owned parent and
    // never grants access to other local users.
    if let Err(error) = activate_kino_ready_socket(&socket_path, jail_uid).await {
        let _ = tokio::fs::remove_file(&socket_path).await;
        return Err(error).context("activate run CLI listener socket ACL mask");
    }
    Ok((listener, socket_path))
}

#[cfg(target_os = "linux")]
async fn run_run_cli_broker_task(
    inner: Arc<Inner>,
    vm_name: String,
    run_id: String,
    jail_generation: String,
    listener: tokio::net::UnixListener,
    socket_path: PathBuf,
) {
    info!(
        vm = vm_name,
        path = %socket_path.display(),
        "listening for guest run CLI requests"
    );

    let mut liveness = tokio::time::interval(Duration::from_secs(PROBE_POLL_INTERVAL_SECONDS));
    liveness.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _)) => {
                        // Each CLI invocation sends exactly one request and receives exactly one
                        // response. Keeping this serial also bounds one guest's concurrent
                        // control-plane requests without introducing a guest-controlled queue.
                        if let Err(error) = handle_run_cli_connection(
                            &inner,
                            &vm_name,
                            &run_id,
                            &jail_generation,
                            stream,
                        ).await {
                            debug!(error = %error, vm = vm_name, "guest run CLI request ended without a response");
                        }
                    }
                    Err(error) => {
                        warn!(error = %error, vm = vm_name, "failed to accept guest run CLI request");
                    }
                }
            }
            _ = liveness.tick() => {
                if !run_cli_broker_is_current(&inner, &vm_name, &run_id, &jail_generation).await {
                    break;
                }
            }
        }
    }

    let _ = tokio::fs::remove_file(&socket_path).await;
}

#[cfg(target_os = "linux")]
async fn handle_run_cli_connection(
    inner: &Inner,
    vm_name: &str,
    run_id: &str,
    jail_generation: &str,
    mut stream: tokio::net::UnixStream,
) -> Result<()> {
    use tokio::io::AsyncWriteExt as _;

    let Some(frame) = read_run_cli_frame(&mut stream).await? else {
        // A disconnected command is normal (for example Ctrl-C before Kino
        // has finished writing its request). It must not disturb the listener.
        return Ok(());
    };
    let request =
        decode_run_cli_frame::<RunCliRequestV1>(&frame).context("decode guest run CLI request")?;
    request
        .validate()
        .context("validate guest run CLI request")?;

    anyhow::ensure!(
        run_cli_request_is_current(inner, vm_name, run_id, jail_generation).await,
        "guest run CLI request belongs to a stale VM generation"
    );
    let response = if matches!(
        &request.action,
        intar_contracts::run_cli::RunCliActionV1::Status
    ) {
        tokio::select! {
            response = forward_run_cli_request(inner, vm_name, run_id, jail_generation, &request) => {
                response.context("forward guest run CLI request")?
            }
            peer = wait_for_run_cli_peer_close(&stream) => {
                peer?;
                return Ok(());
            }
        }
    } else {
        forward_run_cli_request(inner, vm_name, run_id, jail_generation, &request)
            .await
            .context("forward guest run CLI request")?
    };
    anyhow::ensure!(
        run_cli_request_is_current(inner, vm_name, run_id, jail_generation).await,
        "guest run CLI response belongs to a stale VM generation"
    );
    response
        .validate()
        .context("validate control-plane run CLI response")?;
    anyhow::ensure!(
        response.request_id == request.request_id,
        "control-plane run CLI response request ID does not match"
    );

    let response_frame =
        encode_run_cli_frame(&response).context("encode guest run CLI response")?;
    anyhow::ensure!(
        response_frame.len() <= RUN_CLI_MAX_FRAME_BYTES + RUN_CLI_FRAME_HEADER_BYTES,
        "encoded guest run CLI response exceeds the frame limit"
    );
    timeout(RUN_CLI_WRITE_TIMEOUT, async {
        stream.write_all(&response_frame).await?;
        stream.flush().await
    })
    .await
    .context("guest run CLI response write timed out")??;
    Ok(())
}

/// A Status request is read-only, and the client sends no more bytes after its
/// one request frame. Completion kills its client at the 250 ms deadline, so
/// observe EOF while the remote request is in flight and drop that work before
/// the serialized broker accepts the next Tab press.
#[cfg(any(target_os = "linux", test))]
async fn wait_for_run_cli_peer_close(stream: &tokio::net::UnixStream) -> Result<()> {
    use std::io::ErrorKind;

    let mut byte = [0_u8; 1];
    loop {
        stream
            .readable()
            .await
            .context("wait for run CLI peer close")?;
        match stream.try_read(&mut byte) {
            Ok(0) => return Ok(()),
            Ok(_) => anyhow::bail!("run CLI client sent unexpected extra data"),
            Err(error) if error.kind() == ErrorKind::WouldBlock => continue,
            Err(error) => return Err(error).context("read run CLI peer close"),
        }
    }
}

/// `None` means the peer disconnected before completing a request frame.
/// A malformed or oversized frame remains an error and is never passed to
/// JSON decoding.
#[cfg(any(target_os = "linux", test))]
async fn read_run_cli_frame(stream: &mut tokio::net::UnixStream) -> Result<Option<Vec<u8>>> {
    use std::io::ErrorKind;
    use tokio::io::AsyncReadExt as _;

    let mut header = [0_u8; RUN_CLI_FRAME_HEADER_BYTES];
    match timeout(RUN_CLI_READ_TIMEOUT, stream.read_exact(&mut header)).await {
        Ok(Ok(_)) => {}
        Ok(Err(error)) if error.kind() == ErrorKind::UnexpectedEof => return Ok(None),
        Ok(Err(error)) => return Err(error).context("read guest run CLI frame header"),
        Err(_) => anyhow::bail!("guest run CLI frame header read timed out"),
    }
    let payload_len =
        run_cli_frame_payload_len(header).context("validate guest run CLI frame header")?;
    let mut frame = Vec::with_capacity(RUN_CLI_FRAME_HEADER_BYTES + payload_len);
    frame.extend_from_slice(&header);
    frame.resize(RUN_CLI_FRAME_HEADER_BYTES + payload_len, 0);
    match timeout(
        RUN_CLI_READ_TIMEOUT,
        stream.read_exact(&mut frame[RUN_CLI_FRAME_HEADER_BYTES..]),
    )
    .await
    {
        Ok(Ok(_)) => Ok(Some(frame)),
        Ok(Err(error)) if error.kind() == ErrorKind::UnexpectedEof => Ok(None),
        Ok(Err(error)) => Err(error).context("read guest run CLI frame payload"),
        Err(_) => anyhow::bail!("guest run CLI frame payload read timed out"),
    }
}

#[cfg(target_os = "linux")]
async fn forward_run_cli_request(
    inner: &Inner,
    vm_name: &str,
    run_id: &str,
    jail_generation: &str,
    request: &RunCliRequestV1,
) -> Result<RunCliResponseV1> {
    // The bridge already mints a short-lived bearer before a host can become
    // schedulable. Reuse it from root-owned memory so completion needs only
    // one control-plane round trip and can stay inside its 250 ms budget. A
    // disconnected or long-lived agent refreshes the cache on demand.
    let access_token = run_cli_access_token(inner).await?;
    anyhow::ensure!(
        run_cli_request_is_current(inner, vm_name, run_id, jail_generation).await,
        "guest run CLI request became stale before control-plane dispatch"
    );

    let run_id_segment = encode_url_path_segment(run_id);
    let vm_name_segment = encode_url_path_segment(vm_name);
    let url = run_cli_control_url(&inner.bridge.base_url, &run_id_segment, &vm_name_segment);
    match post_run_cli_request(&inner.http, &url, jail_generation, &access_token, request).await {
        Ok(response) => Ok(response),
        Err(error)
            if error
                .downcast_ref::<RunCliAuthenticationRejected>()
                .is_some() =>
        {
            inner
                .run_cli_access_token
                .lock()
                .await
                .invalidate_if(&access_token);
            let refreshed_access_token = run_cli_access_token(inner).await?;
            anyhow::ensure!(
                run_cli_request_is_current(inner, vm_name, run_id, jail_generation).await,
                "guest run CLI request became stale before authenticated retry"
            );
            post_run_cli_request(
                &inner.http,
                &url,
                jail_generation,
                &refreshed_access_token,
                request,
            )
            .await
        }
        Err(error) => Err(error),
    }
}

#[cfg(target_os = "linux")]
async fn run_cli_access_token(inner: &Inner) -> Result<String> {
    if let Some(access_token) = inner.run_cli_access_token.lock().await.get(Instant::now()) {
        return Ok(access_token);
    }

    let _refresh = inner.run_cli_access_token_refresh.lock().await;
    if let Some(access_token) = inner.run_cli_access_token.lock().await.get(Instant::now()) {
        return Ok(access_token);
    }

    let access_token = timeout(
        RUN_CLI_ACCESS_REFRESH_TIMEOUT,
        bootstrap_agent_access_token(&inner.bridge, &inner.http),
    )
    .await
    .context("agent access refresh for run CLI timed out")?
    .context("obtain fresh agent access for run CLI")?;
    anyhow::ensure!(
        !access_token.is_empty(),
        "agent bootstrap returned an empty token"
    );
    inner
        .run_cli_access_token
        .lock()
        .await
        .replace(access_token.clone(), Instant::now());
    Ok(access_token)
}

#[cfg(any(target_os = "linux", test))]
fn run_cli_control_url(base_url: &str, run_id_segment: &str, vm_name_segment: &str) -> String {
    format!(
        "{}/agent/runs/{run_id_segment}/vms/{vm_name_segment}/cli",
        base_url.trim_end_matches('/')
    )
}

#[cfg(any(target_os = "linux", test))]
async fn post_run_cli_request(
    http: &HttpClient,
    url: &str,
    jail_generation: &str,
    access_token: &str,
    request: &RunCliRequestV1,
) -> Result<RunCliResponseV1> {
    use futures_util::StreamExt as _;

    let display_url = crate::config::redact_url_userinfo(url);
    let response = http
        .post(url)
        .bearer_auth(access_token)
        .header("x-intar-jail-generation", jail_generation)
        .json(request)
        .send()
        .await
        .with_context(|| format!("submit run CLI request to {display_url}"))?;
    let status = response.status();
    if status == StatusCode::UNAUTHORIZED {
        return Err(RunCliAuthenticationRejected.into());
    }

    if let Some(content_length) = response.content_length() {
        anyhow::ensure!(
            content_length <= RUN_CLI_MAX_FRAME_BYTES as u64,
            "control-plane run CLI response exceeds the frame limit"
        );
    }
    let mut body = Vec::new();
    let mut chunks = response.bytes_stream();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk.context("read control-plane run CLI response")?;
        let next_len = body
            .len()
            .checked_add(chunk.len())
            .context("control-plane run CLI response length overflow")?;
        anyhow::ensure!(
            next_len <= RUN_CLI_MAX_FRAME_BYTES,
            "control-plane run CLI response exceeds the frame limit"
        );
        body.extend_from_slice(&chunk);
    }
    let parsed = serde_json::from_slice::<RunCliResponseV1>(&body)
        .with_context(|| format!("decode control-plane run CLI response for HTTP {status}"))?;
    // A locked, unavailable, or otherwise rejected learner action is a normal
    // CLI result. The control plane deliberately gives those outcomes an HTTP
    // error status, but Kino still needs the small structured result to choose
    // the right text and exit code. Never accept a success-shaped body behind
    // a non-success HTTP status.
    anyhow::ensure!(
        status.is_success() || matches!(&parsed.result, RunCliResultV1::Error { .. }),
        "control-plane run CLI request failed with HTTP {status}"
    );
    Ok(parsed)
}

#[cfg(target_os = "linux")]
async fn run_cli_broker_is_current(
    inner: &Inner,
    vm_name: &str,
    run_id: &str,
    jail_generation: &str,
) -> bool {
    let states = inner.states.read().await;
    let Some(vm) = states.get(vm_name) else {
        return false;
    };
    matches!(
        vm.state,
        VmLifecycleState::BootingVm | VmLifecycleState::Running
    ) && vm.details.as_ref().is_some_and(|details| {
        details.run_id.as_deref() == Some(run_id)
            && details.jail_generation.as_deref() == Some(jail_generation)
    })
}

#[cfg(target_os = "linux")]
async fn run_cli_request_is_current(
    inner: &Inner,
    vm_name: &str,
    run_id: &str,
    jail_generation: &str,
) -> bool {
    let states = inner.states.read().await;
    states
        .get(vm_name)
        .is_some_and(|vm| run_cli_identity_matches_status(vm, run_id, jail_generation))
}

#[cfg(target_os = "linux")]
fn run_cli_identity_matches_status(
    vm: &VmStatusResponse,
    run_id: &str,
    jail_generation: &str,
) -> bool {
    run_cli_identity_matches(
        &vm.state,
        vm.details
            .as_ref()
            .and_then(|details| details.run_id.as_deref()),
        vm.details
            .as_ref()
            .and_then(|details| details.jail_generation.as_deref()),
        run_id,
        jail_generation,
    )
}

#[cfg(any(target_os = "linux", test))]
fn run_cli_identity_matches(
    state: &VmLifecycleState,
    current_run_id: Option<&str>,
    current_jail_generation: Option<&str>,
    expected_run_id: &str,
    expected_jail_generation: &str,
) -> bool {
    *state == VmLifecycleState::Running
        && current_run_id == Some(expected_run_id)
        && current_jail_generation == Some(expected_jail_generation)
}

#[cfg(test)]
mod tests {
    use super::*;
    use intar_contracts::run_cli::{RunCliActionV1, RunCliErrorCodeV1, RunCliErrorV1};

    fn request() -> RunCliRequestV1 {
        RunCliRequestV1 {
            protocol_version: RUN_CLI_PROTOCOL_VERSION,
            request_id: "request-1".to_string(),
            action: RunCliActionV1::Status,
        }
    }

    #[test]
    fn run_cli_access_token_cache_is_short_lived_and_redacted() {
        let now = Instant::now();
        let secret = "agent-run-cli-secret";
        let mut cache = RunCliAccessTokenCache::default();

        assert!(cache.get(now).is_none());
        cache.replace(secret.to_owned(), now);
        assert_eq!(cache.get(now).as_deref(), Some(secret));
        cache.invalidate_if("different-token");
        assert_eq!(cache.get(now).as_deref(), Some(secret));
        cache.invalidate_if(secret);
        assert!(cache.get(now).is_none());
        cache.replace(secret.to_owned(), now);
        cache.clear();
        assert!(cache.get(now).is_none());
        cache.replace(secret.to_owned(), now);
        assert!(cache.get(now + RUN_CLI_ACCESS_TOKEN_CACHE_TTL).is_none());

        let debug = format!("{cache:?}");
        assert!(debug.contains("populated: true"));
        assert!(!debug.contains(secret));
    }

    async fn read_complete_http_request(stream: &mut tokio::net::TcpStream) -> Vec<u8> {
        use tokio::io::AsyncReadExt as _;

        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 1024];
        let header_end = loop {
            let read = stream.read(&mut buffer).await.expect("read HTTP request");
            assert!(read > 0, "HTTP request must not close before its headers");
            bytes.extend_from_slice(&buffer[..read]);
            if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                break index + 4;
            }
        };
        let headers = std::str::from_utf8(&bytes[..header_end]).expect("HTTP headers are UTF-8");
        let content_length = headers
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .map(|(_, value)| {
                value
                    .trim()
                    .parse::<usize>()
                    .expect("content length is valid")
            })
            .expect("request includes content length");
        let expected = header_end + content_length;
        while bytes.len() < expected {
            let read = stream
                .read(&mut buffer)
                .await
                .expect("read HTTP request body");
            assert!(read > 0, "HTTP request body must be complete");
            bytes.extend_from_slice(&buffer[..read]);
        }
        assert_eq!(bytes.len(), expected, "request must contain only one body");
        bytes
    }

    #[test]
    fn stale_generation_is_rejected_before_dispatch() {
        assert!(run_cli_identity_matches(
            &VmLifecycleState::Running,
            Some("run-1"),
            Some("generation-1"),
            "run-1",
            "generation-1",
        ));
        assert!(!run_cli_identity_matches(
            &VmLifecycleState::Running,
            Some("run-1"),
            Some("generation-1"),
            "run-1",
            "generation-2",
        ));
        assert!(!run_cli_identity_matches(
            &VmLifecycleState::Running,
            Some("run-1"),
            Some("generation-1"),
            "run-2",
            "generation-1",
        ));
    }

    #[test]
    fn oversized_frame_header_is_rejected_without_a_payload_allocation() {
        let oversized = u32::try_from(RUN_CLI_MAX_FRAME_BYTES + 1)
            .expect("test limit fits in u32")
            .to_be_bytes();
        assert!(run_cli_frame_payload_len(oversized).is_err());
    }

    #[test]
    fn control_url_has_exactly_one_path_separator_after_a_trailing_base_slash() {
        assert_eq!(
            run_cli_control_url("https://intar.example/", "run-1", "vm-1"),
            "https://intar.example/agent/runs/run-1/vms/vm-1/cli"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn disconnected_guest_does_not_fail_the_listener() {
        let (client, mut server) = tokio::net::UnixStream::pair().expect("create Unix stream pair");
        drop(client);
        assert!(
            read_run_cli_frame(&mut server)
                .await
                .expect("a disconnected peer is not a malformed frame")
                .is_none()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn disconnected_status_client_cancels_slow_forward_work() {
        let (client, server) = tokio::net::UnixStream::pair().expect("create Unix stream pair");
        let slow_forward = tokio::time::sleep(Duration::from_secs(30));
        tokio::pin!(slow_forward);
        drop(client);

        tokio::time::timeout(Duration::from_secs(1), async {
            tokio::select! {
                () = &mut slow_forward => panic!("slow forward must be cancelled first"),
                result = wait_for_run_cli_peer_close(&server) => {
                    result.expect("peer EOF is a clean cancellation");
                }
            }
        })
        .await
        .expect("peer cancellation must not wait for slow forward work");
    }

    #[tokio::test]
    async fn rejected_control_plane_response_never_echoes_the_agent_token() {
        use tokio::io::AsyncWriteExt as _;

        crate::tls_provider::ensure_ring_provider().expect("install test TLS provider");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind run CLI test server");
        let address = listener.local_addr().expect("read test server address");
        let secret = "fresh-agent-token-must-not-appear-in-errors";
        let response_secret = secret.to_string();
        let header_secret = secret.to_ascii_lowercase();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept run CLI request");
            let request = read_complete_http_request(&mut stream).await;
            let raw = String::from_utf8_lossy(&request).to_ascii_lowercase();
            assert!(raw.contains("x-intar-jail-generation: generation-1"));
            assert!(raw.contains(&format!("authorization: bearer {header_secret}")));
            assert!(!raw.contains("\"run_id\""));
            assert!(!raw.contains("\"vm_name\""));
            assert!(!raw.contains("\"jail_generation\""));
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 503 Service Unavailable\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                        response_secret.len(),
                        response_secret,
                    )
                    .as_bytes(),
                )
                .await
                .expect("write rejected run CLI response");
        });

        let error = post_run_cli_request(
            &HttpClient::new(),
            &format!("http://{address}/agent/runs/run-1/vms/vm-1/cli"),
            "generation-1",
            secret,
            &request(),
        )
        .await
        .expect_err("rejected control-plane response must fail the request");
        assert!(
            !error.to_string().contains(secret),
            "agent credentials must not appear in run CLI errors"
        );
        server.await.expect("run CLI test server task");
    }

    #[tokio::test]
    async fn unauthorized_control_plane_response_is_classified_for_token_refresh() {
        use tokio::io::AsyncWriteExt as _;

        crate::tls_provider::ensure_ring_provider().expect("install test TLS provider");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind run CLI test server");
        let address = listener.local_addr().expect("read test server address");
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept run CLI request");
            let _ = read_complete_http_request(&mut stream).await;
            stream
                .write_all(
                    b"HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                )
                .await
                .expect("write unauthorized response");
        });

        let error = post_run_cli_request(
            &HttpClient::new(),
            &format!("http://{address}/agent/runs/run-1/vms/vm-1/cli"),
            "generation-1",
            "stale-agent-token",
            &request(),
        )
        .await
        .expect_err("unauthorized response must request a token refresh");
        assert!(
            error
                .downcast_ref::<RunCliAuthenticationRejected>()
                .is_some()
        );
        server.await.expect("run CLI test server task");
    }

    #[tokio::test]
    async fn rejects_an_oversized_control_plane_response_before_decoding_it() {
        use tokio::io::AsyncWriteExt as _;

        crate::tls_provider::ensure_ring_provider().expect("install test TLS provider");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind run CLI test server");
        let address = listener.local_addr().expect("read test server address");
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept run CLI request");
            let _ = read_complete_http_request(&mut stream).await;
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                        RUN_CLI_MAX_FRAME_BYTES + 1,
                    )
                    .as_bytes(),
                )
                .await
                .expect("write oversized response header");
        });

        let error = post_run_cli_request(
            &HttpClient::new(),
            &format!("http://{address}/agent/runs/run-1/vms/vm-1/cli"),
            "generation-1",
            "test-agent-token",
            &request(),
        )
        .await
        .expect_err("oversized control-plane reply must be rejected");
        assert!(error.to_string().contains("frame limit"));
        server.await.expect("run CLI test server task");
    }

    #[tokio::test]
    async fn forwards_a_structured_locked_result_even_when_http_rejects_it() {
        use tokio::io::AsyncWriteExt as _;

        crate::tls_provider::ensure_ring_provider().expect("install test TLS provider");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind run CLI test server");
        let address = listener.local_addr().expect("read test server address");
        let request = request();
        let response = RunCliResponseV1 {
            protocol_version: RUN_CLI_PROTOCOL_VERSION,
            request_id: request.request_id.clone(),
            result: RunCliResultV1::Error {
                error: RunCliErrorV1 {
                    code: RunCliErrorCodeV1::Locked,
                    message: "The next hint is not ready yet.".to_string(),
                    retryable: false,
                },
            },
        };
        let response_body = serde_json::to_string(&response).expect("serialize response");
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept run CLI request");
            read_complete_http_request(&mut stream).await;
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 409 Conflict\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                        response_body.len(),
                        response_body,
                    )
                    .as_bytes(),
                )
                .await
                .expect("write structured locked response");
        });

        let actual = post_run_cli_request(
            &HttpClient::new(),
            &format!("http://{address}/agent/runs/run-1/vms/vm-1/cli"),
            "generation-1",
            "test-agent-token",
            &request,
        )
        .await
        .expect("a structured control-plane rejection must reach Kino");
        assert_eq!(actual.request_id, request.request_id);
        assert!(matches!(
            actual.result,
            RunCliResultV1::Error {
                error: RunCliErrorV1 {
                    code: RunCliErrorCodeV1::Locked,
                    retryable: false,
                    ..
                }
            }
        ));
        server.await.expect("run CLI test server task");
    }
}
