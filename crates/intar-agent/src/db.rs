#![forbid(unsafe_code)]

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context as _, Result};
use rusqlite::{Connection, OptionalExtension, params};
use tokio::sync::{mpsc, oneshot};
use tracing::{error, info, warn};

#[derive(Debug, Clone)]
pub struct VmRow {
    pub name: String,
    pub state: String,
    pub created_at_s: i64,
    pub updated_at_s: i64,
    pub running_at_s: Option<i64>,
    pub error: Option<String>,
    pub root_disk_path: Option<String>,
    pub seed_disk_path: Option<String>,
    pub mac: Option<String>,
    pub lease_duration_seconds: Option<i64>,
    pub guest_ip: Option<String>,
    pub guest_ip_cidr: Option<String>,
    pub gateway: Option<String>,
    pub bridge_name: Option<String>,
    pub ssh_public_port: Option<i64>,
    pub tap_name: Option<String>,
    pub ch_socket_path: Option<String>,
    pub ch_pid: Option<i64>,
    pub kino_vsock_cid: Option<i64>,
    pub kino_vsock_port: Option<i64>,
    pub kino_vsock_path: Option<String>,
    pub ssh_host_keys_openssh_json: Option<String>,
    pub run_id: Option<String>,
    pub recording_disk_path: Option<String>,
    pub spool_dir: Option<String>,
}

#[derive(Debug, Clone)]
pub struct VmProbeStateRow {
    pub vm_name: String,
    pub run_id: String,
    pub fingerprint: String,
    pub collection_state: String,
    pub collection_error: Option<String>,
    pub summary_json: String,
    pub snapshot_json: String,
    pub generated_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveJobRow {
    pub run_id: String,
    pub vm_name: String,
    pub vm_created_at_ms: i64,
    pub delete_requested_at_ms: i64,
    pub deleted_at_ms: i64,
    pub artifacts_dir: String,
    pub next_attempt_at_ms: i64,
    pub retry_count: i64,
    pub last_error: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesiredStateRow {
    pub host_id: String,
    pub version: i64,
    pub doc_json: String,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug)]
pub struct Db {
    tx: mpsc::Sender<Op>,
}

enum Op {
    UpsertVm(Box<VmRow>),
    DeleteVm(String),
    LoadVmProbeState {
        vm_name: String,
        resp: oneshot::Sender<Result<Option<VmProbeStateRow>>>,
    },
    LoadAllVmProbeStates {
        resp: oneshot::Sender<Result<Vec<VmProbeStateRow>>>,
    },
    UpsertVmProbeState {
        row: Box<VmProbeStateRow>,
        resp: oneshot::Sender<Result<()>>,
    },
    UpsertArchiveJob {
        row: Box<ArchiveJobRow>,
        resp: oneshot::Sender<Result<()>>,
    },
    LoadDueArchiveJobs {
        now_ms: i64,
        limit: usize,
        resp: oneshot::Sender<Result<Vec<ArchiveJobRow>>>,
    },
    DeleteArchiveJob {
        run_id: String,
        vm_name: String,
        resp: oneshot::Sender<Result<()>>,
    },
    UpdateArchiveJobRetry {
        run_id: String,
        vm_name: String,
        next_attempt_at_ms: i64,
        retry_count: i64,
        last_error: Option<String>,
        updated_at_ms: i64,
        resp: oneshot::Sender<Result<()>>,
    },
    LoadDesiredState {
        resp: oneshot::Sender<Result<Option<DesiredStateRow>>>,
    },
    UpsertDesiredState {
        row: Box<DesiredStateRow>,
        resp: oneshot::Sender<Result<()>>,
    },
}

impl Db {
    pub async fn open() -> Result<(Self, Vec<VmRow>)> {
        let mut candidates: Vec<(PathBuf, &'static str)> = Vec::new();
        if let Some(p) = dirs::state_dir() {
            candidates.push((p.join("intar-agent"), "state_dir"));
        }
        if let Some(p) = dirs::cache_dir() {
            let cache_path = p.join("intar-agent");
            if !candidates
                .iter()
                .any(|(existing, _)| *existing == cache_path)
            {
                candidates.push((cache_path, "cache_dir"));
            }
        }
        if candidates.is_empty() {
            anyhow::bail!("state/cache dir unavailable");
        }

        let mut db_dir = None;
        let mut root_kind = None;
        let mut failures = Vec::new();
        for (candidate, kind) in candidates {
            match tokio::fs::create_dir_all(&candidate).await {
                Ok(_) => {
                    db_dir = Some(candidate);
                    root_kind = Some(kind);
                    break;
                }
                Err(e) => {
                    warn!(
                        path = %candidate.display(),
                        root_kind = kind,
                        error = %e,
                        "failed to create db dir candidate"
                    );
                    failures.push(format!("{kind}: {} ({e})", candidate.display()));
                }
            }
        }

        let db_dir = db_dir.ok_or_else(|| {
            anyhow::anyhow!(
                "failed to create db dir from dirs::state_dir()/dirs::cache_dir: {}",
                failures.join("; ")
            )
        })?;
        let kind = root_kind.expect("root_kind must be set when db_dir is set");
        let db_path = db_dir.join("intar-agent.sqlite3");
        info!(path = %db_path.display(), root_kind = kind, "opening sqlite db");

        let (tx, rx) = mpsc::channel::<Op>(256);
        let (init_tx, init_rx) = oneshot::channel::<Result<Vec<VmRow>>>();

        std::thread::spawn(move || db_thread_main(db_path, rx, init_tx));

        let rows = init_rx
            .await
            .context("db thread dropped without sending init result")??;

        Ok((Self { tx }, rows))
    }

    pub async fn upsert_vm(&self, row: VmRow) -> Result<()> {
        self.tx
            .send(Op::UpsertVm(Box::new(row)))
            .await
            .context("db channel closed")?;
        Ok(())
    }

    pub async fn delete_vm(&self, name: String) -> Result<()> {
        self.tx
            .send(Op::DeleteVm(name))
            .await
            .context("db channel closed")?;
        Ok(())
    }

    pub async fn load_vm_probe_state(&self, vm_name: String) -> Result<Option<VmProbeStateRow>> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<Option<VmProbeStateRow>>>();
        self.tx
            .send(Op::LoadVmProbeState {
                vm_name,
                resp: resp_tx,
            })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped vm probe state response")?
    }

    pub async fn load_all_vm_probe_states(&self) -> Result<Vec<VmProbeStateRow>> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<Vec<VmProbeStateRow>>>();
        self.tx
            .send(Op::LoadAllVmProbeStates { resp: resp_tx })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped all vm probe states response")?
    }

    pub async fn upsert_vm_probe_state(&self, row: VmProbeStateRow) -> Result<()> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<()>>();
        self.tx
            .send(Op::UpsertVmProbeState {
                row: Box::new(row),
                resp: resp_tx,
            })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped vm probe state upsert response")?
    }

    pub async fn upsert_archive_job(&self, row: ArchiveJobRow) -> Result<()> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<()>>();
        self.tx
            .send(Op::UpsertArchiveJob {
                row: Box::new(row),
                resp: resp_tx,
            })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped archive job upsert response")?
    }

    pub async fn load_due_archive_jobs(
        &self,
        now_ms: i64,
        limit: usize,
    ) -> Result<Vec<ArchiveJobRow>> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<Vec<ArchiveJobRow>>>();
        self.tx
            .send(Op::LoadDueArchiveJobs {
                now_ms,
                limit,
                resp: resp_tx,
            })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped due archive jobs response")?
    }

    pub async fn delete_archive_job(&self, run_id: String, vm_name: String) -> Result<()> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<()>>();
        self.tx
            .send(Op::DeleteArchiveJob {
                run_id,
                vm_name,
                resp: resp_tx,
            })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped delete archive job response")?
    }

    pub async fn update_archive_job_retry(
        &self,
        run_id: String,
        vm_name: String,
        next_attempt_at_ms: i64,
        retry_count: i64,
        last_error: Option<String>,
        updated_at_ms: i64,
    ) -> Result<()> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<()>>();
        self.tx
            .send(Op::UpdateArchiveJobRetry {
                run_id,
                vm_name,
                next_attempt_at_ms,
                retry_count,
                last_error,
                updated_at_ms,
                resp: resp_tx,
            })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped update archive job retry response")?
    }

    pub async fn load_desired_state(&self) -> Result<Option<DesiredStateRow>> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<Option<DesiredStateRow>>>();
        self.tx
            .send(Op::LoadDesiredState { resp: resp_tx })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped desired state load response")?
    }

    pub async fn upsert_desired_state(&self, row: DesiredStateRow) -> Result<()> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<()>>();
        self.tx
            .send(Op::UpsertDesiredState {
                row: Box::new(row),
                resp: resp_tx,
            })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped desired state upsert response")?
    }
}

fn db_thread_main(
    db_path: PathBuf,
    mut rx: mpsc::Receiver<Op>,
    init_tx: oneshot::Sender<Result<Vec<VmRow>>>,
) {
    let conn = match open_or_reset_database(&db_path) {
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
            Op::UpsertVm(row) => {
                if let Err(error) = upsert_vm(&conn, &row) {
                    error!(error = %error, vm = row.name, "sqlite upsert vm failed");
                }
            }
            Op::DeleteVm(name) => {
                if let Err(error) = delete_vm(&conn, &name) {
                    error!(error = %error, vm = name, "sqlite delete vm failed");
                }
            }
            Op::LoadVmProbeState { vm_name, resp } => {
                let _ = resp.send(load_vm_probe_state(&conn, &vm_name));
            }
            Op::LoadAllVmProbeStates { resp } => {
                let _ = resp.send(load_all_vm_probe_states(&conn));
            }
            Op::UpsertVmProbeState { row, resp } => {
                let _ = resp.send(upsert_vm_probe_state(&conn, &row));
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
        }
    }
}

fn open_or_reset_database(db_path: &Path) -> Result<Connection> {
    open_prepared_connection(db_path).map_err(|error| {
        anyhow::anyhow!(
            "sqlite db at {} is incompatible with the baseline schema; purge the file and restart: {error}",
            db_path.display()
        )
    })
}

fn open_prepared_connection(db_path: &Path) -> Result<Connection> {
    let conn = Connection::open(db_path)
        .with_context(|| format!("failed to open sqlite db at {}", db_path.display()))?;
    prepare_connection(&conn)?;
    ensure_baseline_schema(&conn)?;
    Ok(conn)
}

fn prepare_connection(conn: &Connection) -> Result<()> {
    conn.busy_timeout(Duration::from_secs(5))
        .context("failed to set busy_timeout")?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
        .context("failed to set sqlite pragmas")?;
    Ok(())
}

fn ensure_baseline_schema(conn: &Connection) -> Result<()> {
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

fn schema_is_compatible(conn: &Connection) -> Result<bool> {
    let requirements = [
        ("vms", "name"),
        ("vms", "spool_dir"),
        ("vms", "ssh_public_port"),
        ("vms", "ssh_host_keys_openssh_json"),
        ("vms", "guest_ip_cidr"),
        ("vms", "gateway"),
        ("vms", "bridge_name"),
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

fn table_has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
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

fn load_all_vms(conn: &Connection) -> Result<Vec<VmRow>> {
    let mut stmt = conn
        .prepare(
            r#"
SELECT
  name,
  state,
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
  kino_vsock_cid,
  kino_vsock_port,
  kino_vsock_path,
  ssh_host_keys_openssh_json,
  run_id,
  recording_disk_path,
  spool_dir
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
                created_at_s: row.get(2)?,
                updated_at_s: row.get(3)?,
                running_at_s: row.get(4)?,
                error: row.get(5)?,
                root_disk_path: row.get(6)?,
                seed_disk_path: row.get(7)?,
                mac: row.get(8)?,
                lease_duration_seconds: row.get(9)?,
                guest_ip: row.get(10)?,
                guest_ip_cidr: row.get(11)?,
                gateway: row.get(12)?,
                bridge_name: row.get(13)?,
                ssh_public_port: row.get(14)?,
                tap_name: row.get(15)?,
                ch_socket_path: row.get(16)?,
                ch_pid: row.get(17)?,
                kino_vsock_cid: row.get(18)?,
                kino_vsock_port: row.get(19)?,
                kino_vsock_path: row.get(20)?,
                ssh_host_keys_openssh_json: row.get(21)?,
                run_id: row.get(22)?,
                recording_disk_path: row.get(23)?,
                spool_dir: row.get(24)?,
            })
        })
        .context("query load_all_vms")?;

    rows.collect::<rusqlite::Result<Vec<VmRow>>>()
        .context("collect load_all_vms rows")
}

fn upsert_vm(conn: &Connection, row: &VmRow) -> Result<()> {
    conn.execute(
        r#"
INSERT INTO vms (
  name,
  state,
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
  kino_vsock_cid,
  kino_vsock_port,
  kino_vsock_path,
  ssh_host_keys_openssh_json,
  run_id,
  recording_disk_path,
  spool_dir
) VALUES (
  ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25
)
ON CONFLICT(name) DO UPDATE SET
  state = excluded.state,
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
  kino_vsock_cid = excluded.kino_vsock_cid,
  kino_vsock_port = excluded.kino_vsock_port,
  kino_vsock_path = excluded.kino_vsock_path,
  ssh_host_keys_openssh_json = excluded.ssh_host_keys_openssh_json,
  run_id = excluded.run_id,
  recording_disk_path = excluded.recording_disk_path,
  spool_dir = excluded.spool_dir;
"#,
        params![
            row.name,
            row.state,
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
            row.kino_vsock_cid,
            row.kino_vsock_port,
            row.kino_vsock_path,
            row.ssh_host_keys_openssh_json,
            row.run_id,
            row.recording_disk_path,
            row.spool_dir,
        ],
    )
    .context("upsert vms row")?;

    Ok(())
}

fn delete_vm(conn: &Connection, name: &str) -> Result<()> {
    conn.execute("DELETE FROM vms WHERE name = ?1;", params![name])
        .context("delete vms row")?;
    conn.execute(
        "DELETE FROM vm_probe_state WHERE vm_name = ?1;",
        params![name],
    )
    .context("delete vm_probe_state row")?;
    Ok(())
}

fn load_vm_probe_state(conn: &Connection, vm_name: &str) -> Result<Option<VmProbeStateRow>> {
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

fn load_all_vm_probe_states(conn: &Connection) -> Result<Vec<VmProbeStateRow>> {
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

fn upsert_vm_probe_state(conn: &Connection, row: &VmProbeStateRow) -> Result<()> {
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

fn upsert_archive_job(conn: &Connection, row: &ArchiveJobRow) -> Result<()> {
    conn.execute(
        r#"
INSERT INTO archive_jobs (
  run_id,
  vm_name,
  vm_created_at_ms,
  delete_requested_at_ms,
  deleted_at_ms,
  artifacts_dir,
  next_attempt_at_ms,
  retry_count,
  last_error,
  created_at_ms,
  updated_at_ms
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
ON CONFLICT(run_id, vm_name) DO UPDATE SET
  vm_created_at_ms = excluded.vm_created_at_ms,
  delete_requested_at_ms = excluded.delete_requested_at_ms,
  deleted_at_ms = excluded.deleted_at_ms,
  artifacts_dir = excluded.artifacts_dir,
  next_attempt_at_ms = excluded.next_attempt_at_ms,
  retry_count = excluded.retry_count,
  last_error = excluded.last_error,
  created_at_ms = excluded.created_at_ms,
  updated_at_ms = excluded.updated_at_ms;
"#,
        params![
            row.run_id,
            row.vm_name,
            row.vm_created_at_ms,
            row.delete_requested_at_ms,
            row.deleted_at_ms,
            row.artifacts_dir,
            row.next_attempt_at_ms,
            row.retry_count,
            row.last_error,
            row.created_at_ms,
            row.updated_at_ms,
        ],
    )
    .context("upsert archive job")?;
    Ok(())
}

fn load_due_archive_jobs(
    conn: &Connection,
    now_ms: i64,
    limit: usize,
) -> Result<Vec<ArchiveJobRow>> {
    let mut stmt = conn
        .prepare(
            r#"
SELECT
  run_id,
  vm_name,
  vm_created_at_ms,
  delete_requested_at_ms,
  deleted_at_ms,
  artifacts_dir,
  next_attempt_at_ms,
  retry_count,
  last_error,
  created_at_ms,
  updated_at_ms
FROM archive_jobs
WHERE next_attempt_at_ms <= ?1
ORDER BY next_attempt_at_ms ASC, updated_at_ms ASC, vm_name ASC
LIMIT ?2;
"#,
        )
        .context("prepare load due archive jobs query")?;
    stmt.query_map(params![now_ms, limit as i64], |row| {
        Ok(ArchiveJobRow {
            run_id: row.get(0)?,
            vm_name: row.get(1)?,
            vm_created_at_ms: row.get(2)?,
            delete_requested_at_ms: row.get(3)?,
            deleted_at_ms: row.get(4)?,
            artifacts_dir: row.get(5)?,
            next_attempt_at_ms: row.get(6)?,
            retry_count: row.get(7)?,
            last_error: row.get(8)?,
            created_at_ms: row.get(9)?,
            updated_at_ms: row.get(10)?,
        })
    })
    .context("query due archive jobs")?
    .collect::<rusqlite::Result<Vec<ArchiveJobRow>>>()
    .context("collect due archive jobs rows")
}

fn delete_archive_job(conn: &Connection, run_id: &str, vm_name: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM archive_jobs WHERE run_id = ?1 AND vm_name = ?2;",
        params![run_id, vm_name],
    )
    .context("delete archive job")?;
    Ok(())
}

fn update_archive_job_retry(
    conn: &Connection,
    run_id: &str,
    vm_name: &str,
    next_attempt_at_ms: i64,
    retry_count: i64,
    last_error: Option<&str>,
    updated_at_ms: i64,
) -> Result<()> {
    conn.execute(
        r#"
UPDATE archive_jobs
SET next_attempt_at_ms = ?3,
    retry_count = ?4,
    last_error = ?5,
    updated_at_ms = ?6
WHERE run_id = ?1
  AND vm_name = ?2;
"#,
        params![
            run_id,
            vm_name,
            next_attempt_at_ms,
            retry_count,
            last_error,
            updated_at_ms,
        ],
    )
    .context("update archive job retry")?;
    Ok(())
}

fn load_desired_state(conn: &Connection) -> Result<Option<DesiredStateRow>> {
    conn.query_row(
        r#"
SELECT host_id, version, doc_json, updated_at_ms
FROM desired_state
WHERE id = 1;
"#,
        [],
        |row| {
            Ok(DesiredStateRow {
                host_id: row.get(0)?,
                version: row.get(1)?,
                doc_json: row.get(2)?,
                updated_at_ms: row.get(3)?,
            })
        },
    )
    .optional()
    .context("load desired_state row")
}

fn upsert_desired_state(conn: &Connection, row: &DesiredStateRow) -> Result<()> {
    conn.execute(
        r#"
INSERT INTO desired_state (
  id,
  host_id,
  version,
  doc_json,
  updated_at_ms
) VALUES (
  1, ?1, ?2, ?3, ?4
)
ON CONFLICT(id) DO UPDATE SET
  host_id = excluded.host_id,
  version = excluded.version,
  doc_json = excluded.doc_json,
  updated_at_ms = excluded.updated_at_ms;
"#,
        params![row.host_id, row.version, row.doc_json, row.updated_at_ms],
    )
    .context("upsert desired_state row")?;
    Ok(())
}

const BASELINE_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS vms (
  name TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  created_at_s INTEGER NOT NULL,
  updated_at_s INTEGER NOT NULL,
  running_at_s INTEGER,
  error TEXT,
  root_disk_path TEXT,
  seed_disk_path TEXT,
  mac TEXT,
  lease_duration_seconds INTEGER,
  guest_ip TEXT,
  guest_ip_cidr TEXT,
  gateway TEXT,
  bridge_name TEXT,
  ssh_public_port INTEGER,
  tap_name TEXT,
  ch_socket_path TEXT,
  ch_pid INTEGER,
  kino_vsock_cid INTEGER,
  kino_vsock_port INTEGER,
  kino_vsock_path TEXT,
  ssh_host_keys_openssh_json TEXT,
  run_id TEXT,
  recording_disk_path TEXT,
  spool_dir TEXT
);

CREATE INDEX IF NOT EXISTS idx_vms_lease
  ON vms(lease_duration_seconds, running_at_s, state);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vms_guest_ip ON vms(guest_ip);

CREATE TABLE IF NOT EXISTS vm_probe_state (
  vm_name TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  collection_state TEXT NOT NULL,
  collection_error TEXT,
  summary_json TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  generated_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vm_probe_state_run_id
  ON vm_probe_state(run_id, updated_at_ms);

CREATE TABLE IF NOT EXISTS archive_jobs (
  run_id TEXT NOT NULL,
  vm_name TEXT NOT NULL,
  vm_created_at_ms INTEGER NOT NULL,
  delete_requested_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER NOT NULL,
  artifacts_dir TEXT NOT NULL,
  next_attempt_at_ms INTEGER NOT NULL,
  retry_count INTEGER NOT NULL,
  last_error TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (run_id, vm_name)
);

CREATE INDEX IF NOT EXISTS idx_archive_jobs_due
  ON archive_jobs(next_attempt_at_ms, updated_at_ms);

CREATE TABLE IF NOT EXISTS desired_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  host_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  doc_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

"#;

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn test_db_path() -> PathBuf {
        let temp = tempdir().expect("temp dir");
        let path = temp.path().join("intar-agent-test.sqlite3");
        std::mem::forget(temp);
        path
    }

    #[test]
    fn upsert_vm_persists_row_with_ssh_public_port() {
        let path = test_db_path();
        let conn = open_prepared_connection(&path).expect("open db");
        let row = VmRow {
            name: "vm-1".to_string(),
            state: "running".to_string(),
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
            kino_vsock_cid: Some(42),
            kino_vsock_port: Some(12345),
            kino_vsock_path: Some("/tmp/kino.vsock".to_string()),
            ssh_host_keys_openssh_json: Some(r#"["ssh-ed25519 AAAAHOST host"]"#.to_string()),
            run_id: Some("run-1".to_string()),
            recording_disk_path: Some("/tmp/recording.raw".to_string()),
            spool_dir: Some("/tmp/spool".to_string()),
        };

        upsert_vm(&conn, &row).expect("upsert vm");

        let rows = load_all_vms(&conn).expect("load vms");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "vm-1");
        assert_eq!(rows[0].ssh_public_port, Some(22001));
        assert_eq!(rows[0].guest_ip_cidr.as_deref(), Some("10.200.0.2/28"));
        assert_eq!(rows[0].gateway.as_deref(), Some("10.200.0.1"));
        assert_eq!(rows[0].bridge_name.as_deref(), Some("intar-runa"));
        assert_eq!(
            rows[0].ssh_host_keys_openssh_json.as_deref(),
            Some(r#"["ssh-ed25519 AAAAHOST host"]"#)
        );
        assert_eq!(rows[0].spool_dir.as_deref(), Some("/tmp/spool"));
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
}
