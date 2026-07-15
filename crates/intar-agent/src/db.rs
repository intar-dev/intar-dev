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
    pub image_key: Option<String>,
    pub image_sha256: Option<String>,
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
    pub ch_start_time_ticks: Option<i64>,
    pub host_boot_id: Option<String>,
    pub jail_generation: Option<String>,
    pub jail_unit_name: Option<String>,
    pub jail_cgroup_path: Option<String>,
    pub jail_root_path: Option<String>,
    pub jail_root_inode: Option<i64>,
    pub jail_uid: Option<i64>,
    pub jail_gid: Option<i64>,
    pub jail_netns_name: Option<String>,
    pub kino_vsock_cid: Option<i64>,
    pub kino_vsock_port: Option<i64>,
    pub kino_vsock_path: Option<String>,
    pub ssh_host_keys_openssh_json: Option<String>,
    pub run_id: Option<String>,
    pub recording_disk_path: Option<String>,
    pub spool_dir: Option<String>,
    pub cpu_millis: Option<i64>,
    pub vcpu_count: Option<i64>,
    pub ch_executable_sha256: Option<String>,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageCacheAccessRow {
    pub image_key: String,
    pub image_sha256: String,
    pub kernel_sha256: String,
    pub initrd_sha256: String,
    pub raw_bytes: i64,
    pub last_accessed_at_ms: i64,
}

#[derive(Clone, Debug)]
pub struct Db {
    tx: mpsc::Sender<Op>,
}

enum Op {
    UpsertVm {
        row: Box<VmRow>,
        resp: oneshot::Sender<Result<()>>,
    },
    DeleteVm {
        name: String,
        resp: oneshot::Sender<Result<()>>,
    },
    LoadVmProbeState {
        vm_name: String,
        resp: oneshot::Sender<Result<Option<VmProbeStateRow>>>,
    },
    LoadAllVmProbeStates {
        resp: oneshot::Sender<Result<Vec<VmProbeStateRow>>>,
    },
    UpsertReadyVmAndProbeState {
        vm: Box<VmRow>,
        probe: Box<VmProbeStateRow>,
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
    TouchImageCacheEntry {
        row: Box<ImageCacheAccessRow>,
        resp: oneshot::Sender<Result<()>>,
    },
    LoadImageCacheAccess {
        resp: oneshot::Sender<Result<Vec<ImageCacheAccessRow>>>,
    },
    LoadLocalVmImageShas {
        resp: oneshot::Sender<Result<Vec<String>>>,
    },
    DeleteImageCacheAccess {
        image_sha256: String,
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
        let (resp_tx, resp_rx) = oneshot::channel();
        self.tx
            .send(Op::UpsertVm {
                row: Box::new(row),
                resp: resp_tx,
            })
            .await
            .context("db channel closed")?;
        resp_rx
            .await
            .context("db thread dropped vm upsert response")?
    }

    pub async fn delete_vm(&self, name: String) -> Result<()> {
        let (resp_tx, resp_rx) = oneshot::channel();
        self.tx
            .send(Op::DeleteVm {
                name,
                resp: resp_tx,
            })
            .await
            .context("db channel closed")?;
        resp_rx
            .await
            .context("db thread dropped vm delete response")?
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

    /// Commit the externally visible ready boundary in one SQLite
    /// transaction. Callers must not publish terminal readiness unless this
    /// operation succeeds: a running VM row without its authenticated Kino
    /// snapshot (or vice versa) is not a durable ready state.
    pub async fn upsert_ready_vm_and_probe_state(
        &self,
        vm: VmRow,
        probe: VmProbeStateRow,
    ) -> Result<()> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<()>>();
        self.tx
            .send(Op::UpsertReadyVmAndProbeState {
                vm: Box::new(vm),
                probe: Box::new(probe),
                resp: resp_tx,
            })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped ready VM transaction response")?
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

    pub async fn touch_image_cache_entry(&self, row: ImageCacheAccessRow) -> Result<()> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<()>>();
        self.tx
            .send(Op::TouchImageCacheEntry {
                row: Box::new(row),
                resp: resp_tx,
            })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped image cache touch response")?
    }

    pub async fn load_image_cache_access(&self) -> Result<Vec<ImageCacheAccessRow>> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<Vec<ImageCacheAccessRow>>>();
        self.tx
            .send(Op::LoadImageCacheAccess { resp: resp_tx })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped image cache access response")?
    }

    pub async fn load_local_vm_image_shas(&self) -> Result<Vec<String>> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<Vec<String>>>();
        self.tx
            .send(Op::LoadLocalVmImageShas { resp: resp_tx })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped local vm image sha load response")?
    }

    pub async fn delete_image_cache_access(&self, image_sha256: String) -> Result<()> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<()>>();
        self.tx
            .send(Op::DeleteImageCacheAccess {
                image_sha256,
                resp: resp_tx,
            })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped image cache delete response")?
    }
}

fn db_thread_main(
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

fn upsert_vm(conn: &Connection, row: &VmRow) -> Result<()> {
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

fn upsert_ready_vm_and_probe_state(
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

fn touch_image_cache_entry(conn: &Connection, row: &ImageCacheAccessRow) -> Result<()> {
    conn.execute(
        r#"
INSERT INTO image_cache_access (
  image_sha256,
  image_key,
  kernel_sha256,
  initrd_sha256,
  raw_bytes,
  last_accessed_at_ms
) VALUES (
  ?1, ?2, ?3, ?4, ?5, ?6
)
ON CONFLICT(image_sha256) DO UPDATE SET
  image_key = excluded.image_key,
  kernel_sha256 = excluded.kernel_sha256,
  initrd_sha256 = excluded.initrd_sha256,
  raw_bytes = excluded.raw_bytes,
  last_accessed_at_ms = excluded.last_accessed_at_ms;
"#,
        params![
            row.image_sha256,
            row.image_key,
            row.kernel_sha256,
            row.initrd_sha256,
            row.raw_bytes,
            row.last_accessed_at_ms,
        ],
    )
    .context("touch image cache entry")?;
    Ok(())
}

fn load_image_cache_access(conn: &Connection) -> Result<Vec<ImageCacheAccessRow>> {
    let mut stmt = conn
        .prepare(
            r#"
SELECT image_key, image_sha256, kernel_sha256, initrd_sha256, raw_bytes, last_accessed_at_ms
FROM image_cache_access
ORDER BY last_accessed_at_ms ASC, image_sha256 ASC;
"#,
        )
        .context("prepare load_image_cache_access")?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ImageCacheAccessRow {
                image_key: row.get(0)?,
                image_sha256: row.get(1)?,
                kernel_sha256: row.get(2)?,
                initrd_sha256: row.get(3)?,
                raw_bytes: row.get(4)?,
                last_accessed_at_ms: row.get(5)?,
            })
        })
        .context("query image_cache_access")?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .context("collect image_cache_access")
}

fn load_local_vm_image_shas(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn
        .prepare(
            r#"
SELECT DISTINCT image_sha256
FROM vms
WHERE image_sha256 IS NOT NULL
  AND image_sha256 <> ''
ORDER BY image_sha256 ASC;
"#,
        )
        .context("prepare load local vm image sha query")?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .context("query local vm image shas")?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .context("collect local vm image shas")
}

fn delete_image_cache_access(conn: &Connection, image_sha256: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM image_cache_access WHERE image_sha256 = ?1;",
        params![image_sha256],
    )
    .context("delete image cache access")?;
    Ok(())
}

const BASELINE_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS vms (
  name TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  image_key TEXT,
  image_sha256 TEXT,
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
  ch_start_time_ticks INTEGER,
  host_boot_id TEXT,
  jail_generation TEXT,
  jail_unit_name TEXT,
  jail_cgroup_path TEXT,
  jail_root_path TEXT,
  jail_root_inode INTEGER,
  jail_uid INTEGER,
  jail_gid INTEGER,
  jail_netns_name TEXT,
  kino_vsock_cid INTEGER,
  kino_vsock_port INTEGER,
  kino_vsock_path TEXT,
  ssh_host_keys_openssh_json TEXT,
  run_id TEXT,
  recording_disk_path TEXT,
  spool_dir TEXT,
  cpu_millis INTEGER,
  vcpu_count INTEGER,
  ch_executable_sha256 TEXT
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

CREATE TABLE IF NOT EXISTS image_cache_access (
  image_sha256 TEXT PRIMARY KEY,
  image_key TEXT NOT NULL,
  kernel_sha256 TEXT NOT NULL,
  initrd_sha256 TEXT NOT NULL,
  raw_bytes INTEGER NOT NULL,
  last_accessed_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_image_cache_access_lru
  ON image_cache_access(last_accessed_at_ms);

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
}
