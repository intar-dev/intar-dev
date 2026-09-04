use super::*;

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
