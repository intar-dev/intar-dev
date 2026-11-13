use super::*;

pub(super) fn db_thread_main(
    db_path: PathBuf,
    mut rx: mpsc::Receiver<Op>,
    init_tx: oneshot::Sender<Result<Vec<VmRow>>>,
) {
    let mut conn = match open_prepared_connection(&db_path) {
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
            Op::LoadVmLab { vm_name, resp } => {
                let _ = resp.send(load_vm_lab(&conn, &vm_name));
            }
            Op::LoadAllVmLabs { resp } => {
                let _ = resp.send(load_all_vm_labs(&conn));
            }
            Op::UpsertVmAndLab { vm, lab, resp } => {
                let result = upsert_vm_and_lab(&mut conn, &vm, &lab);
                if let Err(error) = &result {
                    error!(error = %error, vm = vm.name, "sqlite VM and lab transaction failed");
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
            Op::LoadVerifiedContent { resp } => {
                let _ = resp.send(load_verified_content(&conn));
            }
            Op::UpsertVerifiedContent { row, resp } => {
                let _ = resp.send(upsert_verified_content(&conn, &row));
            }
            Op::LoadLocalVmDigests { resp } => {
                let _ = resp.send(load_local_vm_digests(&conn));
            }
            Op::LoadPendingTeardowns { resp } => {
                let _ = resp.send(load_pending_teardowns(&conn));
            }
            Op::DeletePendingTeardown { vm_name, resp } => {
                let _ = resp.send(delete_pending_teardown(&conn, &vm_name));
            }
        }
    }
}

pub(super) fn open_prepared_connection(db_path: &Path) -> Result<Connection> {
    let mut conn = Connection::open(db_path)
        .with_context(|| format!("failed to open sqlite db at {}", db_path.display()))?;
    prepare_connection(&conn)?;
    ensure_schema(&mut conn)?;
    Ok(conn)
}

pub(super) fn prepare_connection(conn: &Connection) -> Result<()> {
    conn.busy_timeout(Duration::from_secs(5))
        .context("failed to set busy_timeout")?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
        .context("failed to set sqlite pragmas")?;
    Ok(())
}

/// Brings the file to [`STATE_SCHEMA_VERSION`]. A file of any other
/// version is not migrated: its VMs are queued in `pending_teardown` for
/// jailerd to destroy, and every other table is dropped, in one
/// transaction. The caller works the queue off; nothing here can loop.
pub(super) fn ensure_schema(conn: &mut Connection) -> Result<()> {
    let version: i64 = conn
        .query_row("PRAGMA user_version;", [], |row| row.get(0))
        .context("read sqlite schema marker")?;
    if version == STATE_SCHEMA_VERSION {
        return conn
            .execute_batch(&format!("{BASELINE_SCHEMA_SQL}{CACHE_STATE_SCHEMA_SQL}"))
            .context("apply sqlite schema");
    }
    let transaction = conn.transaction().context("begin sqlite schema reset")?;
    let legacy = legacy_vms(&transaction)?;
    let tables = {
        let mut stmt = transaction.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%';",
        )?;
        stmt.query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("list sqlite tables")?
    };
    for table in &tables {
        transaction
            .execute_batch(&format!("DROP TABLE \"{}\";", table.replace('"', "\"\"")))
            .with_context(|| format!("drop sqlite table {table}"))?;
    }
    transaction
        .execute_batch(&format!("{BASELINE_SCHEMA_SQL}{CACHE_STATE_SCHEMA_SQL}"))
        .context("apply sqlite schema")?;
    for vm in &legacy {
        transaction
            .execute(
                "INSERT OR REPLACE INTO pending_teardown (vm_name, run_id, jail_generation) VALUES (?1, ?2, ?3);",
                params![vm.vm_name, vm.run_id, vm.jail_generation],
            )
            .context("queue legacy VM teardown")?;
    }
    transaction
        .execute_batch(&format!("PRAGMA user_version = {STATE_SCHEMA_VERSION};"))
        .context("write sqlite schema marker")?;
    transaction.commit().context("commit sqlite schema reset")?;
    if !tables.is_empty() {
        info!(
            from = version,
            to = STATE_SCHEMA_VERSION,
            dropped_tables = tables.len(),
            queued_vms = legacy.len(),
            "agent state schema changed; reset the state and queued its VMs for teardown"
        );
    }
    Ok(())
}

/// The VMs of an older schema, read with only the columns every schema
/// had. A `pending_teardown` left by an interrupted earlier reset is kept.
fn legacy_vms(conn: &Connection) -> Result<Vec<PendingTeardownRow>> {
    let mut rows = Vec::new();
    if table_has_column(conn, "pending_teardown", "vm_name")? {
        rows.extend(load_pending_teardowns(conn)?);
    }
    if !table_has_column(conn, "vms", "name")? {
        return Ok(rows);
    }
    let column = |name: &'static str| -> Result<&'static str> {
        Ok(if table_has_column(conn, "vms", name)? {
            name
        } else {
            "NULL"
        })
    };
    let query = format!(
        "SELECT name, {}, {} FROM vms;",
        column("run_id")?,
        column("jail_generation")?
    );
    let mut stmt = conn.prepare(&query).context("prepare legacy VM query")?;
    let legacy = stmt
        .query_map([], |row| {
            Ok(PendingTeardownRow {
                vm_name: row.get(0)?,
                run_id: row.get(1)?,
                jail_generation: row.get(2)?,
            })
        })
        .context("query legacy VMs")?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("collect legacy VMs")?;
    rows.extend(legacy);
    Ok(rows)
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
  image,
  kino,
  boot_sha256,
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
  kino_vsock_path,
  ssh_host_keys_openssh_json,
  run_id,
  recording_disk_path,
  spool_dir,
  cpu_millis,
  ch_executable_sha256,
  owner_user_id,
  runtime_execution_id,
  generation,
  machine_name
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
                image: row.get(2)?,
                kino: row.get(3)?,
                boot_sha256: row.get(4)?,
                created_at_s: row.get(5)?,
                updated_at_s: row.get(6)?,
                running_at_s: row.get(7)?,
                error: row.get(8)?,
                root_disk_path: row.get(9)?,
                seed_disk_path: row.get(10)?,
                mac: row.get(11)?,
                lease_duration_seconds: row.get(12)?,
                guest_ip: row.get(13)?,
                guest_ip_cidr: row.get(14)?,
                gateway: row.get(15)?,
                bridge_name: row.get(16)?,
                ssh_public_port: row.get(17)?,
                tap_name: row.get(18)?,
                ch_socket_path: row.get(19)?,
                ch_pid: row.get(20)?,
                ch_start_time_ticks: row.get(21)?,
                host_boot_id: row.get(22)?,
                jail_generation: row.get(23)?,
                jail_unit_name: row.get(24)?,
                jail_cgroup_path: row.get(25)?,
                jail_root_path: row.get(26)?,
                jail_root_inode: row.get(27)?,
                jail_uid: row.get(28)?,
                jail_gid: row.get(29)?,
                jail_netns_name: row.get(30)?,
                kino_vsock_cid: row.get(31)?,
                kino_vsock_path: row.get(32)?,
                ssh_host_keys_openssh_json: row.get(33)?,
                run_id: row.get(34)?,
                recording_disk_path: row.get(35)?,
                spool_dir: row.get(36)?,
                cpu_millis: row.get(37)?,
                ch_executable_sha256: row.get(38)?,
                owner_user_id: row.get(39)?,
                runtime_execution_id: row.get(40)?,
                generation: row.get(41)?,
                machine_name: row.get(42)?,
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
  image,
  kino,
  boot_sha256,
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
  kino_vsock_path,
  ssh_host_keys_openssh_json,
  run_id,
  recording_disk_path,
  spool_dir,
  cpu_millis,
  ch_executable_sha256,
  owner_user_id,
  runtime_execution_id,
  generation,
  machine_name
) VALUES (
  ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34, ?35, ?36, ?37, ?38, ?39, ?40, ?41, ?42, ?43
)
ON CONFLICT(name) DO UPDATE SET
  state = excluded.state,
  image = excluded.image,
  kino = excluded.kino,
  boot_sha256 = excluded.boot_sha256,
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
  kino_vsock_path = excluded.kino_vsock_path,
  ssh_host_keys_openssh_json = excluded.ssh_host_keys_openssh_json,
  run_id = excluded.run_id,
  recording_disk_path = excluded.recording_disk_path,
  spool_dir = excluded.spool_dir,
  cpu_millis = excluded.cpu_millis,
  ch_executable_sha256 = excluded.ch_executable_sha256,
  owner_user_id = excluded.owner_user_id,
  runtime_execution_id = excluded.runtime_execution_id,
  generation = excluded.generation,
  machine_name = excluded.machine_name;
"#,
        params![
            row.name,
            row.state,
            row.image,
            row.kino,
            row.boot_sha256,
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
            row.kino_vsock_path,
            row.ssh_host_keys_openssh_json,
            row.run_id,
            row.recording_disk_path,
            row.spool_dir,
            row.cpu_millis,
            row.ch_executable_sha256,
            row.owner_user_id,
            row.runtime_execution_id,
            row.generation,
            row.machine_name,
        ],
    )
    .context("upsert vms row")?;

    Ok(())
}

pub(super) fn delete_vm(conn: &Connection, name: &str) -> Result<()> {
    conn.execute("DELETE FROM vms WHERE name = ?1;", params![name])
        .context("delete vms row")?;
    conn.execute("DELETE FROM vm_lab WHERE vm_name = ?1;", params![name])
        .context("delete vm_lab row")?;
    Ok(())
}

const VM_LAB_COLUMNS: &str =
    "vm_name, run_id, jail_generation, lab_json, first_report_ms, updated_at_ms";

fn vm_lab_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<VmLabRow> {
    Ok(VmLabRow {
        vm_name: row.get(0)?,
        run_id: row.get(1)?,
        jail_generation: row.get(2)?,
        lab_json: row.get(3)?,
        first_report_ms: row.get(4)?,
        updated_at_ms: row.get(5)?,
    })
}

pub(super) fn load_vm_lab(conn: &Connection, vm_name: &str) -> Result<Option<VmLabRow>> {
    conn.query_row(
        &format!("SELECT {VM_LAB_COLUMNS} FROM vm_lab WHERE vm_name = ?1;"),
        params![vm_name],
        vm_lab_row,
    )
    .optional()
    .context("load vm_lab row")
}

pub(super) fn load_all_vm_labs(conn: &Connection) -> Result<Vec<VmLabRow>> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {VM_LAB_COLUMNS} FROM vm_lab ORDER BY updated_at_ms ASC, vm_name ASC;"
        ))
        .context("prepare load_all_vm_labs")?;
    stmt.query_map([], vm_lab_row)
        .context("query load_all_vm_labs")?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("collect load_all_vm_labs")
}

pub(super) fn upsert_vm_lab(conn: &Connection, row: &VmLabRow) -> Result<()> {
    conn.execute(
        r#"
INSERT INTO vm_lab (vm_name, run_id, jail_generation, lab_json, first_report_ms, updated_at_ms)
VALUES (?1, ?2, ?3, ?4, ?5, ?6)
ON CONFLICT(vm_name) DO UPDATE SET
  run_id = excluded.run_id,
  jail_generation = excluded.jail_generation,
  lab_json = excluded.lab_json,
  first_report_ms = excluded.first_report_ms,
  updated_at_ms = excluded.updated_at_ms;
"#,
        params![
            row.vm_name,
            row.run_id,
            row.jail_generation,
            row.lab_json,
            row.first_report_ms,
            row.updated_at_ms,
        ],
    )
    .context("upsert vm_lab row")?;
    Ok(())
}

/// The VM row and its latest lab in one transaction: a Ready VM is never
/// persisted without the report that made it Ready.
pub(super) fn upsert_vm_and_lab(conn: &mut Connection, vm: &VmRow, lab: &VmLabRow) -> Result<()> {
    anyhow::ensure!(
        vm.name == lab.vm_name,
        "VM and lab rows identify different VMs"
    );
    anyhow::ensure!(
        vm.run_id.as_deref() == Some(lab.run_id.as_str()),
        "VM and lab rows identify different runs"
    );
    let transaction = conn
        .transaction()
        .context("begin VM and lab SQLite transaction")?;
    upsert_vm(&transaction, vm).context("persist VM row")?;
    upsert_vm_lab(&transaction, lab).context("persist lab row")?;
    transaction
        .commit()
        .context("commit VM and lab SQLite transaction")
}
