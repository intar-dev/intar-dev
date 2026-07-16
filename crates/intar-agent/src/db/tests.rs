use super::*;
use tempfile::tempdir;

fn test_db_path() -> PathBuf {
    let temp = tempdir().expect("temp dir");
    let path = temp.path().join("intar-agent-test.sqlite3");
    std::mem::forget(temp);
    path
}

fn test_vm_row() -> VmRow {
    VmRow {
        name: "vm-1".to_string(),
        state: "running".to_string(),
        image_key: Some("ubuntu".to_string()),
        image_sha256: Some("1".repeat(64)),
        created_at_s: 100,
        updated_at_s: 200,
        running_at_s: Some(150),
        error: None,
        root_disk_path: Some("/tmp/root.raw".to_string()),
        seed_disk_path: Some("/tmp/seed.img".to_string()),
        mac: Some("02:00:00:00:00:01".to_string()),
        lease_duration_seconds: Some(3600),
        guest_ip: Some("10.200.0.2".to_string()),
        guest_ip_cidr: Some("10.200.0.2/28".to_string()),
        gateway: Some("10.200.0.1".to_string()),
        bridge_name: Some("intar-runa".to_string()),
        ssh_public_port: Some(22001),
        tap_name: Some("tap0".to_string()),
        ch_socket_path: Some("/tmp/ch.sock".to_string()),
        ch_pid: Some(1234),
        ch_start_time_ticks: Some(987_654),
        host_boot_id: Some("boot-id".to_string()),
        jail_generation: Some("generation-1".to_string()),
        jail_unit_name: Some("intar-vm-generation-1.service".to_string()),
        jail_cgroup_path: Some(
            "/intar.slice/intar-vms.slice/intar-vm-generation-1.service".to_string(),
        ),
        jail_root_path: Some("/var/lib/intar/jails/generation-1/root".to_string()),
        jail_root_inode: Some(42),
        jail_uid: Some(200_000),
        jail_gid: Some(200_000),
        jail_netns_name: Some("intar-run-1".to_string()),
        kino_vsock_cid: Some(42),
        kino_vsock_port: Some(12345),
        kino_vsock_path: Some("/tmp/kino.vsock".to_string()),
        ssh_host_keys_openssh_json: Some(r#"["ssh-ed25519 AAAAHOST host"]"#.to_string()),
        run_id: Some("run-1".to_string()),
        recording_disk_path: Some("/tmp/recording.raw".to_string()),
        spool_dir: Some("/tmp/spool".to_string()),
        cpu_millis: Some(125),
        vcpu_count: Some(1),
        ch_executable_sha256: Some("b".repeat(64)),
    }
}

fn test_probe_row() -> VmProbeStateRow {
    VmProbeStateRow {
        vm_name: "vm-1".to_string(),
        run_id: "run-1".to_string(),
        fingerprint: "ready-fingerprint".to_string(),
        collection_state: "ok".to_string(),
        collection_error: None,
        summary_json: r#"{"total":1,"pass":1,"fail":0,"unknown":0}"#.to_string(),
        snapshot_json: r#"{"generation":"generation-1"}"#.to_string(),
        generated_at_ms: 200_000,
        updated_at_ms: 200_001,
    }
}

async fn open_test_db_thread(path: PathBuf) -> Db {
    let (tx, rx) = mpsc::channel::<Op>(16);
    let (init_tx, init_rx) = oneshot::channel::<Result<Vec<VmRow>>>();
    std::thread::spawn(move || db_thread_main(path, rx, init_tx));
    init_rx
        .await
        .expect("test db init response")
        .expect("test db init");
    Db { tx }
}

#[test]
fn upsert_vm_persists_row_with_ssh_public_port() {
    let path = test_db_path();
    let conn = open_prepared_connection(&path).expect("open db");
    let image_sha = "1".repeat(64);
    let row = test_vm_row();

    upsert_vm(&conn, &row).expect("upsert vm");

    let rows = load_all_vms(&conn).expect("load vms");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].name, "vm-1");
    assert_eq!(rows[0].image_key.as_deref(), Some("ubuntu"));
    assert_eq!(rows[0].image_sha256.as_deref(), Some(image_sha.as_str()));
    assert_eq!(rows[0].ssh_public_port, Some(22001));
    assert_eq!(rows[0].guest_ip_cidr.as_deref(), Some("10.200.0.2/28"));
    assert_eq!(rows[0].gateway.as_deref(), Some("10.200.0.1"));
    assert_eq!(rows[0].bridge_name.as_deref(), Some("intar-runa"));
    assert_eq!(
        rows[0].ssh_host_keys_openssh_json.as_deref(),
        Some(r#"["ssh-ed25519 AAAAHOST host"]"#)
    );
    assert_eq!(rows[0].spool_dir.as_deref(), Some("/tmp/spool"));
    assert_eq!(rows[0].ch_executable_sha256, Some("b".repeat(64)));
    assert_eq!(
        load_local_vm_image_shas(&conn).expect("load vm image shas"),
        vec![image_sha]
    );
}

#[test]
fn ready_vm_and_probe_commit_is_atomic() {
    let path = test_db_path();
    let mut conn = open_prepared_connection(&path).expect("open db");
    conn.execute_batch(
        r#"
CREATE TRIGGER fail_ready_probe
BEFORE INSERT ON vm_probe_state
BEGIN
  SELECT RAISE(ABORT, 'injected ready probe failure');
END;
"#,
    )
    .expect("install failure trigger");

    let error = upsert_ready_vm_and_probe_state(&mut conn, &test_vm_row(), &test_probe_row())
        .expect_err("probe failure must abort ready transaction");
    assert!(error.to_string().contains("persist ready probe row"));
    assert!(
        load_all_vms(&conn)
            .expect("load rolled back VMs")
            .is_empty()
    );
    assert!(
        load_all_vm_probe_states(&conn)
            .expect("load rolled back probes")
            .is_empty()
    );

    conn.execute_batch("DROP TRIGGER fail_ready_probe;")
        .expect("remove failure trigger");
    upsert_ready_vm_and_probe_state(&mut conn, &test_vm_row(), &test_probe_row())
        .expect("commit ready transaction");
    assert_eq!(load_all_vms(&conn).expect("load ready VM").len(), 1);
    assert_eq!(
        load_all_vm_probe_states(&conn)
            .expect("load ready probe")
            .len(),
        1
    );
}

#[tokio::test]
async fn async_vm_writes_return_only_after_sqlite_applies_them() {
    let path = test_db_path();
    let db = open_test_db_thread(path.clone()).await;
    let row = test_vm_row();

    db.upsert_vm(row.clone()).await.expect("async upsert");
    assert_eq!(
        load_all_vms(&open_prepared_connection(&path).expect("read db"))
            .expect("load inserted row")
            .len(),
        1
    );

    db.delete_vm(row.name).await.expect("async delete");
    assert!(
        load_all_vms(&open_prepared_connection(&path).expect("read db"))
            .expect("load after delete")
            .is_empty()
    );
}

#[tokio::test]
async fn async_vm_writes_propagate_sqlite_execution_errors() {
    let path = test_db_path();
    let conn = open_prepared_connection(&path).expect("open db");
    let existing = test_vm_row();
    upsert_vm(&conn, &existing).expect("seed VM row");
    conn.execute_batch(
        r#"
CREATE TRIGGER fail_vm_insert
BEFORE INSERT ON vms
BEGIN
  SELECT RAISE(ABORT, 'forced vm insert failure');
END;
CREATE TRIGGER fail_vm_delete
BEFORE DELETE ON vms
BEGIN
  SELECT RAISE(ABORT, 'forced vm delete failure');
END;
"#,
    )
    .expect("install failure triggers");
    drop(conn);

    let db = open_test_db_thread(path).await;
    let mut new_row = test_vm_row();
    new_row.name = "vm-2".to_string();
    assert!(
        db.upsert_vm(new_row)
            .await
            .expect_err("upsert SQL error must propagate")
            .to_string()
            .contains("upsert vms row")
    );
    assert!(
        db.delete_vm(existing.name)
            .await
            .expect_err("delete SQL error must propagate")
            .to_string()
            .contains("delete vms row")
    );
}

#[test]
fn image_cache_access_round_trips_and_orders_by_lru() {
    let path = test_db_path();
    let conn = open_prepared_connection(&path).expect("open db");
    touch_image_cache_entry(
        &conn,
        &ImageCacheAccessRow {
            image_key: "ubuntu".to_string(),
            image_sha256: "b".repeat(64),
            kernel_sha256: "c".repeat(64),
            initrd_sha256: "d".repeat(64),
            raw_bytes: 2048,
            last_accessed_at_ms: 20,
        },
    )
    .expect("touch newer");
    touch_image_cache_entry(
        &conn,
        &ImageCacheAccessRow {
            image_key: "debian".to_string(),
            image_sha256: "a".repeat(64),
            kernel_sha256: "e".repeat(64),
            initrd_sha256: "f".repeat(64),
            raw_bytes: 1024,
            last_accessed_at_ms: 10,
        },
    )
    .expect("touch older");

    let rows = load_image_cache_access(&conn).expect("load cache access");
    assert_eq!(
        rows.iter()
            .map(|row| row.image_key.as_str())
            .collect::<Vec<_>>(),
        vec!["debian", "ubuntu"]
    );

    delete_image_cache_access(&conn, &"a".repeat(64)).expect("delete access");
    let rows = load_image_cache_access(&conn).expect("reload cache access");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].image_key, "ubuntu");
}

#[test]
fn desired_state_cache_round_trips_single_row() {
    let path = test_db_path();
    let conn = open_prepared_connection(&path).expect("open db");
    let first = DesiredStateRow {
        host_id: "host-1".to_string(),
        version: 7,
        doc_json: r#"{"schema_version":1,"host_id":"host-1","version":7}"#.to_string(),
        updated_at_ms: 1000,
    };
    let second = DesiredStateRow {
        host_id: "host-1".to_string(),
        version: 8,
        doc_json: r#"{"schema_version":1,"host_id":"host-1","version":8}"#.to_string(),
        updated_at_ms: 2000,
    };

    assert!(load_desired_state(&conn).expect("empty load").is_none());
    upsert_desired_state(&conn, &first).expect("insert desired state");
    upsert_desired_state(&conn, &second).expect("replace desired state");

    assert_eq!(
        load_desired_state(&conn).expect("load desired state"),
        Some(second)
    );
}
