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

fn test_archive_job_row(
    run_id: &str,
    vm_name: &str,
    created_at_ms: i64,
    next_attempt_at_ms: i64,
) -> ArchiveJobRow {
    ArchiveJobRow {
        run_id: run_id.to_string(),
        vm_name: vm_name.to_string(),
        vm_created_at_ms: 1,
        delete_requested_at_ms: 2,
        deleted_at_ms: 3,
        artifacts_dir: format!("/tmp/{run_id}/{vm_name}/artifacts"),
        next_attempt_at_ms,
        retry_count: 0,
        last_error: None,
        created_at_ms,
        updated_at_ms: created_at_ms,
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

#[test]
fn due_archive_jobs_keep_later_same_run_work_behind_a_retrying_head() {
    let path = test_db_path();
    let conn = open_prepared_connection(&path).expect("open db");
    let first = test_archive_job_row("run-a", "vm-1", 10, 0);
    let later = test_archive_job_row("run-a", "vm-2", 11, 0);
    let independent = test_archive_job_row("run-b", "vm-1", 12, 0);
    upsert_archive_job(&conn, &first).expect("insert first same-run archive job");
    upsert_archive_job(&conn, &later).expect("insert later same-run archive job");
    upsert_archive_job(&conn, &independent).expect("insert independent archive job");

    let initially_due = load_due_archive_jobs(&conn, 0, 4).expect("load initial due jobs");
    assert_eq!(
        initially_due
            .iter()
            .map(|job| format!("{}/{}", job.run_id, job.vm_name))
            .collect::<Vec<_>>(),
        vec!["run-a/vm-1", "run-b/vm-1"]
    );

    // A duplicate queue wake must not move the durable run head behind a
    // later VM. The upsert refreshes attempt data but preserves its original
    // queued timestamp.
    let mut retried_first = first.clone();
    retried_first.next_attempt_at_ms = 100;
    retried_first.retry_count = 1;
    retried_first.last_error = Some("retry".to_string());
    retried_first.created_at_ms = 99;
    retried_first.updated_at_ms = 20;
    upsert_archive_job(&conn, &retried_first).expect("reschedule first same-run archive job");
    let while_retrying = load_due_archive_jobs(&conn, 20, 4).expect("load while retrying");
    assert_eq!(
        while_retrying
            .iter()
            .map(|job| format!("{}/{}", job.run_id, job.vm_name))
            .collect::<Vec<_>>(),
        vec!["run-b/vm-1"]
    );

    let retry_due = load_due_archive_jobs(&conn, 100, 4).expect("load retried head");
    assert!(
        retry_due
            .iter()
            .any(|job| job.run_id == "run-a" && job.vm_name == "vm-1")
    );
    assert_eq!(
        retry_due
            .iter()
            .find(|job| job.run_id == "run-a" && job.vm_name == "vm-1")
            .expect("retrying head is present")
            .created_at_ms,
        10,
        "upserting a retry must retain the original queued timestamp"
    );
    assert!(
        !retry_due
            .iter()
            .any(|job| job.run_id == "run-a" && job.vm_name == "vm-2"),
        "later same-run job must stay blocked until the retrying head is removed"
    );

    delete_archive_job(&conn, "run-a", "vm-1").expect("delete completed head");
    let after_head_completion =
        load_due_archive_jobs(&conn, 100, 4).expect("load newly exposed same-run job");
    assert!(
        after_head_completion
            .iter()
            .any(|job| job.run_id == "run-a" && job.vm_name == "vm-2"),
        "later same-run job becomes eligible only after its head completes"
    );
}

#[test]
fn due_archive_jobs_use_insertion_order_when_the_clock_moves_backward() {
    let path = test_db_path();
    let conn = open_prepared_connection(&path).expect("open db");
    let first = test_archive_job_row("run-a", "vm-z", 200, 100);
    let later_with_older_clock = test_archive_job_row("run-a", "vm-a", 100, 0);
    upsert_archive_job(&conn, &first).expect("insert first archive job");
    upsert_archive_job(&conn, &later_with_older_clock)
        .expect("insert later archive job with a backward clock");

    assert!(
        load_due_archive_jobs(&conn, 0, 4)
            .expect("load while first head is delayed")
            .is_empty(),
        "a later row with an older timestamp must not overtake the durable run head"
    );
    assert_eq!(
        load_due_archive_jobs(&conn, 100, 4)
            .expect("load durable head")
            .into_iter()
            .map(|job| job.vm_name)
            .collect::<Vec<_>>(),
        vec!["vm-z"]
    );
}

#[test]
fn due_archive_jobs_use_insertion_order_when_timestamps_match() {
    let path = test_db_path();
    let conn = open_prepared_connection(&path).expect("open db");
    let first = test_archive_job_row("run-a", "vm-z", 100, 100);
    let later_same_millisecond = test_archive_job_row("run-a", "vm-a", 100, 0);
    upsert_archive_job(&conn, &first).expect("insert first archive job");
    upsert_archive_job(&conn, &later_same_millisecond)
        .expect("insert later archive job in the same millisecond");

    assert!(
        load_due_archive_jobs(&conn, 0, 4)
            .expect("load while first head is delayed")
            .is_empty(),
        "VM-name order must not choose a later same-millisecond row as the head"
    );
    assert_eq!(
        load_due_archive_jobs(&conn, 100, 4)
            .expect("load durable head")
            .into_iter()
            .map(|job| job.vm_name)
            .collect::<Vec<_>>(),
        vec!["vm-z"]
    );
}

#[test]
fn archive_job_upsert_preserves_its_rowid_and_created_timestamp() {
    let path = test_db_path();
    let conn = open_prepared_connection(&path).expect("open db");
    let first = test_archive_job_row("run-a", "vm-z", 10, 100);
    let later = test_archive_job_row("run-a", "vm-a", 20, 0);
    upsert_archive_job(&conn, &first).expect("insert first archive job");
    upsert_archive_job(&conn, &later).expect("insert later archive job");
    let original_rowid: i64 = conn
        .query_row(
            "SELECT rowid FROM archive_jobs WHERE run_id = ?1 AND vm_name = ?2;",
            rusqlite::params!["run-a", "vm-z"],
            |row| row.get(0),
        )
        .expect("load first archive job rowid");

    let mut retried_first = first;
    retried_first.created_at_ms = -1_000;
    retried_first.next_attempt_at_ms = 200;
    retried_first.retry_count = 1;
    retried_first.updated_at_ms = 30;
    upsert_archive_job(&conn, &retried_first).expect("upsert first archive job retry");

    let (rowid, created_at_ms): (i64, i64) = conn
        .query_row(
            "SELECT rowid, created_at_ms FROM archive_jobs WHERE run_id = ?1 AND vm_name = ?2;",
            rusqlite::params!["run-a", "vm-z"],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("reload first archive job identity");
    assert_eq!(
        rowid, original_rowid,
        "upsert must keep initial insertion order"
    );
    assert_eq!(
        created_at_ms, 10,
        "upsert must keep the original queued timestamp for timing"
    );
    assert!(
        load_due_archive_jobs(&conn, 100, 4)
            .expect("load while retried head is delayed")
            .is_empty(),
        "the retried first row must remain the head even while a later row is due"
    );
    assert_eq!(
        load_due_archive_jobs(&conn, 200, 4)
            .expect("load retried durable head")
            .into_iter()
            .map(|job| job.vm_name)
            .collect::<Vec<_>>(),
        vec!["vm-z"]
    );
}
