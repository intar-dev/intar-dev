use super::*;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub(super) struct OutputProbe {
    sent: [AtomicUsize; 2],
    stopped: [AtomicUsize; 2],
    burst_sent: AtomicUsize,
    cancel: CancellationToken,
}

pub(super) fn start_output(
    command: &[u8],
    channel: ChannelId,
    session: &mut Session,
    probe: Arc<OutputProbe>,
) -> Result<bool> {
    if command == b"burst-both" {
        let handle = session.handle();
        tokio::spawn(async move {
            for n in 0..128_u8 {
                let data = vec![n; 16 * 1024];
                let result = if n % 2 == 0 {
                    handle.data(channel, data).await
                } else {
                    handle.extended_data(channel, 1, data).await
                };
                if result.is_err() {
                    return;
                }
                probe.burst_sent.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(3)).await;
            }
            let _ = handle.exit_status_request(channel, 23).await;
            let _ = handle.close(channel).await;
        });
        return Ok(true);
    }
    let index = match command {
        b"stream-stdout" => 0,
        b"stream-stderr" => 1,
        b"output-both-once" => {
            session.data(channel, b"stdout-ok\n".to_vec())?;
            session.extended_data(channel, 1, b"stderr-ok\n".to_vec())?;
            session.exit_status_request(channel, 0)?;
            session.close(channel)?;
            return Ok(true);
        }
        _ => return Ok(false),
    };
    let handle = session.handle();
    tokio::spawn(async move {
        let produce = async {
            // Pace output so the old bridge can drain its bounded event queue
            // into russh's unbounded pending queue. No giant allocation or RSS
            // threshold is needed to detect the missing window backpressure.
            for _ in 0..1000 {
                let data = vec![b'x'; 16 * 1024];
                let result = if index == 0 {
                    handle.data(channel, data).await
                } else {
                    handle.extended_data(channel, 1, data).await
                };
                if result.is_err() {
                    break;
                }
                probe.sent[index].fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        };
        tokio::select! {
            _ = probe.cancel.cancelled() => {},
            _ = produce => {},
        }
        probe.stopped[index].fetch_add(1, Ordering::SeqCst);
    });
    Ok(true)
}

#[tokio::test]
async fn zero_window_stdout_and_stderr_stop_without_blocking_another_client() -> Result<()> {
    let h = Harness::start().await?;
    let _stop_producers = h.output_probe.cancel.clone().drop_guard();
    h.issue_native_terminal_session(true).await?;
    let mut blocked = Vec::new();
    for (index, command) in ["stream-stdout", "stream-stderr"].into_iter().enumerate() {
        let mut config = client_config(&h.public_host_public);
        Arc::get_mut(&mut config)
            .expect("unshared client config")
            .window_size = 0;
        let mut client = client::connect(
            config,
            h.public_ssh_addr,
            TestClient {
                expected_server_key: h.public_host_public.clone(),
            },
        )
        .await?;
        assert!(
            h.authenticate_public_key(&mut client, &h.profile_client_private_key_openssh)
                .await?
        );
        let channel = client.channel_open_session().await?;
        // Cover both the exec and PTY-exec branches of the native gateway.
        if index == 1 {
            channel
                .request_pty(true, "xterm", 80, 24, 0, 0, &[])
                .await?;
        }
        channel.exec(true, command).await?;
        blocked.push((client, channel));
    }
    tokio::time::timeout(Duration::from_secs(2), async {
        while h
            .output_probe
            .sent
            .iter()
            .any(|n| n.load(Ordering::SeqCst) < 4)
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .context("both blocked clients must receive guest output")?;

    // Use the same route without reissuing it: rotation must not close the
    // blocked clients and accidentally make this regression test pass.
    let output = tokio::time::timeout(Duration::from_secs(1), h.ssh_exec("output-both-once"))
        .await
        .context("blocked clients delayed another client")??;
    assert_eq!(output, "stdout-ok\nstderr-ok\n");

    tokio::time::timeout(Duration::from_secs(4), async {
        for (_, channel) in &mut blocked {
            while let Some(message) = channel.wait().await {
                match message {
                    ChannelMsg::Data { .. } | ChannelMsg::ExtendedData { .. } => {
                        anyhow::bail!("gateway sent data past a zero receive window");
                    }
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }
        }
        while h
            .output_probe
            .stopped
            .iter()
            .any(|n| n.load(Ordering::SeqCst) == 0)
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await
    .context("zero-window streams or their guest producers remained active")??;
    for count in &h.output_probe.sent {
        assert!(
            count.load(Ordering::SeqCst) < 256,
            "guest output was not stopped within a bounded budget"
        );
    }
    assert!(
        h.ssh_exec("after-blocked-clients")
            .await?
            .contains("exec:after-blocked-clients")
    );
    h.shutdown().await
}

#[tokio::test]
async fn temporary_backpressure_preserves_output_and_exit_while_another_relay_client_progresses()
-> Result<()> {
    use stargate_core::{
        SshTargetTransport,
        relay::{HostRelayIdentity, RelayService, RelayTarget},
    };
    let mut h = Harness::start_with_workspace_app_domain(Some("example.test")).await?;
    let target = RelayTarget {
        host: HostRelayIdentity {
            host_id: "host-01".into(),
            session_id: "session-01".into(),
            credential_generation: 1,
        },
        owner_id: "user-01".into(),
        execution_id: "exec-01".into(),
        execution_generation: 7,
        vm_id: "vm-01".into(),
        service: RelayService::Ssh,
    };
    h.relay_transport = Some(SshTargetTransport::Relay {
        target: target.clone(),
    });
    let now = (OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64;
    let grant = serde_json::json!({"identity":target.host,"targets":[target],
        "session_started_at_unix_ms":now,"issued_at_unix_ms":now,"expires_at_unix_ms":now+120_000});
    let credentials = relay_wss::admin(&h, "grant", &grant)
        .await?
        .error_for_status()?
        .json()
        .await?;
    let (_host, _guard) = relay_wss::connect_test_relay(&mut h, &target, &credentials).await?;
    h.issue_native_terminal_session(true).await?;
    // Establish both public and guest SSH transports before timing forwarding.
    // Key exchange and authentication can exceed the short hold on CI runners.
    let (_other_client, mut other_channel) = h
        .open_public_shell_with_private_key(&h.profile_client_private_key_openssh)
        .await?;
    wait_for_native_channel_data(&mut other_channel, "shell ready").await?;
    let mut config = client_config(&h.public_host_public);
    let settings = Arc::get_mut(&mut config).expect("unshared client config");
    settings.window_size = 16 * 1024;
    settings.maximum_packet_size = 16 * 1024;
    settings.channel_buffer_size = 1;
    let mut client = client::connect(
        config,
        h.public_ssh_addr,
        TestClient {
            expected_server_key: h.public_host_public.clone(),
        },
    )
    .await?;
    assert!(
        h.authenticate_public_key(&mut client, &h.profile_client_private_key_openssh)
            .await?
    );
    let mut channel = client.channel_open_session().await?;
    channel.exec(true, "burst-both").await?;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    stdout.extend_from_slice(&data);
                    return Ok::<_, anyhow::Error>(());
                }
                Some(ChannelMsg::Close) | None => {
                    anyhow::bail!("burst closed before output started")
                }
                _ => {}
            }
        }
    })
    .await??;

    // Stop consuming until the burst fills the bridge queue, then keep it
    // blocked while the other client runs. Both clients share a host relay and
    // VM. The unread period stays below the two-second production timeout.
    tokio::time::timeout(Duration::from_millis(500), async {
        while h.output_probe.burst_sent.load(Ordering::SeqCst) <= 32 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .context("burst did not fill the bridge queue before the second command")?;
    let hold = tokio::time::sleep(Duration::from_millis(500));
    let other = tokio::time::timeout(Duration::from_millis(400), async {
        other_channel
            .data_bytes(b"other-client-progress\n".to_vec())
            .await?;
        wait_for_native_channel_data(&mut other_channel, "other-client-progress").await
    });
    let (_, output) = tokio::join!(hold, other);
    output.context("stalled stream blocked another relay client")??;

    let exit = tokio::time::timeout(Duration::from_secs(4), async {
        let mut exit = None;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                ChannelMsg::ExtendedData { ext: 1, data } => stderr.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        exit
    })
    .await
    .context("recovered client did not finish")?;
    let expected = |parity| {
        (0..128_u8)
            .filter(|n| n % 2 == parity)
            .flat_map(|n| std::iter::repeat_n(n, 16 * 1024))
            .collect::<Vec<_>>()
    };
    assert_eq!(stdout.len(), 64 * 16 * 1024, "stdout was truncated");
    assert_eq!(stderr.len(), 64 * 16 * 1024, "stderr was truncated");
    assert!(stdout == expected(0), "stdout bytes changed");
    assert!(stderr == expected(1), "stderr bytes changed");
    assert_eq!(exit, Some(23));
    assert!(h.host_relays.is_connected(&target.host));
    h.shutdown().await
}
