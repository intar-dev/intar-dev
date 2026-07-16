use super::*;

pub(super) fn db_thread_main(
    db_path: PathBuf,
    mut rx: mpsc::Receiver<Op>,
    init_tx: oneshot::Sender<Result<Vec<VmRow>>>,
) {
    let mut conn = match open_or_reset_database(&db_path) {
        Ok(conn) => conn,
        Err(error) => {
            let _ = init_tx.send(Err(error));
            return;
        }
    };

    let initial_rows = match load_all_vms(&conn) {
        Ok(rows) => rows,
        Err(error) => {
            let _ = init_tx.send(Err(error));
            return;
        }
    };
    let _ = init_tx.send(Ok(initial_rows));

    while let Some(op) = rx.blocking_recv() {
        match op {
            Op::UpsertVm { row, resp } => {
                let result = upsert_vm(&conn, &row);
                if let Err(error) = &result {
                    error!(error = %error, vm = row.name, "sqlite upsert vm failed");
                }
                let _ = resp.send(result);
            }
            Op::DeleteVm { name, resp } => {
                let result = delete_vm(&conn, &name);
                if let Err(error) = &result {
                    error!(error = %error, vm = name, "sqlite delete vm failed");
                }
                let _ = resp.send(result);
            }
            Op::LoadVmProbeState { vm_name, resp } => {
                let _ = resp.send(load_vm_probe_state(&conn, &vm_name));
            }
            Op::LoadAllVmProbeStates { resp } => {
                let _ = resp.send(load_all_vm_probe_states(&conn));
            }
            Op::UpsertReadyVmAndProbeState { vm, probe, resp } => {
                let result = upsert_ready_vm_and_probe_state(&mut conn, &vm, &probe);
                if let Err(error) = &result {
                    error!(
                        error = %error,
                        vm = vm.name,
                        "sqlite ready VM transaction failed"
                    );
                }
                let _ = resp.send(result);
            }
            Op::UpsertArchiveJob { row, resp } => {
                let _ = resp.send(upsert_archive_job(&conn, &row));
            }
            Op::LoadDueArchiveJobs {
                now_ms,
                limit,
                resp,
            } => {
                let _ = resp.send(load_due_archive_jobs(&conn, now_ms, limit));
            }
            Op::DeleteArchiveJob {
                run_id,
                vm_name,
                resp,
            } => {
                let _ = resp.send(delete_archive_job(&conn, &run_id, &vm_name));
            }
            Op::UpdateArchiveJobRetry {
                run_id,
                vm_name,
                next_attempt_at_ms,
                retry_count,
                last_error,
                updated_at_ms,
                resp,
            } => {
                let _ = resp.send(update_archive_job_retry(
                    &conn,
                    &run_id,
                    &vm_name,
                    next_attempt_at_ms,
                    retry_count,
                    last_error.as_deref(),
                    updated_at_ms,
                ));
            }
            Op::LoadDesiredState { resp } => {
                let _ = resp.send(load_desired_state(&conn));
            }
            Op::UpsertDesiredState { row, resp } => {
                let _ = resp.send(upsert_desired_state(&conn, &row));
            }
            Op::TouchImageCacheEntry { row, resp } => {
                let _ = resp.send(touch_image_cache_entry(&conn, &row));
            }
            Op::LoadImageCacheAccess { resp } => {
                let _ = resp.send(load_image_cache_access(&conn));
            }
            Op::LoadLocalVmImageShas { resp } => {
                let _ = resp.send(load_local_vm_image_shas(&conn));
            }
            Op::DeleteImageCacheAccess { image_sha256, resp } => {
                let _ = resp.send(delete_image_cache_access(&conn, &image_sha256));
            }
        }
    }
}

pub(super) fn open_or_reset_database(db_path: &Path) -> Result<Connection> {
    open_prepared_connection(db_path).map_err(|error| {
        anyhow::anyhow!(
            "sqlite db at {} is incompatible with the baseline schema; purge the file and restart: {error}",
            db_path.display()
        )
    })
}

pub(super) fn open_prepared_connection(db_path: &Path) -> Result<Connection> {
    let conn = Connection::open(db_path)
        .with_context(|| format!("failed to open sqlite db at {}", db_path.display()))?;
    prepare_connection(&conn)?;
    ensure_baseline_schema(&conn)?;
    Ok(conn)
}

pub(super) fn prepare_connection(conn: &Connection) -> Result<()> {
    conn.busy_timeout(Duration::from_secs(5))
        .context("failed to set busy_timeout")?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
        .context("failed to set sqlite pragmas")?;
    Ok(())
}

pub(super) fn ensure_baseline_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(BASELINE_SCHEMA_SQL)
        .context("failed to apply baseline sqlite schema")?;

    let has_any_tables: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%');",
            [],
            |row| row.get(0),
        )
        .context("failed to check existing sqlite tables")?;

    if has_any_tables && !schema_is_compatible(conn)? {
        anyhow::bail!("sqlite schema is incompatible with the baseline schema");
    }
    Ok(())
}

pub(super) fn schema_is_compatible(conn: &Connection) -> Result<bool> {
    let requirements = [
        ("vms", "name"),
        ("vms", "image_key"),
        ("vms", "image_sha256"),
        ("vms", "spool_dir"),
        ("vms", "ssh_public_port"),
        ("vms", "ssh_host_keys_openssh_json"),
        ("vms", "guest_ip_cidr"),
        ("vms", "gateway"),
        ("vms", "bridge_name"),
        ("vms", "ch_start_time_ticks"),
        ("vms", "host_boot_id"),
        ("vms", "jail_generation"),
        ("vms", "jail_unit_name"),
        ("vms", "jail_cgroup_path"),
        ("vms", "jail_root_path"),
        ("vms", "jail_root_inode"),
        ("vms", "jail_uid"),
        ("vms", "jail_gid"),
        ("vms", "jail_netns_name"),
        ("vms", "cpu_millis"),
        ("vms", "vcpu_count"),
        ("vms", "ch_executable_sha256"),
        ("desired_state", "doc_json"),
        ("vm_probe_state", "snapshot_json"),
        ("archive_jobs", "run_id"),
    ];

    for (table, column) in requirements {
        if !table_has_column(conn, table, column)? {
            return Ok(false);
        }
    }

    Ok(true)
}

pub(super) fn table_has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let pragma = format!("PRAGMA table_info({table});");
    let mut stmt = conn
        .prepare(&pragma)
        .with_context(|| format!("prepare table_info for {table}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .with_context(|| format!("query table_info for {table}"))?;
    for value in rows {
        if value? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(super) fn load_all_vms(conn: &Connection) -> Result<Vec<VmRow>> {
    let mut stmt = conn
        .prepare(
            r#"
SELECT
  name,
  state,
  image_key,
  image_sha256,
  created_at_s,
  updated_at_s,
  running_at_s,
  error,
  root_disk_path,
  seed_disk_path,
  mac,
  lease_duration_seconds,
  guest_ip,
  guest_ip_cidr,
  gateway,
  bridge_name,
  ssh_public_port,
  tap_name,
  ch_socket_path,
  ch_pid,
  ch_start_time_ticks,
  host_boot_id,
  jail_generation,
  jail_unit_name,
  jail_cgroup_path,
  jail_root_path,
  jail_root_inode,
  jail_uid,
  jail_gid,
  jail_netns_name,
  kino_vsock_cid,
  kino_vsock_port,
  kino_vsock_path,
  ssh_host_keys_openssh_json,
  run_id,
  recording_disk_path,
  spool_dir,
  cpu_millis,
  vcpu_count,
  ch_executable_sha256
FROM vms
ORDER BY created_at_s ASC;
"#,
        )
        .context("prepare load_all_vms query")?;

    let rows = stmt
        .query_map([], |row| {
            Ok(VmRow {
                name: row.get(0)?,
                state: row.get(1)?,
                image_key: row.get(2)?,
                image_sha256: row.get(3)?,
                created_at_s: row.get(4)?,
                updated_at_s: row.get(5)?,
                running_at_s: row.get(6)?,
                error: row.get(7)?,
                root_disk_path: row.get(8)?,
                seed_disk_path: row.get(9)?,
                mac: row.get(10)?,
                lease_duration_seconds: row.get(11)?,
                guest_ip: row.get(12)?,
                guest_ip_cidr: row.get(13)?,
                gateway: row.get(14)?,
                bridge_name: row.get(15)?,
                ssh_public_port: row.get(16)?,
                tap_name: row.get(17)?,
                ch_socket_path: row.get(18)?,
                ch_pid: row.get(19)?,
                ch_start_time_ticks: row.get(20)?,
                host_boot_id: row.get(21)?,
                jail_generation: row.get(22)?,
                jail_unit_name: row.get(23)?,
                jail_cgroup_path: row.get(24)?,
                jail_root_path: row.get(25)?,
                jail_root_inode: row.get(26)?,
                jail_uid: row.get(27)?,
                jail_gid: row.get(28)?,
                jail_netns_name: row.get(29)?,
                kino_vsock_cid: row.get(30)?,
                kino_vsock_port: row.get(31)?,
                kino_vsock_path: row.get(32)?,
                ssh_host_keys_openssh_json: row.get(33)?,
                run_id: row.get(34)?,
                recording_disk_path: row.get(35)?,
                spool_dir: row.get(36)?,
                cpu_millis: row.get(37)?,
                vcpu_count: row.get(38)?,
                ch_executable_sha256: row.get(39)?,
            })
        })
        .context("query load_all_vms")?;

    rows.collect::<rusqlite::Result<Vec<VmRow>>>()
        .context("collect load_all_vms rows")
}

pub(super) fn upsert_vm(conn: &Connection, row: &VmRow) -> Result<()> {
    conn.execute(
        r#"
INSERT INTO vms (
  name,
  state,
  image_key,
  image_sha256,
  created_at_s,
  updated_at_s,
  running_at_s,
  error,
  root_disk_path,
  seed_disk_path,
  mac,
  lease_duration_seconds,
  guest_ip,
  guest_ip_cidr,
  gateway,
  bridge_name,
  ssh_public_port,
  tap_name,
  ch_socket_path,
  ch_pid,
  ch_start_time_ticks,
  host_boot_id,
  jail_generation,
  jail_unit_name,
  jail_cgroup_path,
  jail_root_path,
  jail_root_inode,
  jail_uid,
  jail_gid,
  jail_netns_name,
  kino_vsock_cid,
  kino_vsock_port,
  kino_vsock_path,
  ssh_host_keys_openssh_json,
  run_id,
  recording_disk_path,
  spool_dir,
  cpu_millis,
  vcpu_count,
  ch_executable_sha256
) VALUES (
  ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34, ?35, ?36, ?37, ?38, ?39, ?40
)
ON CONFLICT(name) DO UPDATE SET
  state = excluded.state,
  image_key = excluded.image_key,
  image_sha256 = excluded.image_sha256,
  created_at_s = excluded.created_at_s,
  updated_at_s = excluded.updated_at_s,
  running_at_s = excluded.running_at_s,
  error = excluded.error,
  root_disk_path = excluded.root_disk_path,
  seed_disk_path = excluded.seed_disk_path,
  mac = excluded.mac,
  lease_duration_seconds = excluded.lease_duration_seconds,
  guest_ip = excluded.guest_ip,
  guest_ip_cidr = excluded.guest_ip_cidr,
  gateway = excluded.gateway,
  bridge_name = excluded.bridge_name,
  ssh_public_port = excluded.ssh_public_port,
  tap_name = excluded.tap_name,
  ch_socket_path = excluded.ch_socket_path,
  ch_pid = excluded.ch_pid,
  ch_start_time_ticks = excluded.ch_start_time_ticks,
  host_boot_id = excluded.host_boot_id,
  jail_generation = excluded.jail_generation,
  jail_unit_name = excluded.jail_unit_name,
  jail_cgroup_path = excluded.jail_cgroup_path,
  jail_root_path = excluded.jail_root_path,
  jail_root_inode = excluded.jail_root_inode,
  jail_uid = excluded.jail_uid,
  jail_gid = excluded.jail_gid,
  jail_netns_name = excluded.jail_netns_name,
  kino_vsock_cid = excluded.kino_vsock_cid,
  kino_vsock_port = excluded.kino_vsock_port,
  kino_vsock_path = excluded.kino_vsock_path,
  ssh_host_keys_openssh_json = excluded.ssh_host_keys_openssh_json,
  run_id = excluded.run_id,
  recording_disk_path = excluded.recording_disk_path,
  spool_dir = excluded.spool_dir,
  cpu_millis = excluded.cpu_millis,
  vcpu_count = excluded.vcpu_count,
  ch_executable_sha256 = excluded.ch_executable_sha256;
"#,
        params![
            row.name,
            row.state,
            row.image_key,
            row.image_sha256,
            row.created_at_s,
            row.updated_at_s,
            row.running_at_s,
            row.error,
            row.root_disk_path,
            row.seed_disk_path,
            row.mac,
            row.lease_duration_seconds,
            row.guest_ip,
            row.guest_ip_cidr,
            row.gateway,
            row.bridge_name,
            row.ssh_public_port,
            row.tap_name,
            row.ch_socket_path,
            row.ch_pid,
            row.ch_start_time_ticks,
            row.host_boot_id,
            row.jail_generation,
            row.jail_unit_name,
            row.jail_cgroup_path,
            row.jail_root_path,
            row.jail_root_inode,
            row.jail_uid,
            row.jail_gid,
            row.jail_netns_name,
            row.kino_vsock_cid,
            row.kino_vsock_port,
            row.kino_vsock_path,
            row.ssh_host_keys_openssh_json,
            row.run_id,
            row.recording_disk_path,
            row.spool_dir,
            row.cpu_millis,
            row.vcpu_count,
            row.ch_executable_sha256,
        ],
    )
    .context("upsert vms row")?;

    Ok(())
}

pub(super) fn delete_vm(conn: &Connection, name: &str) -> Result<()> {
    conn.execute("DELETE FROM vms WHERE name = ?1;", params![name])
        .context("delete vms row")?;
    conn.execute(
        "DELETE FROM vm_probe_state WHERE vm_name = ?1;",
        params![name],
    )
    .context("delete vm_probe_state row")?;
    Ok(())
}

pub(super) fn load_vm_probe_state(
    conn: &Connection,
    vm_name: &str,
) -> Result<Option<VmProbeStateRow>> {
    conn.query_row(
        r#"
SELECT
  vm_name,
  run_id,
  fingerprint,
  collection_state,
  collection_error,
  summary_json,
  snapshot_json,
  generated_at_ms,
  updated_at_ms
FROM vm_probe_state
WHERE vm_name = ?1
LIMIT 1;
"#,
        params![vm_name],
        |row| {
            Ok(VmProbeStateRow {
                vm_name: row.get(0)?,
                run_id: row.get(1)?,
                fingerprint: row.get(2)?,
                collection_state: row.get(3)?,
                collection_error: row.get(4)?,
                summary_json: row.get(5)?,
                snapshot_json: row.get(6)?,
                generated_at_ms: row.get(7)?,
                updated_at_ms: row.get(8)?,
            })
        },
    )
    .optional()
    .context("load vm_probe_state row")
}

pub(super) fn load_all_vm_probe_states(conn: &Connection) -> Result<Vec<VmProbeStateRow>> {
    let mut stmt = conn
        .prepare(
            r#"
SELECT
  vm_name,
  run_id,
  fingerprint,
  collection_state,
  collection_error,
  summary_json,
  snapshot_json,
  generated_at_ms,
  updated_at_ms
FROM vm_probe_state
ORDER BY updated_at_ms ASC, vm_name ASC;
"#,
        )
        .context("prepare load_all_vm_probe_states query")?;

    let rows = stmt
        .query_map([], |row| {
            Ok(VmProbeStateRow {
                vm_name: row.get(0)?,
                run_id: row.get(1)?,
                fingerprint: row.get(2)?,
                collection_state: row.get(3)?,
                collection_error: row.get(4)?,
                summary_json: row.get(5)?,
                snapshot_json: row.get(6)?,
                generated_at_ms: row.get(7)?,
                updated_at_ms: row.get(8)?,
            })
        })
        .context("query load_all_vm_probe_states")?;

    rows.collect::<rusqlite::Result<Vec<VmProbeStateRow>>>()
        .context("collect load_all_vm_probe_states rows")
}

pub(super) fn upsert_vm_probe_state(conn: &Connection, row: &VmProbeStateRow) -> Result<()> {
    conn.execute(
        r#"
INSERT INTO vm_probe_state (
  vm_name,
  run_id,
  fingerprint,
  collection_state,
  collection_error,
  summary_json,
  snapshot_json,
  generated_at_ms,
  updated_at_ms
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
ON CONFLICT(vm_name) DO UPDATE SET
  run_id = excluded.run_id,
  fingerprint = excluded.fingerprint,
  collection_state = excluded.collection_state,
  collection_error = excluded.collection_error,
  summary_json = excluded.summary_json,
  snapshot_json = excluded.snapshot_json,
  generated_at_ms = excluded.generated_at_ms,
  updated_at_ms = excluded.updated_at_ms;
"#,
        params![
            row.vm_name,
            row.run_id,
            row.fingerprint,
            row.collection_state,
            row.collection_error,
            row.summary_json,
            row.snapshot_json,
            row.generated_at_ms,
            row.updated_at_ms,
        ],
    )
    .context("upsert vm_probe_state row")?;

    Ok(())
}

pub(super) fn upsert_ready_vm_and_probe_state(
    conn: &mut Connection,
    vm: &VmRow,
    probe: &VmProbeStateRow,
) -> Result<()> {
    anyhow::ensure!(
        vm.name == probe.vm_name,
        "ready VM and probe rows identify different VMs"
    );
    anyhow::ensure!(
        vm.run_id.as_deref() == Some(probe.run_id.as_str()),
        "ready VM and probe rows identify different runs"
    );
    anyhow::ensure!(
        vm.state == "running",
        "ready VM transaction requires the running lifecycle state"
    );

    let transaction = conn
        .transaction()
        .context("begin ready VM SQLite transaction")?;
    upsert_vm(&transaction, vm).context("persist ready VM row")?;
    upsert_vm_probe_state(&transaction, probe).context("persist ready probe row")?;
    transaction
        .commit()
        .context("commit ready VM SQLite transaction")
}
