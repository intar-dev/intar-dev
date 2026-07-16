use super::*;

#[test]
fn launch_requires_a_prepared_v2_image_and_never_downgrades() {
    let (prepared_request, prepared) = launch_operation_fixture();
    let operation =
        build_jailer_launch_operation(prepared_request, Some(&prepared)).expect("v2 request");
    assert!(matches!(operation, JailerRequest::LaunchVmV2(_)));

    let (mut regular_request, _) = launch_operation_fixture();
    let regular = |name: &str, access, sha256: Option<Sha256Digest>| ArtifactSource {
        source_root: 0,
        relative_path: PathBuf::from(name),
        sha256,
        access,
    };
    let boot_digest = Sha256Digest::parse("1".repeat(64)).expect("boot digest");
    regular_request.artifacts.root_disk = regular("root.raw", ArtifactAccess::ReadWrite, None);
    regular_request.artifacts.kernel = regular(
        "kernel",
        ArtifactAccess::ReadOnly,
        Some(boot_digest.clone()),
    );
    regular_request.artifacts.initrd = Some(regular(
        "initrd",
        ArtifactAccess::ReadOnly,
        Some(boot_digest),
    ));
    let error = build_jailer_launch_operation(regular_request, None)
        .expect_err("missing prepared template must fail instead of selecting v1");
    assert!(error.to_string().contains("no v1 fallback"));
}

#[tokio::test]
async fn v2_launch_transport_retry_replays_the_exact_request_and_preserves_conflict() {
    let (request, prepared) = launch_operation_fixture();
    let operation = build_jailer_launch_operation(request, Some(&prepared)).expect("v2 operation");
    let expected = operation.clone();
    let sent = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sent_by_request = Arc::clone(&sent);

    let response = request_v2_launch_with_single_retry(operation, move |operation| {
        let attempt = {
            let mut sent = sent_by_request.lock().expect("sent requests");
            sent.push(operation);
            sent.len()
        };
        async move {
            if attempt == 1 {
                Err(anyhow::anyhow!("injected lost launch response"))
            } else {
                Ok(JailerResponse::Error(
                    intar_jailer_protocol::ProtocolError::new(
                        "conflict",
                        "logical VM already exists with a different launch request",
                    ),
                ))
            }
        }
    })
    .await
    .expect("retry response");

    assert!(matches!(
        response,
        JailerResponse::Error(ref error) if error.code == "conflict"
    ));
    let sent = sent.lock().expect("sent requests");
    assert_eq!(sent.as_slice(), &[expected.clone(), expected]);
    assert!(
        sent.iter()
            .all(|request| matches!(request, JailerRequest::LaunchVmV2(_)))
    );
}

#[tokio::test]
async fn v2_launch_transport_retry_fails_closed_after_two_transport_errors() {
    let (request, prepared) = launch_operation_fixture();
    let operation = build_jailer_launch_operation(request, Some(&prepared)).expect("v2 operation");
    let sent = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sent_by_request = Arc::clone(&sent);

    let error = request_v2_launch_with_single_retry(operation, move |operation| {
        let attempt = {
            let mut sent = sent_by_request.lock().expect("sent requests");
            sent.push(operation);
            sent.len()
        };
        async move { Err(anyhow::anyhow!("injected transport failure {attempt}")) }
    })
    .await
    .expect_err("two transport failures must fail closed");

    let message = format!("{error:#}");
    assert!(message.contains("first transport attempt failed"));
    assert!(message.contains("injected transport failure 1"));
    assert!(message.contains("injected transport failure 2"));
    let sent = sent.lock().expect("sent requests");
    assert_eq!(sent.len(), 2);
    assert!(
        sent.iter()
            .all(|request| matches!(request, JailerRequest::LaunchVmV2(_)))
    );
    assert_eq!(sent[0], sent[1]);
}

#[tokio::test]
async fn ssh_readiness_accepts_only_kino_reported_host_key_material() {
    let reported = vec![
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBklzf1Qy77LwsjmDlGvCAhBpCkhpti25927fAnOMEIR root@broken-nginx"
            .to_string(),
    ];
    let expected = parse_guest_ssh_host_keys(&reported).expect("reported key parses");
    let wire_key = PublicKey::from_openssh(
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBklzf1Qy77LwsjmDlGvCAhBpCkhpti25927fAnOMEIR",
    )
    .expect("matching wire key parses");
    let other_key = PublicKey::from_openssh(
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA8ax6Yk1ZMSRpAkk8cIriNXtVufy6mxst2stQk66n+d",
    )
    .expect("other wire key parses");

    let mismatch_observed = Arc::new(AtomicBool::new(false));
    let mut verifier = StrictGuestHostKeys {
        expected: Arc::clone(&expected),
        mismatch_observed: Arc::clone(&mismatch_observed),
    };
    assert!(
        verifier
            .check_server_key(&wire_key)
            .await
            .expect("host-key check succeeds")
    );
    assert!(!mismatch_observed.load(Ordering::Acquire));

    let mismatch_observed = Arc::new(AtomicBool::new(false));
    let mut verifier = StrictGuestHostKeys {
        expected,
        mismatch_observed: Arc::clone(&mismatch_observed),
    };
    assert!(
        !verifier
            .check_server_key(&other_key)
            .await
            .expect("host-key check succeeds")
    );
    assert!(mismatch_observed.load(Ordering::Acquire));
}

#[test]
fn ssh_readiness_rejects_missing_or_malformed_kino_host_keys() {
    let missing = parse_guest_ssh_host_keys(&[]).expect_err("missing keys must fail closed");
    assert!(
        missing
            .to_string()
            .contains("did not include an SSH host key")
    );

    let malformed = parse_guest_ssh_host_keys(&["ssh-ed25519 not-base64".to_string()])
        .expect_err("malformed key must fail closed");
    assert!(
        malformed
            .to_string()
            .contains("invalid SSH host key at index 0")
    );
}
