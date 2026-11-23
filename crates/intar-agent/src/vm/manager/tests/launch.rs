use super::*;

#[test]
fn boot_timing_includes_queue_and_publication_and_sums_after_rounding() {
    let start = Instant::now();
    let ends = [
        12_100, 12_900, 18_600, 25_900, 26_100, 28_700, 120_400, 125_800, 128_900, 145_300,
    ]
    .map(|micros| start + Duration::from_micros(micros));
    let phases = boot_phase_millis(start, ends);
    assert_eq!(phases[0], 12, "queue work precedes run_create");
    assert_eq!(
        phases[9], 17,
        "publication and worker registration finish last"
    );
    assert_eq!(phases.iter().sum::<u128>(), 145);
    assert_eq!(
        phases.iter().sum::<u128>(),
        ends[9].duration_since(start).as_millis()
    );
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
            .check_server_key(&russh::keys::PublicKeyOrCertificate::PublicKey {
                key: wire_key.clone(),
                hash_alg: None,
            })
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
            .check_server_key(&russh::keys::PublicKeyOrCertificate::PublicKey {
                key: other_key.clone(),
                hash_alg: None,
            })
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

#[test]
fn a_launch_on_a_template_jailerd_no_longer_holds_withdraws_the_images_readiness()
-> anyhow::Result<()> {
    let temp = tempfile::tempdir()?;
    let image =
        OciDigest::try_from(format!("sha256:{}", "a".repeat(64))).map_err(anyhow::Error::msg)?;
    let descriptor = temp
        .path()
        .join("launch")
        .join(format!("{}.ready.json", image.hex()));
    std::fs::create_dir_all(temp.path().join("launch"))?;
    std::fs::write(&descriptor, b"{}")?;

    // Any other launch failure leaves readiness alone.
    let other = anyhow::anyhow!("jailerd host_operation_failed: prepare jail filesystem");
    assert!(!withdraw_if_template_missing(temp.path(), &image, &other));
    assert!(descriptor.exists());

    let missing = anyhow::Error::from(ImageTemplateMissing {
        message: "the prepared image template is missing".to_owned(),
    });
    assert!(withdraw_if_template_missing(temp.path(), &image, &missing));
    assert!(
        !descriptor.exists(),
        "the next cache pass prepares it again"
    );
    // Withdrawn already: still the same answer.
    assert!(withdraw_if_template_missing(temp.path(), &image, &missing));
    Ok(())
}

#[test]
fn talos_cmdline_gives_the_run_address_and_a_resolver_only_with_egress() -> Result<()> {
    let network = CreateVmNetwork {
        guest_ip_cidr: "10.200.0.3/28".to_owned(),
        gateway: "10.200.0.1".to_owned(),
        dns: vec!["1.1.1.1".to_owned(), "8.8.8.8".to_owned()],
    };
    assert_eq!(
        talos_cmdline("talos.platform=metal", &network, true)?,
        "talos.platform=metal ip=10.200.0.3::10.200.0.1:255.255.255.240::eth0:off:1.1.1.1 nfsaddrs=off"
    );
    assert!(talos_cmdline("x", &network, false)?.ends_with("eth0:off: nfsaddrs=off"));
    assert!(talos_cmdline(&"x".repeat(2000), &network, true).is_err());
    Ok(())
}

#[test]
fn a_talos_node_reports_ready_and_verified() {
    let update = talos_ready_update("vm-1", "run-1", "gen-1");
    assert_eq!(
        ready_gate(&update, "vm-1", "run-1", "gen-1"),
        ReadyGate::Ready
    );
    let verify = update.lab.verify.expect("a verify block");
    assert!(verify.done && verify.passed && verify.pre_done);
    assert_eq!(update.lab.state, LabState::Ready);
}
