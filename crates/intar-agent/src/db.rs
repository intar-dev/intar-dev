#![forbid(unsafe_code)]

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context as _, Result};
use rusqlite::{Connection, OptionalExtension, params};
use tokio::sync::{mpsc, oneshot};
use tracing::{error, info, warn};

#[derive(Debug, Clone)]
pub struct VmRow {
    pub owner_user_id: String,
    pub runtime_execution_id: String,
    pub generation: i64,
    pub name: String,
    pub state: String,
    /// The image manifest digest (`sha256:<hex>`).
    pub image: Option<String>,
    /// The Kino artifact digest (`sha256:<hex>`).
    pub kino: Option<String>,
    /// SHA-256 (hex) of the exact `boot.json` bytes on the run disk; a
    /// guest report for any other digest is stale.
    pub boot_sha256: Option<String>,
    /// The machine's name in its scenario (`DesiredVmV3.name`): the guest's
    /// hostname. The row's `name` is the agent's key, `DesiredVmV3.vm_id`.
    pub machine_name: Option<String>,
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
    pub kino_vsock_path: Option<String>,
    pub ssh_host_keys_openssh_json: Option<String>,
    pub run_id: Option<String>,
    pub recording_disk_path: Option<String>,
    pub spool_dir: Option<String>,
    pub cpu_millis: Option<i64>,
    pub ch_executable_sha256: Option<String>,
}

/// The latest lab a VM's Kino reported, as strict `VmLabV1` JSON.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VmLabRow {
    pub vm_name: String,
    pub run_id: String,
    pub jail_generation: String,
    pub lab_json: String,
    /// Milliseconds from the VMM start to the first report for this run.
    pub first_report_ms: Option<i64>,
    pub updated_at_ms: i64,
}

/// A VM of an older state schema that jailerd still has to destroy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingTeardownRow {
    pub vm_name: String,
    pub run_id: Option<String>,
    /// The jail generation, when the old row recorded one.
    pub jail_generation: Option<String>,
}

/// The `PRAGMA user_version` of the agent's state. Any other value resets
/// the state (see `ensure_schema`).
pub(crate) const STATE_SCHEMA_VERSION: i64 = 9;

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

/// One completed byte-level verification of immutable cached content.
///
/// The row is keyed by the content digest, so a chunk that two images share
/// has one row and one timestamp. Only a full read that covered every byte of
/// the content writes this row. A file timestamp or change time is never a
/// substitute for that read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheVerifyRow {
    pub content_sha256: String,
    pub verified_at_ms: i64,
    pub bytes_read: i64,
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
    LoadVmLab {
        vm_name: String,
        resp: oneshot::Sender<Result<Option<VmLabRow>>>,
    },
    LoadAllVmLabs {
        resp: oneshot::Sender<Result<Vec<VmLabRow>>>,
    },
    UpsertVmAndLab {
        vm: Box<VmRow>,
        lab: Box<VmLabRow>,
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
    LoadVerifiedContent {
        resp: oneshot::Sender<Result<Vec<CacheVerifyRow>>>,
    },
    UpsertVerifiedContent {
        row: Box<CacheVerifyRow>,
        resp: oneshot::Sender<Result<()>>,
    },
    LoadLocalVmDigests {
        resp: oneshot::Sender<Result<Vec<String>>>,
    },
    LoadPendingTeardowns {
        resp: oneshot::Sender<Result<Vec<PendingTeardownRow>>>,
    },
    DeletePendingTeardown {
        vm_name: String,
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

    pub async fn load_vm_lab(&self, vm_name: String) -> Result<Option<VmLabRow>> {
        let (resp, rx) = oneshot::channel();
        self.tx
            .send(Op::LoadVmLab { vm_name, resp })
            .await
            .context("db channel closed")?;
        rx.await.context("db thread dropped vm lab response")?
    }

    pub async fn load_all_vm_labs(&self) -> Result<Vec<VmLabRow>> {
        let (resp, rx) = oneshot::channel();
        self.tx
            .send(Op::LoadAllVmLabs { resp })
            .await
            .context("db channel closed")?;
        rx.await.context("db thread dropped vm labs response")?
    }

    /// Persist a VM row and its latest lab in one SQLite transaction.
    /// Callers must not publish readiness unless this succeeds.
    pub async fn upsert_vm_and_lab(&self, vm: VmRow, lab: VmLabRow) -> Result<()> {
        let (resp, rx) = oneshot::channel();
        self.tx
            .send(Op::UpsertVmAndLab {
                vm: Box::new(vm),
                lab: Box::new(lab),
                resp,
            })
            .await
            .context("db channel closed")?;
        rx.await.context("db thread dropped VM and lab response")?
    }

    /// Every image and Kino digest a persisted VM boots from.
    pub async fn load_local_vm_digests(&self) -> Result<Vec<String>> {
        let (resp, rx) = oneshot::channel();
        self.tx
            .send(Op::LoadLocalVmDigests { resp })
            .await
            .context("db channel closed")?;
        rx.await
            .context("db thread dropped local VM digests response")?
    }

    pub async fn load_pending_teardowns(&self) -> Result<Vec<PendingTeardownRow>> {
        let (resp, rx) = oneshot::channel();
        self.tx
            .send(Op::LoadPendingTeardowns { resp })
            .await
            .context("db channel closed")?;
        rx.await
            .context("db thread dropped pending teardown response")?
    }

    pub async fn delete_pending_teardown(&self, vm_name: String) -> Result<()> {
        let (resp, rx) = oneshot::channel();
        self.tx
            .send(Op::DeletePendingTeardown { vm_name, resp })
            .await
            .context("db channel closed")?;
        rx.await
            .context("db thread dropped pending teardown delete response")?
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

    pub async fn load_verified_content(&self) -> Result<Vec<CacheVerifyRow>> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<Vec<CacheVerifyRow>>>();
        self.tx
            .send(Op::LoadVerifiedContent { resp: resp_tx })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped verified content response")?
    }

    pub async fn upsert_verified_content(&self, row: CacheVerifyRow) -> Result<()> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<()>>();
        self.tx
            .send(Op::UpsertVerifiedContent {
                row: Box::new(row),
                resp: resp_tx,
            })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped verified content upsert response")?
    }
}

mod sqlite_vms;
use sqlite_vms::*;
mod sqlite_state;
use sqlite_state::*;
#[cfg(test)]
mod tests;
